"""
Floor pivots — daily P, R1-R3, S1-S3 from the prior day's H/L/C.

Standard floor-pivot math (Script 2's Full-Day Daily Pivots):

    P  = (H + L + C) / 3
    R1 = 2*P - L
    S1 = 2*P - H
    R2 = P + (H - L)
    S2 = P - (H - L)
    R3 = H + 2*(P - L)
    S3 = L - 2*(H - P)

Values are constant across each session, refreshed at each session
boundary using the prior day's H/L/C. Uses REGULAR-session extremes
(same as prev_day_high / prev_day_low) so the numbers match what a
typical desktop shows.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES, session_for_bars
from qp.levels.session_daily import _local_dates


@dataclass
class FloorPivots:
    P:  np.ndarray
    R1: np.ndarray
    R2: np.ndarray
    R3: np.ndarray
    S1: np.ndarray
    S2: np.ndarray
    S3: np.ndarray


def _daily_hlc(bars: pd.DataFrame, spec: SessionSpec):
    """{date: (H, L, C)} using regular-session bars only."""
    labels = session_for_bars(bars, spec).to_numpy()
    reg = bars[labels == 'regular']
    if len(reg) == 0:
        return {}
    dates = pd.DatetimeIndex(reg.index).tz_convert(spec.tz).date
    h = pd.Series(reg['high'].to_numpy(dtype=float), index=dates)
    l = pd.Series(reg['low'].to_numpy(dtype=float),  index=dates)
    c = pd.Series(reg['close'].to_numpy(dtype=float), index=dates)
    highs = h.groupby(h.index).max()
    lows  = l.groupby(l.index).min()
    # Closing print of the session = last bar's close
    closes = c.groupby(c.index).last()
    return {d: (highs[d], lows[d], closes[d]) for d in highs.index}


def floor_pivots(bars: pd.DataFrame,
                 spec: SessionSpec = US_EQUITIES) -> FloorPivots:
    """Return per-bar arrays for P, R1-R3, S1-S3. Constant within each
    session, derived from prior session's H/L/C. NaN before any prior."""
    hlc = _daily_hlc(bars, spec)
    n = len(bars)
    P  = np.full(n, np.nan, dtype=float)
    R1 = np.full(n, np.nan, dtype=float)
    R2 = np.full(n, np.nan, dtype=float)
    R3 = np.full(n, np.nan, dtype=float)
    S1 = np.full(n, np.nan, dtype=float)
    S2 = np.full(n, np.nan, dtype=float)
    S3 = np.full(n, np.nan, dtype=float)
    if not hlc:
        return FloorPivots(P=P, R1=R1, R2=R2, R3=R3, S1=S1, S2=S2, S3=S3)

    sorted_dates = sorted(hlc.keys())
    local_dates = _local_dates(bars, spec)
    cursor = 0
    for i, d in enumerate(local_dates):
        while cursor < len(sorted_dates) and sorted_dates[cursor] < d:
            cursor += 1
        idx = cursor - 1
        if idx < 0:
            continue
        H, L, C = hlc[sorted_dates[idx]]
        p  = (H + L + C) / 3.0
        rng = H - L
        P[i]  = p
        R1[i] = 2 * p - L
        S1[i] = 2 * p - H
        R2[i] = p + rng
        S2[i] = p - rng
        R3[i] = H + 2 * (p - L)
        S3[i] = L - 2 * (H - p)
    return FloorPivots(P=P, R1=R1, R2=R2, R3=R3, S1=S1, S2=S2, S3=S3)
