"""
Overnight / pre-market H-L levels — Script 2's ONH / ONL.

Overnight window: 18:00 → next-day 09:30 ET. During the window, running
HH/LL of high and low. Once RTH begins the level is FROZEN and projected
across the entire RTH session, until the next 18:00.

Note: this session doesn't fit `qp.session.SessionSpec` cleanly because
it spans midnight. So we use plain wall-clock ET hours (18:00-24:00 or
00:00-09:30) as the session-window predicate.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _overnight_extreme(bars: pd.DataFrame,
                       side: str,
                       start_hour: int = 18,
                       end_hour: int = 9,
                       end_minute: int = 30) -> np.ndarray:
    if bars.index.tz is None:
        raise ValueError('bars.index must be tz-aware')
    local = bars.index.tz_convert('America/New_York')
    hh = np.asarray(local.hour)
    mm = np.asarray(local.minute)
    is_overnight = (hh >= start_hour) | (hh < end_hour) | \
                   ((hh == end_hour) & (mm < end_minute))

    hi = bars['high'].to_numpy(dtype=float)
    lo = bars['low'].to_numpy(dtype=float)
    n = len(bars)
    out = np.full(n, np.nan, dtype=float)

    running = np.nan
    in_window_prev = False
    for i in range(n):
        if is_overnight[i]:
            if not in_window_prev:
                running = hi[i] if side == 'high' else lo[i]
            else:
                v = hi[i] if side == 'high' else lo[i]
                if side == 'high':
                    running = v if not np.isfinite(running) or v > running else running
                else:
                    running = v if not np.isfinite(running) or v < running else running
            in_window_prev = True
        else:
            in_window_prev = False
            # Freeze the last-known running value across RTH.
        if np.isfinite(running):
            out[i] = running
    return out


def overnight_high(bars: pd.DataFrame) -> np.ndarray:
    """Running / frozen highest high during the 18:00 → 09:30 ET window."""
    return _overnight_extreme(bars, 'high')


def overnight_low(bars: pd.DataFrame) -> np.ndarray:
    """Running / frozen lowest low during the 18:00 → 09:30 ET window."""
    return _overnight_extreme(bars, 'low')
