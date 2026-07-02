"""
Session / week / month / quarter / year / N-day VWAPs.

Each one is a `reset_mask` producer that feeds `anchored_vwap`. The
mask fires True on the FIRST bar of each accumulation window (start of
day, start of week, etc.), which zeroes the accumulator before that bar
contributes.

`bars` must have a timezone-aware DatetimeIndex. The session engine's
timezone is used to compute the calendar-day boundary — that way a
1-minute bar timestamped 04:00 UTC (00:00 ET) doesn't create a spurious
new-day reset because of DST.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.core import anchored_vwap


def _local(bars: pd.DataFrame, spec: SessionSpec) -> pd.DatetimeIndex:
    if bars.index.tz is None:
        raise ValueError('bars.index must be tz-aware for session-scoped VWAPs')
    return bars.index.tz_convert(spec.tz)


def _new_day_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    local = _local(bars, spec)
    day = local.date
    prev = np.roll(day, 1)
    mask = np.array([True] + [d != p for d, p in zip(day[1:], prev[1:])], dtype=bool)
    return mask


def _new_week_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    local = _local(bars, spec)
    week = local.isocalendar().week
    year = local.isocalendar().year
    key = list(zip(year, week))
    mask = np.array([True] + [k != p for k, p in zip(key[1:], key[:-1])], dtype=bool)
    return mask


def _new_month_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    local = _local(bars, spec)
    key = list(zip(local.year, local.month))
    mask = np.array([True] + [k != p for k, p in zip(key[1:], key[:-1])], dtype=bool)
    return mask


def _new_quarter_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    local = _local(bars, spec)
    key = list(zip(local.year, ((local.month - 1) // 3 + 1)))
    mask = np.array([True] + [k != p for k, p in zip(key[1:], key[:-1])], dtype=bool)
    return mask


def _new_year_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    local = _local(bars, spec)
    mask = np.array([True] + [y != p for y, p in zip(local.year[1:], local.year[:-1])], dtype=bool)
    return mask


# ─── Public VWAP flavours ────────────────────────────────────────────────

def session_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Session (day-anchored) VWAP. Resets at midnight in the market's
    local time zone."""
    return anchored_vwap(bars, _new_day_mask(bars, spec))


def n_day_vwap(bars: pd.DataFrame, n: int, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """N-day rolling VWAP. Resets every Nth day (aligned to day boundaries)."""
    if not isinstance(n, int) or n < 1:
        raise ValueError(f'n must be a positive integer, got {n!r}')
    if n == 1:
        return session_vwap(bars, spec)
    day_mask = _new_day_mask(bars, spec)
    # Fire the reset every N days by counting new-day events.
    counter = np.cumsum(day_mask) - 1
    every_n = np.mod(counter, n) == 0
    return anchored_vwap(bars, day_mask & every_n)


def weekly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_week_mask(bars, spec))


def monthly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_month_mask(bars, spec))


def quarterly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_quarter_mask(bars, spec))


def yearly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_year_mask(bars, spec))
