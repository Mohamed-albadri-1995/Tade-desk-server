"""SetupFactorEngine (plan Phase D) — a sizing factor per setup derived
from that setup's real performance.

Same principles as the grading engine: DB-stored user-editable model,
signal points with asymmetric thresholds, score = Σ points normalized
0–100, then a score→factor mapping table. Two safety rules:

* confidence shrinkage pulls the factor toward neutral 1.0 while the
  sample is small (below ``hard_floor_trades`` it stays exactly 1.0);
* the mapping may reach **0.0** — a setup with proven bad performance
  produces zero shares and the pipeline blocks the alert (the entry
  card is still written, status ``blocked_by_setup_factor``).

States are recomputed on exit updates and at session start, never at
signal time (the pipeline reads the cached state).
"""

import logging
import math
from typing import Dict, List, Optional

from sqlalchemy import select

from app.database import async_session_factory
from app.models import JournalModel, SetupFactorModelModel, SetupFactorStateModel
from app.services.analytics import account_metrics

logger = logging.getLogger(__name__)

DEFAULT_SIGNALS = {
    "expectancy_r": {
        "good": 0.5, "ok": 0.2, "bad": 0.0,
        "points_good": 2.0, "points_ok": 1.0, "points_bad": -2.0,
    },
    "profit_factor": {"good": 1.5, "bad": 1.0, "points_good": 1.0, "points_bad": -1.0},
    "win_rate": {"good": 55.0, "bad": 40.0, "points_good": 1.0, "points_bad": -1.0},
    "max_drawdown_r": {"good": 5.0, "bad": 10.0, "points_good": 1.0, "points_bad": -2.0},
    "recent_form": {"points_good": 1.0},
}
# Score -> factor, checked from highest threshold down. Reaches 0.0.
DEFAULT_FACTOR_MAP = {"80": 1.5, "60": 1.25, "40": 1.0, "20": 0.5, "0": 0.0}

NEUTRAL_STATE = {
    "final_factor": 1.0,
    "insufficient_data": True,
    "score": None,
    "mapped_factor": None,
    "confidence": 0.0,
    "inputs": {},
    "signal_points": {},
}


def _max_drawdown_r(trades: List[JournalModel]) -> Optional[float]:
    rs = [
        (t.exit_time or t.entry_signal_time, t.r_multiple)
        for t in trades
        if t.r_multiple is not None
    ]
    if not rs:
        return None
    rs.sort(key=lambda x: x[0])
    eq = peak = max_dd = 0.0
    for _, r in rs:
        eq += r
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)
    return round(max_dd, 2)


