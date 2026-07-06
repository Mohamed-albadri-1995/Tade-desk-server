"""AnalyticsService (plan Phase B) — pure server-side metric functions
over closed journal entries.

Every number the UI shows comes from here; formulas are written out
plainly and the /api/analytics/stats endpoint publishes them next to
the values (transparency rule).
"""

import math
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from app.models import JournalModel

MARKET_TZ = ZoneInfo("America/New_York")

SESSION_BUCKETS = [
    ("premarket", (0, 0), (9, 34)),
    ("open", (9, 35), (10, 30)),
    ("morning", (10, 31), (12, 0)),
    ("midday", (12, 1), (14, 30)),
    ("power_hour", (14, 31), (16, 0)),
    ("afterhours", (16, 1), (23, 59)),
]


def _et(dt: datetime) -> datetime:
    return dt.replace(tzinfo=ZoneInfo("UTC")).astimezone(MARKET_TZ)


def session_bucket(entry_time: datetime) -> str:
    t = _et(entry_time)
    minutes = t.hour * 60 + t.minute
    for name, (h1, m1), (h2, m2) in SESSION_BUCKETS:
        if h1 * 60 + m1 <= minutes <= h2 * 60 + m2:
            return name
    return "unknown"


def is_closed(t: JournalModel) -> bool:
    return t.exit_pnl is not None


