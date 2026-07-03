"""
Period-anchored SMAs — the arithmetic-mean analog of the anchored VWAPs
in `qp.vwap.sessional`. At each bar, the value is the mean of every bar
since the most recent anchor (Monday's session open, first-of-month,
etc.). Contrast with:

- `qp.ma.sma` — fixed-length rolling window, no session awareness
- `qp.ma.n_session_sma` — rolling window of the last N sessions

Anchors reuse the same masks the VWAP flavours use, so weekly here and
`qp.vwap.weekly_vwap` reset at exactly the same bars.
"""

from __future__ import annotations

from typing import Union

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.sessional import (
    _new_session_mask,
    _new_week_mask,
    _new_month_mask,
    _new_quarter_mask,
    _new_year_mask,
)


def _anchored_mean(values: np.ndarray, reset_mask: np.ndarray) -> np.ndarray:
    """Cumulative mean of `values`, restarting at every True in
    `reset_mask`. Bars before any reset return NaN; mask is expected to
    have True at index 0."""
    n = values.size
    out = np.full(n, np.nan, dtype=float)
    total = 0.0
    count = 0
    for i in range(n):
        if reset_mask[i]:
            total = 0.0
            count = 0
        if np.isfinite(values[i]):
            total += values[i]
            count += 1
        if count > 0:
            out[i] = total / count
    return out


def _resolve_source(bars: pd.DataFrame,
                    source: Union[str, np.ndarray]) -> np.ndarray:
    if isinstance(source, str):
        return bars[source].to_numpy(dtype=float)
    return np.asarray(source, dtype=float)


def session_sma(bars: pd.DataFrame,
                source: Union[str, np.ndarray] = 'close',
                spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Daily-anchored SMA. At each bar, mean of every bar since this
    session's RTH open (09:30 ET for US equities)."""
    return _anchored_mean(_resolve_source(bars, source),
                          _new_session_mask(bars, spec))


def weekly_sma(bars: pd.DataFrame,
               source: Union[str, np.ndarray] = 'close',
               spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Weekly-anchored SMA. At each bar, mean of every bar since this
    Monday's RTH open. Matches `qp.vwap.weekly_vwap`'s anchor points."""
    return _anchored_mean(_resolve_source(bars, source),
                          _new_week_mask(bars, spec))


def monthly_sma(bars: pd.DataFrame,
                source: Union[str, np.ndarray] = 'close',
                spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Monthly-anchored SMA. At each bar, mean of every bar since the
    first session's RTH open of this calendar month."""
    return _anchored_mean(_resolve_source(bars, source),
                          _new_month_mask(bars, spec))


def quarterly_sma(bars: pd.DataFrame,
                  source: Union[str, np.ndarray] = 'close',
                  spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _anchored_mean(_resolve_source(bars, source),
                          _new_quarter_mask(bars, spec))


def yearly_sma(bars: pd.DataFrame,
               source: Union[str, np.ndarray] = 'close',
               spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _anchored_mean(_resolve_source(bars, source),
                          _new_year_mask(bars, spec))
