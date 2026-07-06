"""
VWAP primitives — session-anchored, calendar-anchored, event-anchored.

All use HLC/3 as price and volume-weighted accumulation. Non-RTH bars stay
NaN for the plain `session` variant; the other anchor types accumulate
across whatever bars they're given (typical use: an RTH-only feed).

Naming follows Pine's `ta.vwap(source, reset)` convention — each primitive
is "cumulative VWAP from anchor X, where X is <this variant's trigger>."
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive, Param
from qp.primitives.bars import Bars

_ET = 'America/New_York'


def _hlc3_vol(df: pd.DataFrame):
    """Return (price, volume) numpy arrays where price = HLC/3."""
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    close = df['close'].to_numpy(dtype=float)
    vol   = df['volume'].to_numpy(dtype=float)
    return (high + low + close) / 3.0, vol


def _running_vwap(price: np.ndarray, vol: np.ndarray,
                  anchor_mask: np.ndarray) -> np.ndarray:
    """Cumulative VWAP that resets to zero on every True in `anchor_mask`.
    Before the first True, output is NaN."""
    n = len(price)
    out = np.full(n, np.nan)
    cum_pv = 0.0
    cum_v  = 0.0
    started = False
    for i in range(n):
        if anchor_mask[i]:
            cum_pv = price[i] * vol[i]
            cum_v  = vol[i]
            started = True
        elif started:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]
        if started and cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


# ────────────────────────────────────────────────────────────
# Session / N-day / weekly / monthly
# ────────────────────────────────────────────────────────────

@primitive(
    name='session',
    group='vwap',
    description=('Session-anchored VWAP for US equities. Resets at 09:30 '
                 'America/New_York, computes only during RTH (09:30–16:00 '
                 'ET), source = HLC/3. Matches TradingView built-in VWAP.'),
    params=(),
    inputs=('bars',),
)
def session(bars: Bars):
    df = bars.df
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    n = len(df)
    out = np.full(n, np.nan)
    cum_pv = 0.0
    cum_v  = 0.0
    last_date = None
    for i in range(n):
        ts = et[i]
        rth = ((ts.hour > 9 or (ts.hour == 9 and ts.minute >= 30))
               and ts.hour < 16)
        if not rth:
            continue
        if ts.date() != last_date:
            cum_pv = 0.0
            cum_v  = 0.0
            last_date = ts.date()
        cum_pv += price[i] * vol[i]
        cum_v  += vol[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


@primitive(
    name='n_day',
    group='vwap',
    description=('VWAP that anchors every N ET calendar days (non-rolling). '
                 'For n_days=2 (default): days 1–2 share one VWAP, days 3–4 '
                 'share the next, etc. Matches Pine `ta.vwap(hlc3, isNewDay '
                 'and dCount%N==0)`.'),
    params=(Param('n_days', 'int', default=2, min=1),),
    inputs=('bars',),
)
def n_day(bars: Bars, n_days: int):
    df = bars.df
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    n = len(df)
    dates = et.date
    anchor = np.zeros(n, dtype=bool)
    day_count = 0
    last_date = None
    N = int(n_days)
    for i in range(n):
        if dates[i] != last_date:
            day_count += 1
            last_date = dates[i]
            # Match Pine literally: `isNewDay AND dCount % N == 0`. First
            # anchor is at day N (day 2 for N=2). Days 1..N-1 are NaN.
            if day_count % N == 0:
                anchor[i] = True
    return _running_vwap(price, vol, anchor)


@primitive(
    name='weekly',
    group='vwap',
    description=('Weekly VWAP. Resets on the first bar of each ISO week '
                 '(Monday). Matches Pine `ta.vwap(hlc3, isNewWeek)`.'),
    params=(),
    inputs=('bars',),
)
def weekly(bars: Bars):
    df = bars.df
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    n = len(df)
    iso = et.isocalendar()
    keys = list(zip(iso.year, iso.week))
    anchor = np.zeros(n, dtype=bool)
    last_key = None
    for i in range(n):
        if keys[i] != last_key:
            anchor[i] = True
            last_key = keys[i]
    return _running_vwap(price, vol, anchor)


@primitive(
    name='monthly',
    group='vwap',
    description=('Monthly VWAP. Resets on the first bar of each ET calendar '
                 'month. Matches Pine `ta.vwap(hlc3, isNewMonth)`.'),
    params=(),
    inputs=('bars',),
)
def monthly(bars: Bars):
    df = bars.df
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    n = len(df)
    keys = [(t.year, t.month) for t in et]
    anchor = np.zeros(n, dtype=bool)
    last_key = None
    for i in range(n):
        if keys[i] != last_key:
            anchor[i] = True
            last_key = keys[i]
    return _running_vwap(price, vol, anchor)


# ────────────────────────────────────────────────────────────
# Intraday / weekly anchored VWAPs from running HH / LL
# ────────────────────────────────────────────────────────────

def _hhll_anchored(bars: Bars, period: str, side: str) -> np.ndarray:
    """Re-anchoring AVWAP that follows the running HH (or LL) within each
    period (`day` or `week`). Whenever a new HH/LL prints, the VWAP restarts
    from that bar."""
    df = bars.df
    et = df.index.tz_convert(_ET)
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    price, vol = _hlc3_vol(df)
    n = len(df)
    out = np.full(n, np.nan)
    if period == 'day':
        keys = et.date
    elif period == 'week':
        iso = et.isocalendar()
        keys = list(zip(iso.year, iso.week))
    else:
        raise ValueError(period)

    ext_val  = None       # running extreme within current period
    anchor   = -1         # index of the current anchor bar
    cum_pv   = 0.0
    cum_v    = 0.0
    last_key = None
    for i in range(n):
        # Reset extreme on new period
        if keys[i] != last_key:
            last_key = keys[i]
            ext_val = None
            anchor  = -1

        # Detect new extreme
        new_ext = False
        if side == 'high':
            if ext_val is None or high[i] > ext_val:
                ext_val = high[i]
                new_ext = True
        else:  # 'low'
            if ext_val is None or low[i] < ext_val:
                ext_val = low[i]
                new_ext = True

        if new_ext:
            anchor = i
            cum_pv = price[i] * vol[i]
            cum_v  = vol[i]
        elif anchor >= 0:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]

        if anchor >= 0 and cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


@primitive(
    name='today_hh',
    group='vwap',
    description=('Anchored VWAP from today\'s intraday highest-high bar. '
                 'Re-anchors whenever a new HH prints during the ET day. '
                 'Matches Pine `vwap_hh` in the VWAP Cluster script.'),
    params=(),
    inputs=('bars',),
)
def today_hh(bars: Bars):
    return _hhll_anchored(bars, period='day', side='high')


@primitive(
    name='today_ll',
    group='vwap',
    description='AVWAP from today\'s intraday lowest-low. Re-anchors on new LL.',
    params=(),
    inputs=('bars',),
)
def today_ll(bars: Bars):
    return _hhll_anchored(bars, period='day', side='low')


@primitive(
    name='week_hh',
    group='vwap',
    description='AVWAP from this ISO-week\'s highest bar. Re-anchors on new HH.',
    params=(),
    inputs=('bars',),
)
def week_hh(bars: Bars):
    return _hhll_anchored(bars, period='week', side='high')


@primitive(
    name='week_ll',
    group='vwap',
    description='AVWAP from this ISO-week\'s lowest bar. Re-anchors on new LL.',
    params=(),
    inputs=('bars',),
)
def week_ll(bars: Bars):
    return _hhll_anchored(bars, period='week', side='low')


# ────────────────────────────────────────────────────────────
# Swing-pivot AVWAPs — anchored to confirmed ta.pivothigh / ta.pivotlow
# ────────────────────────────────────────────────────────────

def _confirmed_pivots(values: np.ndarray, lookback: int, side: str) -> np.ndarray:
    """Return the bar index of the anchor (pivot) for each output bar. -1
    until the first pivot is confirmed. Confirmation happens `lookback`
    bars *after* the pivot bar itself. Matches Pine `ta.pivothigh(v, N, N)`
    semantics: `v >= left values AND v > right values` (ties on the left
    still count as a pivot; the right side must be strictly less)."""
    n = len(values)
    anchor_idx = np.full(n, -1, dtype=np.int64)
    current = -1
    L = int(lookback)
    for i in range(n):
        if i >= 2 * L:
            centre = i - L
            v = values[centre]
            left_win  = values[centre - L: centre]
            right_win = values[centre + 1: centre + L + 1]
            if side == 'high':
                is_pivot = (v >= left_win.max()) and (v > right_win.max())
            else:
                is_pivot = (v <= left_win.min()) and (v < right_win.min())
            if is_pivot:
                current = centre
        anchor_idx[i] = current
    return anchor_idx


def _pivot_anchored_vwap(bars: Bars, lookback: int, side: str) -> np.ndarray:
    df = bars.df
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    price, vol = _hlc3_vol(df)
    values = high if side == 'high' else low
    anchor_idx = _confirmed_pivots(values, int(lookback), side)

    n = len(df)
    out = np.full(n, np.nan)
    cur_anchor = -1
    cum_pv = 0.0
    cum_v  = 0.0
    for i in range(n):
        a = anchor_idx[i]
        if a < 0:
            continue
        if a != cur_anchor:
            # Rebuild cumulative sums from the anchor forward
            cur_anchor = a
            cum_pv = float((price[a:i + 1] * vol[a:i + 1]).sum())
            cum_v  = float(vol[a:i + 1].sum())
        else:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


@primitive(
    name='swing_hh',
    group='vwap',
    description=('AVWAP anchored at the most recently *confirmed* swing '
                 'high — `ta.pivothigh(high, lookback, lookback)`. Confirmation '
                 'lags by `lookback` bars.'),
    params=(Param('lookback', 'int', default=25, min=2),),
    inputs=('bars',),
)
def swing_hh(bars: Bars, lookback: int):
    return _pivot_anchored_vwap(bars, lookback, 'high')


@primitive(
    name='swing_ll',
    group='vwap',
    description='AVWAP anchored at the most recently confirmed swing low.',
    params=(Param('lookback', 'int', default=25, min=2),),
    inputs=('bars',),
)
def swing_ll(bars: Bars, lookback: int):
    return _pivot_anchored_vwap(bars, lookback, 'low')


# ────────────────────────────────────────────────────────────
# Gap AVWAP
# ────────────────────────────────────────────────────────────

@primitive(
    name='gap',
    group='vwap',
    description=('AVWAP anchored at the most recent gap bar. A bar is a gap '
                 'if `|open - prev_close| >= atr(atr_length) * atr_mult`. '
                 'First bar in the feed is never a gap bar.'),
    params=(
        Param('atr_length', 'int',   default=14, min=1),
        Param('atr_mult',   'float', default=1.5, min=0.0),
    ),
    inputs=('bars',),
)
def gap(bars: Bars, atr_length: int, atr_mult: float):
    from qp.primitives.volatility import atr as _atr
    df = bars.df
    open_  = df['open'].to_numpy(dtype=float)
    close  = df['close'].to_numpy(dtype=float)
    price, vol = _hlc3_vol(df)
    a = _atr(bars, int(atr_length))
    prev_close = np.concatenate(([np.nan], close[:-1]))
    gap_size = np.abs(open_ - prev_close)
    is_gap = np.zeros(len(df), dtype=bool)
    for i in range(1, len(df)):
        if not np.isnan(a[i]) and gap_size[i] >= a[i] * float(atr_mult):
            is_gap[i] = True
    return _running_vwap(price, vol, is_gap)


# ────────────────────────────────────────────────────────────
# Last-hour AVWAPs
# ────────────────────────────────────────────────────────────

def _last_hour_anchored(bars: Bars, last_hour_start: int, side: str) -> np.ndarray:
    """Anchor at each new day, seeded with (yesterday's last-hour extreme
    bar price, its volume) plus today's first bar. Accumulate today onwards.
    Matches Pine `vwap_lhLL / vwap_lhHH` block."""
    df = bars.df
    et = df.index.tz_convert(_ET)
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    vol  = df['volume'].to_numpy(dtype=float)
    price, _ = _hlc3_vol(df)
    n = len(df)
    dates = et.date

    # Prev day's last-hour extreme (price + volume of that specific bar)
    lh_price = np.nan
    lh_vol   = np.nan
    prev_price = np.nan
    prev_vol   = np.nan

    out = np.full(n, np.nan)
    cum_pv = 0.0
    cum_v  = 0.0
    anchored = False
    last_date = None

    for i in range(n):
        ts = et[i]
        new_day = (dates[i] != last_date)
        if new_day:
            # roll: yesterday's LH extreme becomes "prev"
            prev_price = lh_price
            prev_vol   = lh_vol
            lh_price   = np.nan
            lh_vol     = np.nan
            last_date  = dates[i]
            # anchor for TODAY's cumulative VWAP
            if not (np.isnan(prev_price) or np.isnan(prev_vol)):
                cum_pv = prev_price * prev_vol + price[i] * vol[i]
                cum_v  = prev_vol + vol[i]
                anchored = True
            else:
                anchored = False
        elif anchored:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]

        # Update this day's last-hour running extreme
        in_last_hour = ts.hour >= int(last_hour_start) and ts.hour < 16
        if in_last_hour:
            if side == 'low':
                v = low[i]
                if np.isnan(lh_price) or v < lh_price:
                    lh_price = v
                    lh_vol   = vol[i]
            else:
                v = high[i]
                if np.isnan(lh_price) or v > lh_price:
                    lh_price = v
                    lh_vol   = vol[i]

        if anchored and cum_v > 0:
            out[i] = cum_pv / cum_v
    return out


@primitive(
    name='last_hour_hh',
    group='vwap',
    description=('AVWAP seeded each new ET day with yesterday\'s last-hour '
                 'highest-high bar (price*volume of that bar), then '
                 'accumulates today\'s bars. `last_hour_start` is the ET '
                 'hour when "last hour" begins (15 → 15:00 ET → 3-4 PM).'),
    params=(Param('last_hour_start', 'int', default=15, min=10, max=15),),
    inputs=('bars',),
)
def last_hour_hh(bars: Bars, last_hour_start: int):
    return _last_hour_anchored(bars, last_hour_start, 'high')


@primitive(
    name='last_hour_ll',
    group='vwap',
    description='AVWAP seeded from yesterday\'s last-hour lowest-low bar.',
    params=(Param('last_hour_start', 'int', default=15, min=10, max=15),),
    inputs=('bars',),
)
def last_hour_ll(bars: Bars, last_hour_start: int):
    return _last_hour_anchored(bars, last_hour_start, 'low')


# ────────────────────────────────────────────────────────────
# VWAP stdev bands (running variance around session VWAP)
# ────────────────────────────────────────────────────────────

@primitive(
    name='stdev_bands',
    group='vwap',
    description=('Session VWAP with ± mult * (running stdev of price around '
                 'the VWAP). Returns {mid, upper, lower}. This is the "SDV" '
                 'the BBZ script uses — not `volatility.stdev`, which is the '
                 'stdev of close over a fixed window.'),
    params=(Param('mult', 'float', default=1.0, min=0.0),),
    inputs=('bars',),
)
def stdev_bands(bars: Bars, mult: float):
    df = bars.df
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    n = len(df)
    mid = np.full(n, np.nan)
    dev = np.full(n, np.nan)
    cum_pv  = 0.0
    cum_pv2 = 0.0
    cum_v   = 0.0
    last_date = None
    for i in range(n):
        ts = et[i]
        rth = ((ts.hour > 9 or (ts.hour == 9 and ts.minute >= 30))
               and ts.hour < 16)
        if not rth:
            continue
        if ts.date() != last_date:
            cum_pv  = 0.0
            cum_pv2 = 0.0
            cum_v   = 0.0
            last_date = ts.date()
        cum_pv  += price[i] * vol[i]
        cum_pv2 += price[i] * price[i] * vol[i]
        cum_v   += vol[i]
        if cum_v > 0:
            m = cum_pv / cum_v
            var = cum_pv2 / cum_v - m * m
            if var < 0:
                var = 0.0
            mid[i] = m
            dev[i] = np.sqrt(var)
    m = float(mult)
    return {
        'middle': mid,
        'upper':  mid + m * dev,
        'lower':  mid - m * dev,
    }
