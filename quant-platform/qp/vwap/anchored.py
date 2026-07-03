"""
Event-anchored VWAPs — resets on a market event, not a calendar boundary.

Pine parity for the three VWAP flavours in "VWAP Cluster Bounce":

    today_hh_vwap / today_ll_vwap
        Re-anchor at the bar that prints today's highest high (or
        lowest low). When a new intraday extreme prints, the anchor
        MOVES to that bar and the accumulator restarts.

    week_hh_vwap / week_ll_vwap
        Same idea but the extreme is tracked over the current ISO week
        (reset at Monday 09:30 ET).

    gap_vwap
        Anchors at the bar whose open gaps by more than N × ATR from
        the prior close. Repeats on every subsequent gap bar.

    last_hour_ll_vwap / last_hour_hh_vwap
        Cross-session anchor: track the LL (or HH) bar's price and
        volume during the last hour of day D; at the start of day D+1,
        seed the VWAP accumulator with that (price × volume) point and
        continue accumulating through the day.

    earnings_vwap
        Simple date-anchored VWAP — resets at the first bar whose
        timestamp >= anchor_date. Callers can supply an earnings /
        news / macro-event timestamp.
"""

from __future__ import annotations

from typing import Union

import numpy as np
import pandas as pd

from qp.price import hlc3
from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.sessional import _new_session_mask, _new_week_mask
from qp.volatility import atr as _atr


# ─── Internal helpers ────────────────────────────────────────────────

