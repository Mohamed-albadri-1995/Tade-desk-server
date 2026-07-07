"""
VWAP primitives — session-anchored, calendar-anchored, event-anchored.

All use HLC/3 as price and volume-weighted accumulation.

`rth_only` (default True on the variants that accept it) restricts both
the anchor logic AND the accumulation to RTH bars (09:30-16:00 ET). This
matches what you see on a standard TradingView equities chart, whose
data excludes extended hours. Set rth_only=False to accumulate every bar
in the frame (TV chart with extended hours enabled). On daily+ frames
every bar counts as RTH.

Pine-parity note on `n_day`: Pine's `ta.vwap(hlc3, isNewDay and
dCount%N==0)` counts days from the start of the loaded chart history, so
its block phase is arbitrary — it changes with how many bars TV loaded.
qp counts from the start of the fetched window, so expect a possible
1-day phase offset vs TV. The math inside each block is identical.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive, Param
from qp.primitives.bars import Bars
from qp.primitives._session import ET as _ET, rth_pred, rth_positions, is_daily


def _hlc3_vol(df: pd.DataFrame):
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    close = df['close'].to_numpy(dtype=float)
    vol   = df['volume'].to_numpy(dtype=float)
    return (high + low + close) / 3.0, vol


def _running_vwap(price: np.ndarray, vol: np.ndarray,
                  anchor_mask: np.ndarray) -> np.ndarray:
    """Cumulative VWAP that resets on every True in `anchor_mask`.
    Before the first True, output is NaN (Pine shows an unanchored
    accumulate-from-history-start line there; qp deliberately shows
    nothing rather than a window-dependent artifact)."""
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


def _sub_frame(bars: Bars, rth_only: bool):
    """Return (sub_df, positions) where positions maps sub rows back to
    full-frame rows. With rth_only=False the sub frame IS the full frame."""
    df = bars.df
    if not rth_only:
        return df, np.arange(len(df))
    pos = rth_positions(df)
    return df.iloc[pos], pos


def _scatter(values: np.ndarray, positions: np.ndarray, n: int) -> np.ndarray:
    out = np.full(n, np.nan)
    if len(positions):
        out[positions] = values
    return out


# ────────────────────────────────────────────────────────────
# Session / N-day / weekly / monthly
# ────────────────────────────────────────────────────────────

@primitive(
    name='session',
    group='vwap',
    description=('Session VWAP for US equities. Resets at 09:30 ET, computes '
                 'only during RTH (09:30-16:00 ET), source = HLC/3. Matches '
                 'the TradingView built-in VWAP on an RTH chart. On daily+ '
                 'frames each bar is its own session (value = HLC/3). '
                 'Verify on 1m/5m/15m — Alpaca hourly bars are clock-aligned '
                 '(09:00) unlike TV\'s session-aligned (09:30) hourly bars.'),
    params=(),
    inputs=('bars',),
)
def session(bars: Bars):
    df = bars.df
    et = df.index.tz_convert(_ET)
    pred = rth_pred(df)
    price, vol = _hlc3_vol(df)
    n = len(df)
    out = np.full(n, np.nan)
    cum_pv = 0.0
    cum_v  = 0.0
    last_date = None
    for i in range(n):
        ts = et[i]
        if not pred(ts):
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
    description=('Rolling N-session VWAP. At any bar it is the volume-weighted '
                 'average price from the open of the session (N-1) sessions '
                 'ago through the current bar — so a 2-day VWAP always spans '
                 'yesterday + today. Only the first session of the fetched '
                 'window degenerates to the session VWAP (nothing earlier '
                 'exists). DEVIATES from the Pine `ta.vwap(hlc3, isNewDay and '
                 'dCount%N==0)` block-reset on purpose: that version resets '
                 'every N days with arbitrary phase and collapses to the plain '
                 'session VWAP on every reset day, which is useless on a live '
                 'watch. This rolling form is what "N-day VWAP" means to a '
                 'trader.'),
    params=(
        Param('n_days',   'int',  default=2, min=1),
        Param('rth_only', 'bool', default=True),
    ),
    inputs=('bars',),
)
def n_day(bars: Bars, n_days: int, rth_only: bool = True):
    df, pos = _sub_frame(bars, rth_only)
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    m = len(df)
    N = int(n_days)
    if m == 0:
        return _scatter(np.full(0, np.nan), pos, len(bars.df))

    # Session index per bar + first-bar position of each session.
    dates = et.date
    session_idx = np.empty(m, dtype=np.int64)
    session_start: list[int] = []
    si = -1
    last = None
    for i in range(m):
        if dates[i] != last:
            si += 1
            session_start.append(i)
            last = dates[i]
        session_idx[i] = si

    # Prefix sums so each bar's rolling window is O(1).
    pv = price * vol
    cpv = np.concatenate(([0.0], np.cumsum(pv)))
    cv  = np.concatenate(([0.0], np.cumsum(vol)))

    out = np.full(m, np.nan)
    for i in range(m):
        anchor_session = max(0, session_idx[i] - (N - 1))
        a = session_start[anchor_session]
        den = cv[i + 1] - cv[a]
        if den > 0:
            out[i] = (cpv[i + 1] - cpv[a]) / den
    return _scatter(out, pos, len(bars.df))


def _calendar_anchored(bars: Bars, period: str, rth_only: bool) -> np.ndarray:
    df, pos = _sub_frame(bars, rth_only)
    et = df.index.tz_convert(_ET)
    price, vol = _hlc3_vol(df)
    m = len(df)
    if period == 'week':
        iso = et.isocalendar()
        keys = list(zip(iso.year.to_numpy(), iso.week.to_numpy()))
    else:
        keys = [(t.year, t.month) for t in et]
    anchor = np.zeros(m, dtype=bool)
    last_key = None
    for i in range(m):
        if keys[i] != last_key:
            anchor[i] = True
            last_key = keys[i]
    return _scatter(_running_vwap(price, vol, anchor), pos, len(bars.df))


@primitive(
    name='weekly',
    group='vwap',
    description=('Weekly VWAP — resets on the first (RTH) bar of each ISO '
                 'week. Matches Pine `ta.vwap(hlc3, isNewWeek)` on an RTH '
                 'chart.'),
    params=(Param('rth_only', 'bool', default=True),),
    inputs=('bars',),
)
def weekly(bars: Bars, rth_only: bool = True):
    return _calendar_anchored(bars, 'week', rth_only)


@primitive(
    name='monthly',
    group='vwap',
    description=('Monthly VWAP — resets on the first (RTH) bar of each ET '
                 'calendar month. Matches Pine `ta.vwap(hlc3, isNewMonth)` '
                 'on an RTH chart.'),
    params=(Param('rth_only', 'bool', default=True),),
    inputs=('bars',),
)
def monthly(bars: Bars, rth_only: bool = True):
    return _calendar_anchored(bars, 'month', rth_only)


# ────────────────────────────────────────────────────────────
# User-anchored VWAP (Earnings / News VWAPs in the cluster script)
# ────────────────────────────────────────────────────────────

@primitive(
    name='anchored',
    group='vwap',
    description=('AVWAP from a user-chosen datetime — the cluster script\'s '
                 'Earnings/News VWAP A/B. Anchors at the first bar whose '
                 'timestamp >= `anchor` (Pine: `time >= i_earnDate and '
                 'time[1] < i_earnDate`). `anchor` is an ET datetime string, '
                 'e.g. "2026-07-01 09:30". Empty anchor → all NaN.'),
    params=(
        Param('anchor',   'str',  default='',
              description='ET datetime, e.g. 2026-07-01 09:30'),
        Param('rth_only', 'bool', default=True),
    ),
    inputs=('bars',),
)
def anchored(bars: Bars, anchor: str = '', rth_only: bool = True):
    n_full = len(bars.df)
    if not str(anchor).strip():
        return np.full(n_full, np.nan)
    ts = pd.Timestamp(str(anchor).strip())
    if ts.tz is None:
        ts = ts.tz_localize(_ET)
    df, pos = _sub_frame(bars, rth_only)
    price, vol = _hlc3_vol(df)
    mask = np.zeros(len(df), dtype=bool)
    hits = np.nonzero((df.index >= ts))[0]
    if len(hits):
        mask[hits[0]] = True
    return _scatter(_running_vwap(price, vol, mask), pos, n_full)


# ────────────────────────────────────────────────────────────
# Intraday / weekly anchored VWAPs from running HH / LL
# ────────────────────────────────────────────────────────────

def _hhll_anchored(bars: Bars, period: str, side: str, rth_only: bool) -> np.ndarray:
    """AVWAP that re-anchors whenever the period's running HH (or LL)
    prints a new extreme. Matches the Pine `vwap_hh / vwap_ll` blocks."""
    df, pos = _sub_frame(bars, rth_only)
    et = df.index.tz_convert(_ET)
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    price, vol = _hlc3_vol(df)
    m = len(df)
    out = np.full(m, np.nan)
    if period == 'day':
        keys = list(et.date)
    else:
        iso = et.isocalendar()
        keys = list(zip(iso.year.to_numpy(), iso.week.to_numpy()))

    ext_val  = None
    anchored = False
    cum_pv   = 0.0
    cum_v    = 0.0
    last_key = None
    for i in range(m):
        if keys[i] != last_key:
            last_key = keys[i]
            ext_val = None
            anchored = False

        new_ext = False
        if side == 'high':
            if ext_val is None or high[i] > ext_val:
                ext_val = high[i]
                new_ext = True
        else:
            if ext_val is None or low[i] < ext_val:
                ext_val = low[i]
                new_ext = True

        if new_ext:
            cum_pv = price[i] * vol[i]
            cum_v  = vol[i]
            anchored = True
        elif anchored:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]

        if anchored and cum_v > 0:
            out[i] = cum_pv / cum_v
    return _scatter(out, pos, len(bars.df))


@primitive(
    name='today_hh',
    group='vwap',
    description=('AVWAP from today\'s intraday highest-high bar. Re-anchors '
                 'whenever a new HH prints during the ET day. Matches the '
                 'VWAP-Cluster script\'s `vwap_hh`.'),
    params=(Param('rth_only', 'bool', default=True),),
    inputs=('bars',),
)
def today_hh(bars: Bars, rth_only: bool = True):
    return _hhll_anchored(bars, 'day', 'high', rth_only)


@primitive(
    name='today_ll',
    group='vwap',
    description='AVWAP from today\'s intraday lowest-low. Re-anchors on new LL.',
    params=(Param('rth_only', 'bool', default=True),),
    inputs=('bars',),
)
def today_ll(bars: Bars, rth_only: bool = True):
    return _hhll_anchored(bars, 'day', 'low', rth_only)


@primitive(
    name='week_hh',
    group='vwap',
    description='AVWAP from this ISO-week\'s highest bar. Re-anchors on new HH.',
    params=(Param('rth_only', 'bool', default=True),),
    inputs=('bars',),
)
def week_hh(bars: Bars, rth_only: bool = True):
    return _hhll_anchored(bars, 'week', 'high', rth_only)


@primitive(
    name='week_ll',
    group='vwap',
    description='AVWAP from this ISO-week\'s lowest bar. Re-anchors on new LL.',
    params=(Param('rth_only', 'bool', default=True),),
    inputs=('bars',),
)
def week_ll(bars: Bars, rth_only: bool = True):
    return _hhll_anchored(bars, 'week', 'low', rth_only)


# ────────────────────────────────────────────────────────────
# Swing-pivot AVWAPs — anchored at confirmed ta.pivothigh / ta.pivotlow
# ────────────────────────────────────────────────────────────

def _confirmed_pivots(values: np.ndarray, lookback: int, side: str) -> np.ndarray:
    """Anchor (pivot) bar index for each output bar; -1 until the first
    pivot confirms. Pine tie semantics: `v >= left values AND v > right
    values` for highs (mirrored for lows) — left ties allowed, right side
    strictly beyond. Confirmation lags the pivot by `lookback` bars."""
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


def _pivot_anchored_vwap(bars: Bars, lookback: int, side: str,
                         rth_only: bool) -> np.ndarray:
    df, pos = _sub_frame(bars, rth_only)
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    price, vol = _hlc3_vol(df)
    values = high if side == 'high' else low
    anchor_idx = _confirmed_pivots(values, int(lookback), side)

    m = len(df)
    out = np.full(m, np.nan)
    cur_anchor = -1
    cum_pv = 0.0
    cum_v  = 0.0
    for i in range(m):
        a = anchor_idx[i]
        if a < 0:
            continue
        if a != cur_anchor:
            cur_anchor = a
            cum_pv = float((price[a:i + 1] * vol[a:i + 1]).sum())
            cum_v  = float(vol[a:i + 1].sum())
        else:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]
        if cum_v > 0:
            out[i] = cum_pv / cum_v
    return _scatter(out, pos, len(bars.df))


@primitive(
    name='swing_hh',
    group='vwap',
    description=('AVWAP anchored at the most recently *confirmed* swing high '
                 '— `ta.pivothigh(high, lookback, lookback)`. Confirmation '
                 'lags by `lookback` bars, matching Pine.'),
    params=(
        Param('lookback', 'int',  default=25, min=2),
        Param('rth_only', 'bool', default=True),
    ),
    inputs=('bars',),
)
def swing_hh(bars: Bars, lookback: int, rth_only: bool = True):
    return _pivot_anchored_vwap(bars, lookback, 'high', rth_only)


@primitive(
    name='swing_ll',
    group='vwap',
    description='AVWAP anchored at the most recently confirmed swing low.',
    params=(
        Param('lookback', 'int',  default=25, min=2),
        Param('rth_only', 'bool', default=True),
    ),
    inputs=('bars',),
)
def swing_ll(bars: Bars, lookback: int, rth_only: bool = True):
    return _pivot_anchored_vwap(bars, lookback, 'low', rth_only)


# ────────────────────────────────────────────────────────────
# Gap AVWAP
# ────────────────────────────────────────────────────────────

@primitive(
    name='gap',
    group='vwap',
    description=('AVWAP anchored at the most recent gap bar: '
                 '`|open - prev_close| >= atr(atr_length) * atr_mult`. With '
                 'rth_only (default) prev_close is the previous RTH bar, so '
                 'the 09:30 bar carries the full overnight gap — matching '
                 'Pine on an RTH chart.'),
    params=(
        Param('atr_length', 'int',   default=14, min=1),
        Param('atr_mult',   'float', default=1.5, min=0.0),
        Param('rth_only',   'bool',  default=True),
    ),
    inputs=('bars',),
)
def gap(bars: Bars, atr_length: int, atr_mult: float, rth_only: bool = True):
    from qp.primitives.volatility import atr as _atr
    df, pos = _sub_frame(bars, rth_only)
    sub = Bars(df=df)
    open_  = df['open'].to_numpy(dtype=float)
    close  = df['close'].to_numpy(dtype=float)
    price, vol = _hlc3_vol(df)
    a = _atr(sub, int(atr_length))
    m = len(df)
    prev_close = np.concatenate(([np.nan], close[:-1]))
    gap_size = np.abs(open_ - prev_close)
    is_gap = np.zeros(m, dtype=bool)
    for i in range(1, m):
        if not np.isnan(a[i]) and gap_size[i] >= a[i] * float(atr_mult):
            is_gap[i] = True
    return _scatter(_running_vwap(price, vol, is_gap), pos, len(bars.df))


# ────────────────────────────────────────────────────────────
# Last-hour AVWAPs
# ────────────────────────────────────────────────────────────

def _last_hour_anchored(bars: Bars, last_hour_start: int, side: str,
                        rth_only: bool) -> np.ndarray:
    """Anchor at each new day, seeded with yesterday's last-hour extreme
    bar (its price*volume) plus today's first bar; accumulate today
    onwards. Matches Pine `vwap_lhLL / vwap_lhHH`. qp bounds "last hour"
    to < 16:00 ET; the Pine `barHour >= start` alone would leak into
    after-hours on extended charts."""
    df, pos = _sub_frame(bars, rth_only)
    et = df.index.tz_convert(_ET)
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    vol  = df['volume'].to_numpy(dtype=float)
    price, _ = _hlc3_vol(df)
    m = len(df)
    dates = et.date

    lh_price = np.nan
    lh_vol   = np.nan
    out = np.full(m, np.nan)
    cum_pv = 0.0
    cum_v  = 0.0
    anchored = False
    last_date = None

    for i in range(m):
        ts = et[i]
        if dates[i] != last_date:
            prev_price, prev_vol = lh_price, lh_vol
            lh_price = np.nan
            lh_vol   = np.nan
            last_date = dates[i]
            if not (np.isnan(prev_price) or np.isnan(prev_vol)):
                cum_pv = prev_price * prev_vol + price[i] * vol[i]
                cum_v  = prev_vol + vol[i]
                anchored = True
            else:
                anchored = False
        elif anchored:
            cum_pv += price[i] * vol[i]
            cum_v  += vol[i]

        if int(last_hour_start) <= ts.hour < 16:
            if side == 'low':
                if np.isnan(lh_price) or low[i] < lh_price:
                    lh_price = low[i]
                    lh_vol   = vol[i]
            else:
                if np.isnan(lh_price) or high[i] > lh_price:
                    lh_price = high[i]
                    lh_vol   = vol[i]

        if anchored and cum_v > 0:
            out[i] = cum_pv / cum_v
    return _scatter(out, pos, len(bars.df))


@primitive(
    name='last_hour_hh',
    group='vwap',
    description=('AVWAP seeded each new ET day with yesterday\'s last-hour '
                 '(15:00-16:00 ET by default) highest-high bar, then '
                 'accumulating today\'s bars.'),
    params=(
        Param('last_hour_start', 'int',  default=15, min=10, max=15),
        Param('rth_only',        'bool', default=True),
    ),
    inputs=('bars',),
)
def last_hour_hh(bars: Bars, last_hour_start: int, rth_only: bool = True):
    return _last_hour_anchored(bars, last_hour_start, 'high', rth_only)


@primitive(
    name='last_hour_ll',
    group='vwap',
    description='AVWAP seeded from yesterday\'s last-hour lowest-low bar.',
    params=(
        Param('last_hour_start', 'int',  default=15, min=10, max=15),
        Param('rth_only',        'bool', default=True),
    ),
    inputs=('bars',),
)
def last_hour_ll(bars: Bars, last_hour_start: int, rth_only: bool = True):
    return _last_hour_anchored(bars, last_hour_start, 'low', rth_only)


# ────────────────────────────────────────────────────────────
# VWAP stdev bands (running variance around session VWAP)
# ────────────────────────────────────────────────────────────

@primitive(
    name='stdev_bands',
    group='vwap',
    description=('Session VWAP with ± mult * (running stdev of price around '
                 'the VWAP). Returns {middle, upper, lower}. This is the '
                 'BBZ script\'s `bz_vwap_stdev` ("SDV") — NOT the same as '
                 '`volatility.stdev`, which is a rolling-window stdev of '
                 'close.'),
    params=(Param('mult', 'float', default=1.0, min=0.0),),
    inputs=('bars',),
    outputs=('middle', 'upper', 'lower'),
)
def stdev_bands(bars: Bars, mult: float):
    df = bars.df
    et = df.index.tz_convert(_ET)
    pred = rth_pred(df)
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
        if not pred(ts):
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
            m_ = cum_pv / cum_v
            var = cum_pv2 / cum_v - m_ * m_
            mid[i] = m_
            dev[i] = np.sqrt(var) if var > 0 else 0.0
    k = float(mult)
    return {
        'middle': mid,
        'upper':  mid + k * dev,
        'lower':  mid - k * dev,
    }