def _mean(values: List[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _stdev(values: List[float]) -> Optional[float]:
    if len(values) < 2:
        return None
    m = _mean(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / (len(values) - 1))


def _round(value, digits=2):
    if value is None:
        return None
    if value == float("inf"):
        return None  # JSON-safe; the UI shows "∞" when pf_infinite is set
    return round(value, digits)


# ------------------------------------------------------------ equity curve

def equity_series(trades: List[JournalModel]) -> dict:
    closed = sorted(
        (t for t in trades if is_closed(t)),
        key=lambda t: t.exit_time or t.entry_signal_time,
    )
    eq = peak = max_dd = peak_at_max_dd = 0.0
    points = []
    for t in closed:
        eq += t.exit_pnl
        peak = max(peak, eq)
        dd = peak - eq
        if dd > max_dd:
            max_dd = dd
            peak_at_max_dd = peak
        ts = (t.exit_time or t.entry_signal_time).isoformat()
        points.append({"ts": ts, "equity": _round(eq), "peak": _round(peak), "drawdown": _round(dd)})
    return {
        "points": points,
        "max_drawdown": _round(max_dd),
        "max_drawdown_pct": _round(max_dd / peak_at_max_dd * 100.0) if peak_at_max_dd > 0 else None,
    }


# --------------------------------------------------------- account metrics

def account_metrics(trades: List[JournalModel]) -> dict:
    closed = [t for t in trades if is_closed(t)]
    wins = [t for t in closed if t.exit_pnl > 0]
    losses = [t for t in closed if t.exit_pnl < 0]
    net = sum(t.exit_pnl for t in closed)
    gross_win = sum(t.exit_pnl for t in wins)
    gross_loss = sum(t.exit_pnl for t in losses)

    win_rate = len(wins) / len(closed) * 100.0 if closed else None
    profit_factor = (
        gross_win / -gross_loss if gross_loss < 0 else (float("inf") if gross_win > 0 else None)
    )
    expectancy = net / len(closed) if closed else None
    avg_win = gross_win / len(wins) if wins else None
    avg_loss = gross_loss / len(losses) if losses else None
    payoff = avg_win / -avg_loss if avg_win is not None and avg_loss not in (None, 0) else None

    r_values = [t.r_multiple for t in closed if t.r_multiple is not None]
    expectancy_r = _mean(r_values)
    r_std = _stdev(r_values)
    sqn = (
        expectancy_r / r_std * math.sqrt(min(len(r_values), 100))
        if r_std and expectancy_r is not None
        else None
    )
    kelly = (
        (win_rate / 100.0 - (1 - win_rate / 100.0) / payoff) * 100.0
        if payoff not in (None, 0) and win_rate is not None
        else None
    )

    es = equity_series(closed)
    recovery = net / es["max_drawdown"] if es["max_drawdown"] else None

    daily: Dict[str, float] = defaultdict(float)
    for t in closed:
        day = (t.exit_time or t.entry_signal_time).date().isoformat()
        daily[day] += t.exit_pnl
    d_std = _stdev(list(daily.values()))
    consistency = (
        _mean(list(daily.values())) / d_std * math.sqrt(252) if d_std else None
    )

    by_time = sorted(closed, key=lambda t: t.entry_signal_time)
    ws = ls = max_ws = max_ls = 0
    for t in by_time:
        if t.exit_pnl > 0:
            ws, ls = ws + 1, 0
        elif t.exit_pnl < 0:
            ls, ws = ls + 1, 0
        max_ws, max_ls = max(max_ws, ws), max(max_ls, ls)

    hold_win = _mean([t.hold_minutes for t in wins if t.hold_minutes is not None])
    hold_loss = _mean([t.hold_minutes for t in losses if t.hold_minutes is not None])
    captures = [t.capture_pct for t in closed if t.capture_pct is not None]
    longs = [t for t in closed if t.signal_side == "long"]
    shorts = [t for t in closed if t.signal_side == "short"]

    return {
        "closed": len(closed),
        "wins": len(wins),
        "losses": len(losses),
        "net_pnl": _round(net),
        "gross_win": _round(gross_win),
        "gross_loss": _round(gross_loss),
        "win_rate": _round(win_rate, 1),
        "profit_factor": _round(profit_factor),
        "pf_infinite": profit_factor == float("inf"),
        "expectancy": _round(expectancy),
        "expectancy_r": _round(expectancy_r, 3),
        "avg_win": _round(avg_win),
        "avg_loss": _round(avg_loss),
        "payoff": _round(payoff),
        "max_drawdown": es["max_drawdown"],
        "max_drawdown_pct": es["max_drawdown_pct"],
        "sqn": _round(sqn),
        "kelly_pct": _round(kelly, 1),
        "recovery_factor": _round(recovery),
        "consistency": _round(consistency),
        "max_win_streak": max_ws,
        "max_loss_streak": max_ls,
        "avg_hold_win_min": _round(hold_win, 1),
        "avg_hold_loss_min": _round(hold_loss, 1),
        "avg_capture_pct": _round(_mean(captures), 1),
        "long_count": len(longs),
        "long_pnl": _round(sum(t.exit_pnl for t in longs)),
        "short_count": len(shorts),
        "short_pnl": _round(sum(t.exit_pnl for t in shorts)),
        "r_count": len(r_values),
    }


# The transparent formula catalog served with the values (Stats view).
METRIC_FORMULAS = {
    "net_pnl": "Σ exit_pnl over closed trades",
    "win_rate": "wins / closed × 100",
    "profit_factor": "gross winnings / |gross losses|",
    "expectancy": "net_pnl / closed trades ($ per trade)",
    "expectancy_r": "mean of per-trade R-multiples (pnl per share / planned risk per share)",
    "avg_win": "gross winnings / number of wins",
    "avg_loss": "gross losses / number of losses",
    "payoff": "avg_win / |avg_loss|",
    "max_drawdown": "max(peak equity − equity) over the equity curve",
    "max_drawdown_pct": "max_drawdown / peak at max drawdown × 100",
    "sqn": "mean(R) / stdev(R) × √min(n,100)  (Van Tharp SQN)",
    "kelly_pct": "(win% − (1−win%)/payoff) × 100",
    "recovery_factor": "net_pnl / max_drawdown",
    "consistency": "mean(daily pnl) / stdev(daily pnl) × √252",
    "max_win_streak": "longest run of consecutive winning trades",
    "max_loss_streak": "longest run of consecutive losing trades",
    "avg_hold_win_min": "mean hold minutes of winners",
    "avg_hold_loss_min": "mean hold minutes of losers",
    "avg_capture_pct": "mean of capture % (realized favorable move / max favorable move)",
}


# ---------------------------------------------------------------- calendar

def calendar(trades: List[JournalModel], month: Optional[str] = None) -> dict:
    days: Dict[str, dict] = {}
    for t in trades:
        if not is_closed(t):
            continue
        day = (t.exit_time or t.entry_signal_time).date().isoformat()
        if month and not day.startswith(month):
            continue
        bucket = days.setdefault(day, {"pnl": 0.0, "trades": 0, "wins": 0})
        bucket["pnl"] = round(bucket["pnl"] + t.exit_pnl, 2)
        bucket["trades"] += 1
        if t.exit_pnl > 0:
            bucket["wins"] += 1
    return {"days": days}


# -------------------------------------------------------------- breakdowns

BREAKDOWN_DIMS = (
    "setup", "grade", "regime", "side", "stock", "hour", "session", "weekday", "condition",
)


def _bucket_keys(t: JournalModel, dim: str) -> List[str]:
    if dim == "setup":
        return [f"setup_{t.setup_id}"]
    if dim == "grade":
        return [t.entry_grade or "ungraded"]
    if dim == "regime":
        snap = t.entry_gate_screener_snapshot or {}
        return [str(snap.get("regime") or "unknown")]
    if dim == "side":
        return [t.signal_side]
    if dim == "stock":
        return [t.stock]
    if dim == "hour":
        return [f"{_et(t.entry_signal_time).hour:02d}:00 ET"]
    if dim == "session":
        return [session_bucket(t.entry_signal_time)]
    if dim == "weekday":
        return [_et(t.entry_signal_time).strftime("%A")]
    if dim == "condition":
        keys = []
        for name, aligned in {**(t.entry_default_results or {}), **(t.entry_additional_results or {})}.items():
            keys.append(f"{name} ✓" if aligned else f"{name} ✗")
        return keys or ["no_conditions"]
    raise ValueError(f"unknown breakdown dim: {dim}")


def breakdown(trades: List[JournalModel], dim: str) -> List[dict]:
    closed = [t for t in trades if is_closed(t)]
    buckets: Dict[str, List[JournalModel]] = defaultdict(list)
    for t in closed:
        for key in _bucket_keys(t, dim):
            buckets[key].append(t)
    rows = []
    for key, bucket_trades in buckets.items():
        metrics = account_metrics(bucket_trades)
        es = equity_series(bucket_trades)
        rows.append(
            {
                "bucket": key,
                "metrics": metrics,
                "equity_sparkline": [p["equity"] for p in es["points"]],
            }
        )
    rows.sort(key=lambda r: -(r["metrics"]["net_pnl"] or 0))
    return rows


# ------------------------------------------------------------------- time

def time_view(trades: List[JournalModel]) -> dict:
    closed = [t for t in trades if is_closed(t)]
    holds = [t.hold_minutes for t in closed if t.hold_minutes is not None]
    hold_buckets: Dict[str, List[JournalModel]] = defaultdict(list)
    for t in closed:
        if t.hold_minutes is None:
            continue
        if t.hold_minutes <= 5:
            key = "≤5m"
        elif t.hold_minutes <= 15:
            key = "5–15m"
        elif t.hold_minutes <= 60:
            key = "15–60m"
        elif t.hold_minutes <= 240:
            key = "1–4h"
        else:
            key = ">4h"
        hold_buckets[key].append(t)
    return {
        "by_hour": breakdown(closed, "hour"),
        "by_session": breakdown(closed, "session"),
        "by_weekday": breakdown(closed, "weekday"),
        "hold_buckets": [
            {"bucket": k, "metrics": account_metrics(v)} for k, v in hold_buckets.items()
        ],
        "avg_hold_min": _round(_mean(holds), 1),
    }


# ------------------------------------------------------------------- risk

def risk_view(trades: List[JournalModel]) -> dict:
    closed = [t for t in trades if is_closed(t)]
    r_values = [t.r_multiple for t in closed if t.r_multiple is not None]
    histogram: Dict[str, int] = defaultdict(int)
    for r in r_values:
        if r <= -2:
            key = "≤-2R"
        elif r <= -1:
            key = "-2..-1R"
        elif r < 0:
            key = "-1..0R"
        elif r < 1:
            key = "0..1R"
        elif r < 2:
            key = "1..2R"
        elif r < 3:
            key = "2..3R"
        else:
            key = "≥3R"
        histogram[key] += 1
    order = ["≤-2R", "-2..-1R", "-1..0R", "0..1R", "1..2R", "2..3R", "≥3R"]
    # Planned-risk adherence: realized loss vs planned 1R for losing trades.
    overruns = [
        t.r_multiple for t in closed if t.r_multiple is not None and t.r_multiple < -1.05
    ]
    return {
        "metrics": account_metrics(closed),
        "equity": equity_series(closed),
        "r_histogram": [{"bucket": b, "count": histogram.get(b, 0)} for b in order],
        "stop_overruns": {
            "count": len(overruns),
            "worst_r": _round(min(overruns), 2) if overruns else None,
            "definition": "closed trades with realized R < -1.05 (lost more than planned risk)",
        },
    }


# -------------------------------------------------------------- magnitude

def magnitude_view(trades: List[JournalModel]) -> dict:
    closed = [t for t in trades if is_closed(t)]
    buckets: Dict[str, List[JournalModel]] = defaultdict(list)
    for t in closed:
        r = t.r_multiple
        if r is None:
            buckets["no_R"].append(t)
        elif t.exit_pnl > 0:
            buckets["big_win (≥2R)" if r >= 2 else "small_win (<2R)"].append(t)
        elif t.exit_pnl < 0:
            buckets["big_loss (≤-1.5R)" if r <= -1.5 else "small_loss (>-1.5R)"].append(t)
        else:
            buckets["breakeven"].append(t)
    scatter = [
        {
            "id": t.id,
            "stock": t.stock,
            "mae_pct": t.mae_pct,
            "mfe_pct": t.mfe_pct,
            "r_multiple": t.r_multiple,
            "pnl": t.exit_pnl,
        }
        for t in closed
        if t.mae_pct is not None and t.mfe_pct is not None
    ]
    captures = [t.capture_pct for t in closed if t.capture_pct is not None]
    capture_hist: Dict[str, int] = defaultdict(int)
    for c in captures:
        capture_hist[f"{int(c // 20) * 20}–{int(c // 20) * 20 + 20}%"] += 1
    return {
        "buckets": [
            {"bucket": k, "count": len(v), "net_pnl": _round(sum(t.exit_pnl for t in v))}
            for k, v in sorted(buckets.items())
        ],
        "mae_mfe_scatter": scatter,
        "capture_histogram": [
            {"bucket": k, "count": v} for k, v in sorted(capture_hist.items())
        ],
    }
