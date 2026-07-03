"""
Rolling N-session HH/LL — the highest high / lowest low over the last
N complete sessions of bars.

Window size adapts to the timeframe automatically because it's
session-anchored (not fixed-bar-count):
    - 5m data, n_days=5 → ~390-bar window
    - 1m data, n_days=5 → ~1950-bar window
    - daily,   n_days=5 → 5-bar window

Contrast with `qp.levels.rolling_high` (fixed bar-count length) and
`qp.levels.week_high` (anchored, resets at boundaries with sawtooth).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.rolling import _session_bounds


def _rolling_session_extreme(bars: pd.DataFrame,
                             n_days: int,
                             column: str,
                             side: str,
                             spec: SessionSpec) -> np.ndarray:
    if not isinstance(n_days, int) or n_days < 1:
        raise ValueError(f'n_days must be a positive integer, got {n_days!r}')
    n = len(bars)
    if n == 0:
        return np.array([], dtype=float)

    values = bars[column].to_numpy(dtype=float)
    session_idx, session_starts = _session_bounds(bars, spec)

    out = np.full(n, np.nan, dtype=float)
    fn = np.nanmax if side == 'high' else np.nanmin
    for i in range(n):
        target = max(0, int(session_idx[i]) - n_days + 1)
        start = session_starts[target]
        window = values[start:i + 1]
        if window.size:
            v = fn(window)
            if np.isfinite(v):
                out[i] = v
    return out


def rolling_n_day_high(bars: pd.DataFrame, n_days: int,
                       spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Highest high over the bars belonging to the last n_days sessions."""
    return _rolling_session_extreme(bars, n_days, 'high', 'high', spec)


def rolling_n_day_low(bars: pd.DataFrame, n_days: int,
                      spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Lowest low over the bars belonging to the last n_days sessions."""
    return _rolling_session_extreme(bars, n_days, 'low', 'low', spec)
