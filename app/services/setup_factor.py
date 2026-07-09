"""SetupFactorEngine — the health cap (Trade Desk Rebuild plan §3.6).

Independent of the contextual learning model: per (setup_id, side),
aggregate statistics are normalised and combined into a health score
that caps sizing (0.0–1.0 — it never boosts):

    WR_norm = min(1, win_rate / 0.60)          (60% win rate = "great")
    PF_norm = min(1, profit_factor / 2.0)      (PF 2.0 = "great")
    DD_norm = 1 − min(1, max_drawdown_R / 10)  (10R drawdown = "terrible")
    health  = 0.30·WR_norm + 0.40·PF_norm + 0.30·DD_norm
    factor  = clamp(health × 1.2, 0.0, 1.0)

With fewer than ``min_trades`` closed trades the factor is neutral 1.0.
States are recomputed on exits and by the nightly learning run, never at
signal time (the pipeline reads the cached state)."""

import logging
from typing import Dict, List, Optional

from sqlalchemy import select

from app.database import async_session_factory
from app.models import JournalModel, SetupFactorStateModel

logger = logging.getLogger(__name__)

# "Great" reference points and weights from the plan.
WR_GREAT = 0.60
PF_GREAT = 2.0
DD_TERRIBLE_R = 10.0
WEIGHTS = {"win_rate": 0.30, "profit_factor": 0.40, "drawdown": 0.30}
SCORE_TO_FACTOR = 1.2

NEUTRAL_STATE = {
    "final_factor": 1.0,
    "insufficient_data": True,
    "score": None,
    "inputs": {},
    "components": {},
}


def _max_drawdown_r(trades: List[JournalModel]) -> float:
    rs = sorted(
        ((t.exit_time or t.entry_signal_time, t.r_multiple) for t in trades
         if t.r_multiple is not None),
        key=lambda x: x[0],
    )
    eq = peak = max_dd = 0.0
    for _, r in rs:
        eq += r
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)
    return round(max_dd, 3)


class SetupFactorEngine:
    def __init__(self):
        self.min_trades = 30
        self._states: Dict[tuple, dict] = {}  # (setup_id, side) -> state

    async def load_states(self) -> None:
        async with async_session_factory() as session:
            rows = (await session.execute(select(SetupFactorStateModel))).scalars().all()
        self._states = {
            (r.setup_id, r.side or "pooled"): {
                "side": r.side or "pooled",
                "final_factor": r.final_factor,
                "insufficient_data": r.insufficient_data,
                "score": r.score,
                "inputs": r.inputs or {},
                "components": r.signal_points or {},
            }
            for r in rows
        }

    # ------------------------------------------------------------- scoring

    def compute_state(self, trades: List[JournalModel]) -> dict:
        closed = [t for t in trades if t.exit_pnl is not None]
        n = len(closed)
        if n < self.min_trades:
            state = dict(NEUTRAL_STATE)
            state["inputs"] = {"n": n, "min_trades": self.min_trades}
            return state

        wins = [t for t in closed if t.exit_pnl > 0]
        losses = [t for t in closed if t.exit_pnl < 0]
        win_rate = len(wins) / n
        gross_win = sum(t.exit_pnl for t in wins)
        gross_loss = -sum(t.exit_pnl for t in losses)
        profit_factor = gross_win / gross_loss if gross_loss > 0 else (PF_GREAT if gross_win > 0 else 0.0)
        max_dd_r = _max_drawdown_r(closed)

        wr_norm = min(1.0, win_rate / WR_GREAT)
        pf_norm = min(1.0, profit_factor / PF_GREAT)
        dd_norm = 1.0 - min(1.0, max_dd_r / DD_TERRIBLE_R)
        health = (
            wr_norm * WEIGHTS["win_rate"]
            + pf_norm * WEIGHTS["profit_factor"]
            + dd_norm * WEIGHTS["drawdown"]
        )
        factor = max(0.0, min(1.0, health * SCORE_TO_FACTOR))

        return {
            "final_factor": round(factor, 3),
            "insufficient_data": False,
            "score": round(health, 4),
            "inputs": {
                "n": n,
                "win_rate": round(win_rate * 100, 1),
                "profit_factor": round(profit_factor, 3),
                "max_drawdown_r": max_dd_r,
            },
            "components": {
                "wr_norm": round(wr_norm, 3),
                "pf_norm": round(pf_norm, 3),
                "dd_norm": round(dd_norm, 3),
            },
        }

    # ----------------------------------------------------------- recompute

    async def recompute_all(self, setup_id: Optional[int] = None) -> Dict[tuple, dict]:
        async with async_session_factory() as session:
            query = select(JournalModel).where(JournalModel.exit_pnl != None)  # noqa: E711
            if setup_id is not None:
                query = query.where(JournalModel.setup_id == setup_id)
            trades = (await session.execute(query)).scalars().all()

            by_setup: Dict[int, List[JournalModel]] = {}
            for t in trades:
                by_setup.setdefault(t.setup_id, []).append(t)

            for sid, setup_trades in by_setup.items():
                variants = {
                    "pooled": setup_trades,
                    "long": [t for t in setup_trades if t.signal_side == "long"],
                    "short": [t for t in setup_trades if t.signal_side == "short"],
                }
                for side, side_trades in variants.items():
                    state = self.compute_state(side_trades)
                    state["side"] = side
                    self._states[(sid, side)] = state
                    row = (
                        await session.execute(
                            select(SetupFactorStateModel).where(
                                SetupFactorStateModel.setup_id == sid,
                                SetupFactorStateModel.side == side,
                            )
                        )
                    ).scalar_one_or_none()
                    if row is None:
                        row = SetupFactorStateModel(setup_id=sid, side=side)
                        session.add(row)
                    row.inputs = state["inputs"]
                    row.signal_points = state["components"]
                    row.score = state["score"]
                    row.mapped_factor = state["final_factor"]
                    row.confidence = None
                    row.final_factor = state["final_factor"]
                    row.insufficient_data = state["insufficient_data"]
            await session.commit()
        return self._states

    # --------------------------------------------------------- signal time

    def get_state(self, setup_id: int, side: Optional[str] = None) -> dict:
        """Per-side health; neutral 1.0 until that side has min_trades."""
        if side:
            state = self._states.get((setup_id, side))
            if state:
                return {**state, "side_used": side}
        pooled = self._states.get((setup_id, "pooled"))
        if pooled:
            return {**pooled, "side_used": "pooled"}
        return {**dict(NEUTRAL_STATE), "side": side or "pooled", "side_used": "none"}

    def get_factor(self, setup_id: int, side: Optional[str] = None) -> float:
        return float(self.get_state(setup_id, side)["final_factor"])
