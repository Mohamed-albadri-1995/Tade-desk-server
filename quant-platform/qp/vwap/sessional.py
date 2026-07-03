"""
Session / week / month / quarter / year / N-day VWAPs.

Each one is a `reset_mask` producer that feeds `anchored_vwap`. The
mask fires True on the FIRST bar of each accumulation window (start of
session, start of week, etc.), which zeroes the accumulator before
that bar contributes.

`bars` must have a timezone-aware DatetimeIndex. The session engine's
timezone is used to compute all boundaries — that way a 1-minute bar
timestamped 04:00 UTC (00:00 ET) doesn't create a spurious new-day
reset because of DST.

**Session semantics** (matches TradingView's Pine `ta.vwap`):
    A "trading day" runs from spec.regular_open on date D to
    spec.regular_open on date D+1. So for US equities:
        Jan 5 09:30 ET → Jan 6 09:30 ET is one session.
    Premarket bars (04:00–09:29) on date D+1 belong to date D's
    session — the accumulator continues overnight until the next
    09:30 ET crosses, at which point it resets.

    This is robust to callers that pass unfiltered data (bars
    including premarket/afterhours): qp still resets at the same
    place TradingView would, so the visible VWAP line matches
    bar-for-bar.
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


def _new_session_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    """Fire True at the first bar whose local time is at-or-after
    `spec.regular_open` on a new session date.

    Implementation: shift each local timestamp back by regular_open's
    time-of-day. A bar at 09:30 ET Jan 6 shifts to 00:00 ET Jan 6 →
    date Jan 6. A premarket bar at 08:00 ET Jan 6 shifts to 22:30 ET
    Jan 5 → date Jan 5 (belongs to Jan 5's session). The mask fires
    where this "session date" changes.
    """
    local = _local(bars, spec)
    r_open = spec.regular_open
    offset = pd.Timedelta(hours=r_open.hour, minutes=r_open.minute,
                          seconds=r_open.second)
    shifted = local - offset
    session_dates = np.asarray(shifted.date)
    if session_dates.size == 0:
        return np.array([], dtype=bool)
    prev = np.roll(session_dates, 1)
    mask = np.concatenate([[True], session_dates[1:] != prev[1:]]).astype(bool)
    return mask


# Kept as an alias so anything wanting strict calendar-day reset can
# still ask for it explicitly. Session-anchored reset is the default.
def _new_day_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    """Calendar-day reset — fires when the local ET date changes. Only
    matches TradingView when the input has been pre-filtered to RTH
    (so the first bar of each date lands on regular_open by coincidence).
    Prefer `_new_session_mask` for TradingView-parity VWAPs.
    """
    local = _local(bars, spec)
    day = local.date
    prev = np.roll(day, 1)
    mask = np.array([True] + [d != p for d, p in zip(day[1:], prev[1:])], dtype=bool)
    return mask


def _shifted_local(bars: pd.DataFrame, spec: SessionSpec) -> pd.DatetimeIndex:
    """Local time shifted back by spec.regular_open so that a bar at
    09:30 ET on Monday Jan 6 becomes 00:00 ET Monday Jan 6, and a
    premarket bar at 04:00 ET Monday Jan 6 becomes 18:30 ET Sunday
    Jan 5. Downstream week / month / etc. masks use this shifted
    time so their resets fire on the session's first RTH bar, not
    on premarket bars of the same calendar date."""
    r_open = spec.regular_open
    offset = pd.Timedelta(hours=r_open.hour, minutes=r_open.minute,
                          seconds=r_open.second)
    return _local(bars, spec) - offset


def _new_week_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    """Fire True at the first RTH bar of each new ISO week (Monday session)."""
    shifted = _shifted_local(bars, spec)
    key = list(zip(shifted.isocalendar().year, shifted.isocalendar().week))
    if not key:
        return np.array([], dtype=bool)
    mask = np.array([True] + [k != p for k, p in zip(key[1:], key[:-1])], dtype=bool)
    return mask


def _new_month_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    """Fire True at the first RTH bar of each new calendar month."""
    shifted = _shifted_local(bars, spec)
    key = list(zip(shifted.year, shifted.month))
    if not key:
        return np.array([], dtype=bool)
    mask = np.array([True] + [k != p for k, p in zip(key[1:], key[:-1])], dtype=bool)
    return mask


def _new_quarter_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    """Fire True at the first RTH bar of each new calendar quarter."""
    shifted = _shifted_local(bars, spec)
    key = list(zip(shifted.year, ((shifted.month - 1) // 3 + 1)))
    if not key:
        return np.array([], dtype=bool)
    mask = np.array([True] + [k != p for k, p in zip(key[1:], key[:-1])], dtype=bool)
    return mask


def _new_year_mask(bars: pd.DataFrame, spec: SessionSpec) -> np.ndarray:
    """Fire True at the first RTH bar of each new calendar year."""
    shifted = _shifted_local(bars, spec)
    years = shifted.year
    if len(years) == 0:
        return np.array([], dtype=bool)
    mask = np.array([True] + [y != p for y, p in zip(years[1:], years[:-1])], dtype=bool)
    return mask


# ─── Public VWAP flavours ────────────────────────────────────────────────

def session_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Session-anchored VWAP.

    Resets at each spec.regular_open in the market's local time zone
    (09:30 ET for US equities). Matches TradingView's `ta.vwap` on
    intraday equity charts bar-for-bar, whether or not the caller
    filters out premarket/afterhours first. See module docstring for
    the session-boundary definition.
    """
    return anchored_vwap(bars, _new_session_mask(bars, spec))


def n_day_vwap(bars: pd.DataFrame, n: int, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """N-session rolling VWAP. Resets every Nth session (aligned to
    spec.regular_open boundaries)."""
    if not isinstance(n, int) or n < 1:
        raise ValueError(f'n must be a positive integer, got {n!r}')
    if n == 1:
        return session_vwap(bars, spec)
    session_mask = _new_session_mask(bars, spec)
    counter = np.cumsum(session_mask) - 1
    every_n = np.mod(counter, n) == 0
    return anchored_vwap(bars, session_mask & every_n)


def weekly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_week_mask(bars, spec))


def monthly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_month_mask(bars, spec))


def quarterly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_quarter_mask(bars, spec))


def yearly_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return anchored_vwap(bars, _new_year_mask(bars, spec))
