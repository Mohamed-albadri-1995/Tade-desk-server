"""Exit enrichment (plan Phase A1).

Computed once when an exit is recorded and stored on the journal row:
R-multiple, planned RR, MAE/MFE (best effort from cached bars),
capture %, hold minutes and an exit verdict. All formulas are visible
here — transparency over cleverness.
"""

from datetime import datetime
from typing import List, Optional

from app.models import JournalModel

# capture_pct -> verdict; thresholds intentionally in one visible constant.
VERDICT_THRESHOLDS = [(80.0, "excellent"), (50.0, "good"), (30.0, "early"), (0.0, "poor")]


def _parse_ts(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            return None
    return None


def compute_exit_enrichment(entry: JournalModel, bars: Optional[List[dict]] = None) -> dict:
    """Return the enrichment dict for a closed entry. ``bars`` are the
    cached OHLCV bars for the stock (may be None/partial — best effort)."""
    out = {
        "r_multiple": None,
        "planned_rr": None,
        "mae_pct": None,
        "mfe_pct": None,
        "capture_pct": None,
        "hold_minutes": None,
        "exit_verdict": None,
    }
    if entry.entry_price is None or entry.exit_price is None:
        return out

    direction = 1.0 if entry.signal_side == "long" else -1.0
    entry_price = float(entry.entry_price)
    exit_price = float(entry.exit_price)
    pnl_per_share = (exit_price - entry_price) * direction

    # R-multiple and planned RR against the planned stop distance.
    if entry.entry_sl_price is not None:
        risk_per_share = (entry_price - float(entry.entry_sl_price)) * direction
        if risk_per_share > 0:
            out["r_multiple"] = round(pnl_per_share / risk_per_share, 3)
            if entry.entry_tp_price is not None:
                reward = (float(entry.entry_tp_price) - entry_price) * direction
                out["planned_rr"] = round(reward / risk_per_share, 3)

    if entry.entry_signal_time and entry.exit_time:
        out["hold_minutes"] = round(
            (entry.exit_time - entry.entry_signal_time).total_seconds() / 60.0, 1
        )

    # MAE / MFE / capture from bars between entry and exit.
    if bars and entry.entry_signal_time and entry.exit_time:
        window = []
        for b in bars:
            ts = _parse_ts(b.get("timestamp"))
            if ts is None:
                continue
            if entry.entry_signal_time <= ts <= entry.exit_time:
                window.append(b)
        if window:
            highs = [float(b["high"]) for b in window]
            lows = [float(b["low"]) for b in window]
            if direction > 0:
                favorable = max(highs) - entry_price
                adverse = entry_price - min(lows)
            else:
                favorable = entry_price - min(lows)
                adverse = max(highs) - entry_price
            if entry_price > 0:
                out["mfe_pct"] = round(max(favorable, 0.0) / entry_price * 100.0, 3)
                out["mae_pct"] = round(max(adverse, 0.0) / entry_price * 100.0, 3)
            if favorable > 0:
                out["capture_pct"] = round(
                    min(100.0, max(0.0, pnl_per_share / favorable * 100.0)), 1
                )

    if out["capture_pct"] is not None:
        for threshold, verdict in VERDICT_THRESHOLDS:
            if out["capture_pct"] >= threshold:
                out["exit_verdict"] = verdict
                break

    return out
