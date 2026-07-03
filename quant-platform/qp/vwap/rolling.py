"""
Rolling N-session VWAP.

Contrast with `qp.vwap.n_day_vwap`, which RESETS every N sessions
(sawtooth line). `rolling_n_day_vwap` uses a rolling window: at every
bar, it looks back exactly N sessions worth of bars — variable bar
count depending on timeframe (78 bars/session on 5m, 390 on 1m, etc.)
and produces a smooth line that adapts to the chart's resolution.

Handles partial sessions and holidays because the window is
session-anchored, not fixed-bar-count.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from qp.price import hlc3
from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.sessional import _new_session_mask


def _session_bounds(bars: pd.DataFrame, spec: SessionSpec):
    """Return (session_idx, session_starts) where:
      session_idx[i] = 0-indexed session number the i-th bar belongs to
      session_starts[k] = first bar index of session k
                         (sentinel: session_starts[max+1] = len(bars))
    """
    n = len(bars)
    if n == 0:
        return np.array([], dtype=int), np.array([0], dtype=int)
    mask = _new_session_mask(bars, spec)
    session_idx = np.cumsum(mask) - 1
    max_sess = int(session_idx[-1])
    session_starts = np.searchsorted(session_idx, np.arange(max_sess + 1))
    session_starts = np.append(session_starts, n)
    return session_idx, session_starts


def rolling_n_day_vwap(bars: pd.DataFrame,
                       n_days: int,
                       spec: SessionSpec = US_EQUITIES,
                       price: Optional[np.ndarray] = None) -> np.ndarray:
    """Rolling VWAP over the last `n_days` sessions of bars.

    At bar i, the window covers every bar whose session index is in
    [session_idx[i] - n_days + 1, session_idx[i]]. Uses HLC3 as the
    price series by default (TradingView's convention).
    """
    if not isinstance(n_days, int) or n_days < 1:
        raise ValueError(f'n_days must be a positive integer, got {n_days!r}')
    n = len(bars)
    if n == 0:
        return np.array([], dtype=float)

    p = np.asarray(price if price is not None else hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)

    session_idx, session_starts = _session_bounds(bars, spec)

    # Prefix sums for O(1) window queries.
    pv = np.where(np.isfinite(p) & np.isfinite(v), p * v, 0.0)
    vv = np.where(np.isfinite(v), v, 0.0)
    cum_pv = np.concatenate([[0.0], np.cumsum(pv)])
    cum_v  = np.concatenate([[0.0], np.cumsum(vv)])

    out = np.full(n, np.nan, dtype=float)
    for i in range(n):
        target = max(0, int(session_idx[i]) - n_days + 1)
        start = session_starts[target]
        num = cum_pv[i + 1] - cum_pv[start]
        den = cum_v[i + 1]  - cum_v[start]
        if den > 0:
            out[i] = num / den
    return out
