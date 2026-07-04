"""
Weekday-anchored H/L — the current week's Monday H/L, projected forward.

Script 2 shows a "Monday High / Monday Low" that stays visible across
Tue-Fri of the same ISO week. Once a new Monday starts, the level
refreshes to that Monday's H/L.

For simplicity we track the day-of-week over regular-session bars only
(matches how TradingView reads a daily bar).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES, session_for_bars


def _weekday_extreme(bars: pd.DataFrame,
                     weekday: int,
                     side: str,
                     spec: SessionSpec) -> np.ndarray:
    """weekday: 0=Mon .. 6=Sun. Returns per-bar value = the current ISO
    week's `weekday` H (or L) so far, or NaN if that day hasn't happened
    in this week yet."""
    labels = session_for_bars(bars, spec).to_numpy()
    if bars.index.tz is None:
        raise ValueError('bars.index must be tz-aware')
    local = bars.index.tz_convert(spec.tz)
    dow  = np.asarray(local.weekday)
    iso  = [t.isocalendar() for t in local]
    week_key = np.array([(k.year, k.week) for k in iso], dtype=object)

    hi = bars['high'].to_numpy(dtype=float)
    lo = bars['low'].to_numpy(dtype=float)
    n = len(bars)

    # First pass: compute running extreme for each (week_key, weekday=weekday).
    running_by_week = {}
    per_bar = np.full(n, np.nan, dtype=float)
    for i in range(n):
        if labels[i] != 'regular':
            continue
        if dow[i] != weekday:
            continue
        wk = week_key[i]
        v = hi[i] if side == 'high' else lo[i]
        if wk not in running_by_week or not np.isfinite(running_by_week[wk]):
            running_by_week[wk] = v
        else:
            running_by_week[wk] = (max(running_by_week[wk], v) if side == 'high'
                                   else min(running_by_week[wk], v))
        per_bar[i] = running_by_week[wk]

    # Second pass: project — for every bar in a given ISO week, look up
    # the LAST-observed running extreme for that week (may still be
    # updating during the Monday bars themselves).
    last_seen = {}
    out = np.full(n, np.nan, dtype=float)
    for i in range(n):
        wk = week_key[i]
        if np.isfinite(per_bar[i]):
            last_seen[wk] = per_bar[i]
        if wk in last_seen:
            out[i] = last_seen[wk]
    return out


def monday_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _weekday_extreme(bars, 0, 'high', spec)


def monday_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _weekday_extreme(bars, 0, 'low', spec)