class SetupFactorEngine:
    def __init__(self):
        self.model: dict = self._default_model()
        self._states: Dict[tuple, dict] = {}  # (setup_id, side) -> state; side: pooled|long|short

    @staticmethod
    def _default_model() -> dict:
        return {
            "signals": dict(DEFAULT_SIGNALS),
            "factor_map": dict(DEFAULT_FACTOR_MAP),
            "split_by_side": True,
            "factor_min": 0.0,
            "factor_max": 1.5,
            "min_trades": 20,
            "hard_floor_trades": 5,
            "recent_window": 10,
        }

    # ----------------------------------------------------------- model I/O

    async def refresh_model(self) -> None:
        async with async_session_factory() as session:
            row = (
                await session.execute(
                    select(SetupFactorModelModel).where(SetupFactorModelModel.id == 1)
                )
            ).scalar_one_or_none()
        if row is not None:
            self.model = {
                "signals": row.signals or dict(DEFAULT_SIGNALS),
                "factor_map": row.factor_map or dict(DEFAULT_FACTOR_MAP),
                "split_by_side": bool(row.split_by_side),
                "factor_min": row.factor_min,
                "factor_max": row.factor_max,
                "min_trades": row.min_trades,
                "hard_floor_trades": row.hard_floor_trades,
                "recent_window": row.recent_window,
            }

    async def load_states(self) -> None:
        async with async_session_factory() as session:
            rows = (await session.execute(select(SetupFactorStateModel))).scalars().all()
        self._states = {
            (r.setup_id, r.side or "pooled"): {
                "side": r.side or "pooled",
                "final_factor": r.final_factor,
                "insufficient_data": r.insufficient_data,
                "score": r.score,
                "mapped_factor": r.mapped_factor,
                "confidence": r.confidence,
                "inputs": r.inputs or {},
                "signal_points": r.signal_points or {},
            }
            for r in rows
        }

    # ------------------------------------------------------------- scoring

    def _signal_points(self, inputs: dict) -> Dict[str, float]:
        cfg = self.model["signals"]
        points: Dict[str, float] = {}

        s = cfg.get("expectancy_r", DEFAULT_SIGNALS["expectancy_r"])
        er = inputs.get("expectancy_r")
        if er is not None:
            if er >= s["good"]:
                points["expectancy_r"] = s["points_good"]
            elif er >= s["ok"]:
                points["expectancy_r"] = s["points_ok"]
            elif er < s["bad"]:
                points["expectancy_r"] = s["points_bad"]
            else:
                points["expectancy_r"] = 0.0

        s = cfg.get("profit_factor", DEFAULT_SIGNALS["profit_factor"])
        pf = inputs.get("profit_factor")
        if pf is not None or inputs.get("pf_infinite"):
            value = math.inf if inputs.get("pf_infinite") else pf
            points["profit_factor"] = (
                s["points_good"] if value >= s["good"] else s["points_bad"] if value < s["bad"] else 0.0
            )

        s = cfg.get("win_rate", DEFAULT_SIGNALS["win_rate"])
        wr = inputs.get("win_rate")
        if wr is not None:
            points["win_rate"] = (
                s["points_good"] if wr >= s["good"] else s["points_bad"] if wr < s["bad"] else 0.0
            )

        s = cfg.get("max_drawdown_r", DEFAULT_SIGNALS["max_drawdown_r"])
        dd = inputs.get("max_drawdown_r")
        if dd is not None:
            points["max_drawdown_r"] = (
                s["points_good"] if dd <= s["good"] else s["points_bad"] if dd > s["bad"] else 0.0
            )

        s = cfg.get("recent_form", DEFAULT_SIGNALS["recent_form"])
        recent = inputs.get("recent_expectancy_r")
        overall = inputs.get("expectancy_r")
        if recent is not None and overall is not None:
            points["recent_form"] = s["points_good"] if recent >= overall else 0.0

        return points

    def _score_range(self) -> tuple:
        cfg = self.model["signals"]
        best = worst = 0.0
        for name, s in cfg.items():
            candidates = [v for k, v in s.items() if k.startswith("points_")]
            if not candidates:
                continue
            best += max(max(candidates), 0.0)
            worst += min(min(candidates), 0.0)
        return best, worst

    def compute_state(self, trades: List[JournalModel]) -> dict:
        closed = [t for t in trades if t.exit_pnl is not None]
        n = len(closed)
        hard_floor = int(self.model["hard_floor_trades"])
        if n < hard_floor:
            state = dict(NEUTRAL_STATE)
            state["inputs"] = {"n": n, "hard_floor_trades": hard_floor}
            return state

        metrics = account_metrics(closed)
        window = int(self.model["recent_window"])
        recent = sorted(closed, key=lambda t: t.exit_time or t.entry_signal_time)[-window:]
        recent_rs = [t.r_multiple for t in recent if t.r_multiple is not None]
        inputs = {
            "n": n,
            "expectancy_r": metrics["expectancy_r"],
            "profit_factor": metrics["profit_factor"],
            "pf_infinite": metrics["pf_infinite"],
            "win_rate": metrics["win_rate"],
            "max_drawdown_r": _max_drawdown_r(closed),
            "recent_expectancy_r": round(sum(recent_rs) / len(recent_rs), 3) if recent_rs else None,
            "recent_window": window,
        }

        signal_points = self._signal_points(inputs)
        raw = sum(signal_points.values())
        best, worst = self._score_range()
        score = ((raw - worst) / (best - worst) * 100.0) if best > worst else 50.0

        mapped = 1.0
        for threshold in sorted(self.model["factor_map"], key=float, reverse=True):
            if score >= float(threshold):
                mapped = float(self.model["factor_map"][threshold])
                break

        confidence = min(1.0, n / float(self.model["min_trades"]))
        final = 1.0 + (mapped - 1.0) * confidence
        final = max(self.model["factor_min"], min(self.model["factor_max"], final))

        return {
            "final_factor": round(final, 3),
            "insufficient_data": False,
            "score": round(score, 2),
            "mapped_factor": mapped,
            "confidence": round(confidence, 3),
            "inputs": inputs,
            "signal_points": signal_points,
        }

    # ----------------------------------------------------------- recompute

    async def recompute_all(self, setup_id: Optional[int] = None) -> Dict[tuple, dict]:
        """Recompute factor states — all setups, or just one when a single
        close only invalidates that setup's stats."""
        await self.refresh_model()
        async with async_session_factory() as session:
            query = select(JournalModel).where(JournalModel.exit_pnl != None)  # noqa: E711
            if setup_id is not None:
                query = query.where(JournalModel.setup_id == setup_id)
            trades = (await session.execute(query)).scalars().all()
            by_setup: Dict[int, List[JournalModel]] = {}
            for t in trades:
                by_setup.setdefault(t.setup_id, []).append(t)

            for setup_id, setup_trades in by_setup.items():
                variants = {"pooled": setup_trades}
                if self.model.get("split_by_side"):
                    variants["long"] = [t for t in setup_trades if t.signal_side == "long"]
                    variants["short"] = [t for t in setup_trades if t.signal_side == "short"]
                for side, side_trades in variants.items():
                    state = self.compute_state(side_trades)
                    state["side"] = side
                    self._states[(setup_id, side)] = state
                    row = (
                        await session.execute(
                            select(SetupFactorStateModel).where(
                                SetupFactorStateModel.setup_id == setup_id,
                                SetupFactorStateModel.side == side,
                            )
                        )
                    ).scalar_one_or_none()
                    if row is None:
                        row = SetupFactorStateModel(setup_id=setup_id, side=side)
                        session.add(row)
                    row.inputs = state["inputs"]
                    row.signal_points = state["signal_points"]
                    row.score = state["score"]
                    row.mapped_factor = state["mapped_factor"]
                    row.confidence = state["confidence"]
                    row.final_factor = state["final_factor"]
                    row.insufficient_data = state["insufficient_data"]
            await session.commit()
        return self._states

    # --------------------------------------------------------- signal time

    def get_state(self, setup_id: int, side: Optional[str] = None) -> dict:
        """Cached state read — zero I/O; neutral 1.0 for unseen setups.

        With side splitting on, the side-specific state is used once that
        side has enough trades; otherwise it falls back to the pooled
        state. ``side_used`` records which one applied (transparency)."""
        if side and self.model.get("split_by_side"):
            side_state = self._states.get((setup_id, side))
            if side_state and not side_state["insufficient_data"]:
                return {**side_state, "side_used": side}
        pooled = self._states.get((setup_id, "pooled"))
        if pooled:
            return {**pooled, "side_used": "pooled"}
        return {**dict(NEUTRAL_STATE), "side": "pooled", "side_used": "pooled"}

    def get_factor(self, setup_id: int, side: Optional[str] = None) -> float:
        return float(self.get_state(setup_id, side)["final_factor"])
