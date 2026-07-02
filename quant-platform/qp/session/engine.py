"""
Session engine — model of a market's trading day.

The core abstraction is `SessionSpec`: a timezone + a set of named
windows (premarket / regular / after-hours). Every function operates on
timezone-aware pandas Timestamps so the caller never needs to think
about DST or venue-local time separately.

Bar-level convenience: pass a bars DataFrame with a DatetimeIndex and
`session_for_bars(bars, spec)` returns a categorical column
(`'premarket' | 'regular' | 'after_hours' | 'closed'`). Any downstream
computation that needs to filter to regular-session only can do
`bars[session == 'regular']`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from typing import Optional

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class SessionSpec:
    """A market's trading-day specification.

    Times are venue-local (interpret in `tz`). Weekend / holidays are
    handled at the callsite — this class just says "when do the
    windows OPEN and CLOSE within a valid trading day."
    """
    name: str
    tz: str
    premarket_start:  time
    regular_open:     time
    regular_close:    time
    after_hours_close: time

    def in_premarket(self, t: time) -> bool:
        return self.premarket_start <= t < self.regular_open

    def in_regular(self, t: time) -> bool:
        return self.regular_open <= t < self.regular_close

    def in_after_hours(self, t: time) -> bool:
        return self.regular_close <= t < self.after_hours_close


# Standard NYSE / NASDAQ US equities session (ET).
US_EQUITIES = SessionSpec(
    name='us_equities',
    tz='America/New_York',
    premarket_start=time(4, 0),
    regular_open=time(9, 30),
    regular_close=time(16, 0),
    after_hours_close=time(20, 0),
)


def _to_local_time(ts: pd.Timestamp, spec: SessionSpec) -> time:
    """Return the venue-local wall-clock time for a Timestamp."""
    if ts.tzinfo is None:
        # Assume UTC when unspecified — caller should localise upstream.
        ts = ts.tz_localize('UTC')
    return ts.tz_convert(spec.tz).time()


def current_session(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES) -> str:
    """Return one of 'premarket' | 'regular' | 'after_hours' | 'closed'."""
    t = _to_local_time(ts, spec)
    if spec.in_regular(t):     return 'regular'
    if spec.in_premarket(t):   return 'premarket'
    if spec.in_after_hours(t): return 'after_hours'
    return 'closed'


def is_regular(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES) -> bool:
    return current_session(ts, spec) == 'regular'


def is_premarket(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES) -> bool:
    return current_session(ts, spec) == 'premarket'


def is_after_hours(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES) -> bool:
    return current_session(ts, spec) == 'after_hours'


def is_extended(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES) -> bool:
    """Extended = premarket OR after-hours (not regular, not closed)."""
    return current_session(ts, spec) in ('premarket', 'after_hours')


def session_open(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES,
                 which: str = 'regular') -> pd.Timestamp:
    """Timestamp of the specified session's open for the calendar day
    containing `ts`. Returns a tz-aware Timestamp in `spec.tz`.

    `which`: 'regular' | 'premarket'.
    """
    local = ts.tz_convert(spec.tz) if ts.tzinfo else ts.tz_localize('UTC').tz_convert(spec.tz)
    t = spec.regular_open if which == 'regular' else spec.premarket_start
    return pd.Timestamp.combine(local.date(), t).tz_localize(spec.tz)


def session_close(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES,
                  which: str = 'regular') -> pd.Timestamp:
    """Timestamp of the specified session's close. `which`: 'regular' | 'after_hours'."""
    local = ts.tz_convert(spec.tz) if ts.tzinfo else ts.tz_localize('UTC').tz_convert(spec.tz)
    t = spec.regular_close if which == 'regular' else spec.after_hours_close
    return pd.Timestamp.combine(local.date(), t).tz_localize(spec.tz)


def session_length_minutes(spec: SessionSpec = US_EQUITIES,
                           which: str = 'regular') -> int:
    """Number of minutes the specified session runs. `which`:
    'regular' | 'premarket' | 'after_hours' | 'extended_full_day'."""
    def diff(a: time, b: time) -> int:
        return (b.hour - a.hour) * 60 + (b.minute - a.minute)

    if which == 'regular':
        return diff(spec.regular_open, spec.regular_close)
    if which == 'premarket':
        return diff(spec.premarket_start, spec.regular_open)
    if which == 'after_hours':
        return diff(spec.regular_close, spec.after_hours_close)
    if which == 'extended_full_day':
        return diff(spec.premarket_start, spec.after_hours_close)
    raise ValueError(f'unknown session name: {which!r}')


def session_index(ts: pd.Timestamp, spec: SessionSpec = US_EQUITIES,
                  which: str = 'regular') -> Optional[int]:
    """Minutes since `which`'s open at `ts` — or None if `ts` is not in
    that session. Useful for "N minutes into the day" logic in
    intraday indicators.
    """
    session = current_session(ts, spec)
    if session != which:
        return None
    open_ts = session_open(ts, spec, which='regular' if which == 'regular' else 'premarket')
    if ts.tzinfo is None:
        ts = ts.tz_localize('UTC')
    delta = (ts - open_ts).total_seconds() / 60.0
    return int(delta) if delta >= 0 else None


def session_for_bars(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> pd.Series:
    """Vectorised classifier: for a bars DataFrame with a tz-aware
    DatetimeIndex, return a Series of session labels aligned with the
    index. Any bars where the label would be 'closed' (weekend, gap)
    still get a label so callers can `.query('session == "regular"')`
    without losing rows.
    """
    if not isinstance(bars.index, pd.DatetimeIndex):
        raise TypeError('bars must have a DatetimeIndex')
    if bars.index.tz is None:
        raise ValueError('bars.index must be timezone-aware')
    local = bars.index.tz_convert(spec.tz)
    hours   = local.hour
    minutes = local.minute
    seconds_of_day = hours * 3600 + minutes * 60

    def to_seconds(t: time) -> int:
        return t.hour * 3600 + t.minute * 60

    pm_start = to_seconds(spec.premarket_start)
    r_open   = to_seconds(spec.regular_open)
    r_close  = to_seconds(spec.regular_close)
    ah_close = to_seconds(spec.after_hours_close)

    labels = np.full(len(bars), 'closed', dtype=object)
    labels[(seconds_of_day >= pm_start) & (seconds_of_day <  r_open)]   = 'premarket'
    labels[(seconds_of_day >= r_open)   & (seconds_of_day <  r_close)]  = 'regular'
    labels[(seconds_of_day >= r_close)  & (seconds_of_day <  ah_close)] = 'after_hours'
    return pd.Series(labels, index=bars.index, name='session')
