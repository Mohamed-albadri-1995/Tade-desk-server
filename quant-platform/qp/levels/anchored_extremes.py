"""
Anchored (running) high/low levels — the "developing" high/low of the
current session, week, or month. Complement to the "prior period"
levels in `session_daily` and `session_week_month`.

Semantics match Pine `ta.highest(high, ta.barssince(...))`:
    At each bar, the highest high (or lowest low) seen since the most
    recent anchor point, INCLUDING the current bar. Grows during the
    period (a fresh high prints → the line steps up), freezes at the
    period close, resets at the next anchor.

Anchors reuse the same masks as `qp.vwap.session_vwap`, `weekly_vwap`,
and `monthly_vwap`, so a Tuesday 04:00 ET premarket bar is treated as
"still in Monday's session" and Monday's HH/LL is preserved until 09:30
ET on Tuesday.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.sessional import (
    _new_session_mask, _new_week_mask, _new_month_mask,
    _new_quarter_mask, _new_year_mask,
)


def _cumulative_extreme(values: np.ndarray,
                        reset_mask: np.ndarray,
                        side: str) -> np.ndarray:
    """Running max ('high') or min ('low') resetting at each True in mask."""
    n = values.size
    out = np.full(n, np.nan, dtype=float)
    running = None
    for i in range(n):
        if reset_mask[i]:
            running = None
        v = values[i]
        if not np.isfinite(v):
            if running is not None:
                out[i] = running
            continue
        if running is None:
            running = v
        else:
            running = max(running, v) if side == 'high' else min(running, v)
        out[i] = running
    return out


def today_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Cumulative highest high since this session's regular_open."""
    return _cumulative_extreme(
        bars['high'].to_numpy(dtype=float),
        _new_session_mask(bars, spec), 'high',
    )


def today_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Cumulative lowest low since this session's regular_open."""
    return _cumulative_extreme(
        bars['low'].to_numpy(dtype=float),
        _new_session_mask(bars, spec), 'low',
    )


def week_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Cumulative highest high since this Monday's regular_open."""
    return _cumulative_extreme(
        bars['high'].to_numpy(dtype=float),
        _new_week_mask(bars, spec), 'high',
    )


def week_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme(
        bars['low'].to_numpy(dtype=float),
        _new_week_mask(bars, spec), 'low',
    )


def month_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Cumulative highest high since the first RTH bar of this month."""
    return _cumulative_extreme(
        bars['high'].to_numpy(dtype=float),
        _new_month_mask(bars, spec), 'high',
    )


def month_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme(
        bars['low'].to_numpy(dtype=float),
        _new_month_mask(bars, spec), 'low',
    )


def quarter_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme(
        bars['high'].to_numpy(dtype=float),
        _new_quarter_mask(bars, spec), 'high',
    )


def quarter_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme(
        bars['low'].to_numpy(dtype=float),
        _new_quarter_mask(bars, spec), 'low',
    )


def year_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme(
        bars['high'].to_numpy(dtype=float),
        _new_year_mask(bars, spec), 'high',
    )


def year_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme(
        bars['low'].to_numpy(dtype=float),
        _new_year_mask(bars, spec), 'low',
    )
