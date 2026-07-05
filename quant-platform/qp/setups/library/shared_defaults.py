"""
Shared default checks — applied to every qp setup.

These are context-only checks: they compute pass/fail but do NOT gate
the signal. Every fire recorded on a trade card includes their state,
so the grading engine and the journal analyzer can slice performance
by which defaults were aligned when the setup fired.

Add / edit a rule here → every setup picks it up on the next signal.

Signature:
    fn(bars, side) → bool | None
        `bars` is the tz-aware OHLCV DataFrame the setup sees.
        `side` is 'long' or 'short'.
        Return True (aligned), False (misaligned), or None (n/a).

Add rules by appending to DEFAULT_CHECKS.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.vwap import session_vwap
from qp.session import US_EQUITIES


def _in_regular_session(bars: pd.DataFrame, side: str = 'long') -> bool:
    """Last bar sits inside 09:30-16:00 ET."""
    if bars.index.tz is None or len(bars) == 0:
        return False
    local = bars.index[-1].tz_convert(US_EQUITIES.tz)
    return (local.hour, local.minute) >= (9, 30) and local.hour < 16


def _close_vs_vwap(bars: pd.DataFrame, side: str = 'long') -> bool:
    """Close above session VWAP for long, below for short."""
    if len(bars) == 0:
        return False
    vwap = np.asarray(session_vwap(bars))
    close = float(bars['close'].iloc[-1])
    v = float(vwap[-1])
    if not np.isfinite(v):
        return False
    return close > v if side == 'long' else close < v


def _not_first_five_minutes(bars: pd.DataFrame, side: str = 'long') -> bool:
    """Avoid the noisy 09:30–09:35 window."""
    if bars.index.tz is None or len(bars) == 0:
        return False
    local = bars.index[-1].tz_convert(US_EQUITIES.tz)
    if local.hour != 9: return True
    return local.minute >= 35


DEFAULT_CHECKS = [
    {'name': 'Inside regular session',   'fn': _in_regular_session,
     'note': '09:30–16:00 ET only'},
    {'name': 'Close on aligned side of VWAP', 'fn': _close_vs_vwap,
     'note': 'close > VWAP for long, < for short'},
    {'name': 'Past first 5 minutes',     'fn': _not_first_five_minutes,
     'note': 'avoid the 09:30–09:35 auction noise'},
]


def evaluate_defaults(bars: pd.DataFrame, side: str = 'long') -> list[dict]:
    """Run every default check and return [{name, pass, note}, …]."""
    out = []
    for c in DEFAULT_CHECKS:
        try:
            passed = c['fn'](bars, side)
        except Exception:
            passed = None
        out.append({
            'name': c['name'],
            'pass': None if passed is None else bool(passed),
            'note': c.get('note', ''),
        })
    return out
