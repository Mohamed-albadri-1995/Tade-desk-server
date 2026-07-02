"""
Session-based daily levels — computed on tz-aware intraday bars.

`prev_day_high` and `prev_day_low` project yesterday's REGULAR-session
extremes onto every bar of today. Bars are grouped by their calendar
day in the session's local timezone, so DST doesn't create false
day-splits.

For the CURRENT day, we look back one calendar day. If yesterday was
a weekend/holiday and no bars exist, we look back through the buffer
to the most recent day that has bars. Callers who want strict
"previous trading session, exactly one calendar day ago" should pass
a filtered index.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES, session_for_bars


def _local_dates(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    if bars.index.tz is None:
        raise ValueError('bars.index must be tz-aware')
    return bars.index.tz_convert(spec.tz).date


def _daily_regular_extremes(bars: pd.DataFrame, spec: SessionSpec):
    """Return two dicts {date -> value}: highs and lows over regular
    session only."""
    labels = session_for_bars(bars, spec)
    regular = bars[labels.to_numpy() == 'regular']
    if len(regular) == 0:
        return {}, {}
    dates = pd.DatetimeIndex(regular.index).tz_convert(spec.tz).date
    grouped_h = pd.Series(regular['high'].to_numpy(dtype=float), index=dates)
    grouped_l = pd.Series(regular['low'].to_numpy(dtype=float), index=dates)
    highs = grouped_h.groupby(grouped_h.index).max().to_dict()
    lows  = grouped_l.groupby(grouped_l.index).min().to_dict()
    return highs, lows


def prev_day_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """For each bar, the REGULAR-session high of the most recent prior
    calendar day that had bars. NaN before any prior day exists."""
    highs, _ = _daily_regular_extremes(bars, spec)
    return _project_prior(bars, highs, spec)


def prev_day_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    _, lows = _daily_regular_extremes(bars, spec)
    return _project_prior(bars, lows, spec)


def _project_prior(bars: pd.DataFrame,
                   value_by_date: dict,
                   spec: SessionSpec) -> np.ndarray:
    """For each bar's local date, look up the most-recent prior date's
    value. Runs O(n log k) where k is the number of unique days."""
    out = np.full(len(bars), np.nan, dtype=float)
    if not value_by_date:
        return out
    sorted_dates = sorted(value_by_date.keys())
    local_dates = _local_dates(bars, spec)
    # Cache last lookup — bars are chronological so cursor moves forward.
    cursor = 0
    for i, d in enumerate(local_dates):
        # Advance cursor to the largest sorted_dates[j] < d.
        while cursor < len(sorted_dates) and sorted_dates[cursor] < d:
            cursor += 1
        # sorted_dates[cursor-1] is the most recent date < d.
        idx = cursor - 1
        if idx >= 0:
            out[i] = value_by_date[sorted_dates[idx]]
    return out


def premarket_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """For each bar, the highest high seen in the CURRENT day's premarket
    session up to and including this bar. Before premarket starts, NaN.
    After premarket ends, the frozen premarket high carries through the
    rest of the day."""
    return _cumulative_extreme_by_day(bars, spec, side='high')


def premarket_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _cumulative_extreme_by_day(bars, spec, side='low')


def _cumulative_extreme_by_day(bars: pd.DataFrame,
                               spec: SessionSpec,
                               side: str) -> np.ndarray:
    labels = session_for_bars(bars, spec).to_numpy()
    dates = _local_dates(bars, spec)
    hi = bars['high'].to_numpy(dtype=float)
    lo = bars['low'].to_numpy(dtype=float)
    out = np.full(len(bars), np.nan, dtype=float)
    current_date = None
    running = None
    for i in range(len(bars)):
        d = dates[i]
        if d != current_date:
            current_date = d
            running = None
        if labels[i] == 'premarket':
            v = hi[i] if side == 'high' else lo[i]
            if running is None:
                running = v
            else:
                running = max(running, v) if side == 'high' else min(running, v)
        # Whether or not this bar is premarket, output the frozen value
        # for the day (NaN if no premarket bars yet).
        if running is not None:
            out[i] = running
    return out