def _extreme_anchored_vwap(bars: pd.DataFrame,
                           side: str,
                           reset_mask: np.ndarray) -> np.ndarray:
    """Re-anchored VWAP: on any bar where `reset_mask` is True, or where
    a new extreme prints in the current window, start the accumulator
    fresh from that bar. `side` is 'high' or 'low'.
    """
    p = np.asarray(hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    extremes = bars['high' if side == 'high' else 'low'].to_numpy(dtype=float)

    n = len(bars)
    out = np.full(n, np.nan, dtype=float)
    running_ext = np.inf if side == 'low' else -np.inf
    cum_pv = 0.0
    cum_v  = 0.0
    for i in range(n):
        # Window reset (new session / week / month / …)
        if reset_mask[i]:
            running_ext = extremes[i]
            cum_pv = (p[i] * v[i]) if np.isfinite(p[i]) and np.isfinite(v[i]) else 0.0
            cum_v  = v[i] if np.isfinite(v[i]) else 0.0
        else:
            new_ext = (side == 'high' and extremes[i] > running_ext) or \
                      (side == 'low'  and extremes[i] < running_ext)
            if new_ext:
                running_ext = extremes[i]
                cum_pv = (p[i] * v[i]) if np.isfinite(p[i]) and np.isfinite(v[i]) else 0.0
                cum_v  = v[i] if np.isfinite(v[i]) else 0.0
            else:
                if np.isfinite(p[i]) and np.isfinite(v[i]):
                    cum_pv += p[i] * v[i]
                    cum_v  += v[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


# ─── Intraday HH / LL VWAP ───────────────────────────────────────────

def today_hh_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Anchored VWAP that re-anchors whenever a new intraday HIGH prints.
    Resets at each session open (09:30 ET for US equities)."""
    return _extreme_anchored_vwap(bars, 'high', _new_session_mask(bars, spec))


def today_ll_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Anchored VWAP that re-anchors whenever a new intraday LOW prints."""
    return _extreme_anchored_vwap(bars, 'low', _new_session_mask(bars, spec))


# ─── Weekly HH / LL VWAP ─────────────────────────────────────────────

def week_hh_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Anchored VWAP that re-anchors on each new WEEKLY high. Resets
    at each Monday 09:30 ET (start of new ISO week)."""
    return _extreme_anchored_vwap(bars, 'high', _new_week_mask(bars, spec))


def week_ll_vwap(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Anchored VWAP that re-anchors on each new WEEKLY low."""
    return _extreme_anchored_vwap(bars, 'low', _new_week_mask(bars, spec))


# ─── Gap VWAP ────────────────────────────────────────────────────────

def gap_vwap(bars: pd.DataFrame,
             atr_length: int = 14,
             atr_mult: float = 1.5,
             spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """VWAP anchored at every gap bar. A "gap" is any bar where
    |open − prev_close| >= atr_mult × ATR(atr_length). Line is NaN
    before the first gap; each subsequent gap re-anchors."""
    p = np.asarray(hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    opens  = bars['open'].to_numpy(dtype=float)
    closes = bars['close'].to_numpy(dtype=float)
    atr_vals = _atr(bars, atr_length)

    prev_closes = np.concatenate(([np.nan], closes[:-1]))
    gap_sizes = np.abs(opens - prev_closes)
    is_gap = (gap_sizes >= atr_vals * atr_mult) & \
             np.isfinite(atr_vals) & np.isfinite(prev_closes)

    n = len(bars)
    out = np.full(n, np.nan, dtype=float)
    anchored = False
    cum_pv = cum_v = 0.0
    for i in range(n):
        if is_gap[i]:
            anchored = True
            cum_pv = (p[i] * v[i]) if np.isfinite(p[i]) and np.isfinite(v[i]) else 0.0
            cum_v  = v[i] if np.isfinite(v[i]) else 0.0
        elif anchored:
            if np.isfinite(p[i]) and np.isfinite(v[i]):
                cum_pv += p[i] * v[i]
                cum_v  += v[i]
        if anchored and cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


# ─── Last Hour LL / HH VWAP ──────────────────────────────────────────

def _last_hour_vwap(bars: pd.DataFrame,
                    side: str,
                    last_hour_start_hour: int,
                    spec: SessionSpec) -> np.ndarray:
    """Cross-session VWAP: track the LL (or HH) bar's price and volume
    during the last hour of day D, then at the start of day D+1 seed the
    accumulator with (that_price × that_volume, that_volume) and continue
    accumulating through day D+1."""
    p = np.asarray(hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    highs = bars['high'].to_numpy(dtype=float)
    lows  = bars['low'].to_numpy(dtype=float)

    session_mask = _new_session_mask(bars, spec)
    local = bars.index.tz_convert(spec.tz)
    hours = np.asarray(local.hour)

    n = len(bars)
    out = np.full(n, np.nan, dtype=float)

    # Current day's last-hour running extreme (price + volume)
    lh_price = np.nan
    lh_vol   = np.nan
    # Previous day's carried-over extreme
    prev_price = np.nan
    prev_vol   = np.nan

    anchored = False
    cum_pv = cum_v = 0.0

    for i in range(n):
        if session_mask[i] and i > 0:
            # Day-boundary: roll current lh to prev, then seed today's
            # accumulator with prev's (price × volume) point.
            prev_price = lh_price
            prev_vol   = lh_vol
            lh_price = np.nan
            lh_vol   = np.nan
            if np.isfinite(prev_price) and np.isfinite(prev_vol) and prev_vol > 0:
                anchored = True
                seed_pv = prev_price * prev_vol
                today_pv = (p[i] * v[i]) if np.isfinite(p[i]) and np.isfinite(v[i]) else 0.0
                today_v  = v[i] if np.isfinite(v[i]) else 0.0
                cum_pv = seed_pv + today_pv
                cum_v  = prev_vol + today_v
            else:
                anchored = False
                cum_pv = 0.0
                cum_v  = 0.0
        elif anchored:
            if np.isfinite(p[i]) and np.isfinite(v[i]):
                cum_pv += p[i] * v[i]
                cum_v  += v[i]

        # Track today's last-hour extreme
        if hours[i] >= last_hour_start_hour:
            current = lows[i] if side == 'low' else highs[i]
            update = np.isnan(lh_price) or \
                     (side == 'low'  and current < lh_price) or \
                     (side == 'high' and current > lh_price)
            if update and np.isfinite(current):
                lh_price = current
                lh_vol   = v[i] if np.isfinite(v[i]) else 0.0

        if anchored and cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


def last_hour_ll_vwap(bars: pd.DataFrame,
                      last_hour_start_hour: int = 15,
                      spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """VWAP anchored at the price of PREVIOUS session's last-hour LL bar.
    `last_hour_start_hour` defaults to 15 (i.e. 15:00 ET = last regular
    hour of the US equity session)."""
    return _last_hour_vwap(bars, 'low', last_hour_start_hour, spec)


def last_hour_hh_vwap(bars: pd.DataFrame,
                      last_hour_start_hour: int = 15,
                      spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """VWAP anchored at the price of PREVIOUS session's last-hour HH bar."""
    return _last_hour_vwap(bars, 'high', last_hour_start_hour, spec)


# ─── Earnings / News anchored VWAP ───────────────────────────────────

def earnings_vwap(bars: pd.DataFrame,
                  anchor_date: Union[str, pd.Timestamp]) -> np.ndarray:
    """VWAP anchored at the first bar whose timestamp is >= `anchor_date`.

    Use to project an earnings-day or news-event VWAP forward. NaN
    for all bars before the anchor.

    Auto-fetching earnings calendars is not built into qp — supply
    the anchor date manually or wire in a Polygon / FMP earnings-calendar
    fetch upstream and call this once per event.
    """
    t = pd.Timestamp(anchor_date)
    if t.tz is None:
        t = t.tz_localize('UTC')
    else:
        t = t.tz_convert('UTC')

    p = np.asarray(hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    # First bar at-or-after the anchor date
    idx = bars.index.get_indexer([t], method='bfill')[0]

    n = len(bars)
    out = np.full(n, np.nan, dtype=float)
    if idx < 0 or idx >= n:
        return out
    cum_pv = cum_v = 0.0
    for i in range(idx, n):
        if np.isfinite(p[i]) and np.isfinite(v[i]):
            cum_pv += p[i] * v[i]
            cum_v  += v[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out
