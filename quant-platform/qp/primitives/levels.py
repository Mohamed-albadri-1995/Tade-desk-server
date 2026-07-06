"""
Horizontal-level primitives.

Every primitive returns an array the same length as bars. The value is the
level (a scalar per bar) — plotted as a step-line by the compare tool.

Session definitions (America/New_York):
  RTH        09:30 - 16:00
  Premarket  04:00 - 09:30
  Overnight  18:00 (prev day) - 09:30 (current day)

Weekly / monthly aggregates use RTH bars only — that matches TradingView's
weekly/monthly bars for equities (standard chart data excludes extended
hours), so `weekly_open` is Monday's 09:30 open, not the 04:00 premarket
print. Values are held flat across non-RTH bars once the period has data.

Daily+ frames: every bar counts as RTH (each daily bar IS the RTH
aggregate), so prev_day/weekly/monthly levels work on 1d charts too.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive
from qp.primitives.bars import Bars
from qp.primitives._session import (
    ET as _ET, in_rth as _in_rth, in_premarket as _in_premarket, rth_pred,
)


# ────────────────────────────────────────────────────────────
# Helpers — group bars by session and compute per-session aggregates
# ────────────────────────────────────────────────────────────

def _running_session_extreme(df, session_pred, which: str):
    """For each bar, the running max/min/open of the session the bar
    belongs to; NaN outside sessions. A session ends when the predicate
    goes False OR the ET date changes — the date check matters for feeds
    with no bars between sessions (RTH-only frames, daily frames), where
    yesterday's last bar and today's first are adjacent."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    n = len(df)
    out = np.full(n, np.nan)
    in_sess = False
    last_date = None
    cur_high = np.nan
    cur_low  = np.nan
    cur_open = np.nan
    for i in range(n):
        pred = session_pred(et[i])
        d = et[i].date()
        if pred and (not in_sess or d != last_date):
            cur_high = high[i]
            cur_low  = low[i]
            cur_open = openp[i]
        elif pred:
            cur_high = max(cur_high, high[i])
            cur_low  = min(cur_low,  low[i])
        in_sess = pred
        if pred:
            last_date = d
            if which == 'high':   out[i] = cur_high
            elif which == 'low':  out[i] = cur_low
            elif which == 'open': out[i] = cur_open
    return out


def _daily_agg(df: pd.DataFrame, session_pred, which: str, ago: int = 0):
    """For each bar, the aggregated value from N sessions ago (0 = the
    bar's own session). With ago=0, premarket bars of a historical frame
    see the day's value early (display convenience); in live use the frame
    ends at "now" so nothing leaks from the future."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    close = df['close'].to_numpy(dtype=float)
    n = len(df)
    dates = et.date

    per_day: dict = {}
    order: list = []
    for i in range(n):
        if not session_pred(et[i]):
            continue
        d = dates[i]
        if d not in per_day:
            per_day[d] = {'high': high[i], 'low': low[i],
                          'open': openp[i], 'close': close[i]}
            order.append(d)
        else:
            per_day[d]['high']  = max(per_day[d]['high'], high[i])
            per_day[d]['low']   = min(per_day[d]['low'],  low[i])
            per_day[d]['close'] = close[i]   # last session bar wins

    day_to_pos = {d: k for k, d in enumerate(order)}
    out = np.full(n, np.nan)
    for i in range(n):
        d = dates[i]
        if d not in day_to_pos:
            continue
        pos = day_to_pos[d] - int(ago)
        if pos < 0:
            continue
        out[i] = per_day[order[pos]][which]
    return out


# ────────────────────────────────────────────────────────────
# Previous day / today
# ────────────────────────────────────────────────────────────

@primitive(name='prev_day_high', group='levels',
           description='Yesterday\'s RTH high, held constant across today.',
           params=(), inputs=('bars',))
def prev_day_high(bars: Bars):
    return _daily_agg(bars.df, rth_pred(bars.df), 'high', ago=1)


@primitive(name='prev_day_low', group='levels',
           description='Yesterday\'s RTH low.',
           params=(), inputs=('bars',))
def prev_day_low(bars: Bars):
    return _daily_agg(bars.df, rth_pred(bars.df), 'low', ago=1)


@primitive(name='prev_day_open', group='levels',
           description='Yesterday\'s RTH open.',
           params=(), inputs=('bars',))
def prev_day_open(bars: Bars):
    return _daily_agg(bars.df, rth_pred(bars.df), 'open', ago=1)


@primitive(name='day_open', group='levels',
           description='Today\'s RTH open (09:30 ET bar). NaN before today\'s open exists.',
           params=(), inputs=('bars',))
def day_open(bars: Bars):
    return _daily_agg(bars.df, rth_pred(bars.df), 'open', ago=0)


@primitive(name='today_high', group='levels',
           description='Today\'s running RTH high so far.',
           params=(), inputs=('bars',))
def today_high(bars: Bars):
    return _running_session_extreme(bars.df, rth_pred(bars.df), 'high')


@primitive(name='today_low', group='levels',
           description='Today\'s running RTH low so far.',
           params=(), inputs=('bars',))
def today_low(bars: Bars):
    return _running_session_extreme(bars.df, rth_pred(bars.df), 'low')


# ────────────────────────────────────────────────────────────
# Premarket / Overnight
# ────────────────────────────────────────────────────────────

def _pm_level(bars: Bars, which: str) -> np.ndarray:
    df = bars.df
    et = df.index.tz_convert(_ET)
    n = len(df)
    running = _running_session_extreme(df, _in_premarket, which)
    out = np.full(n, np.nan)
    last_val = np.nan
    last_date = None
    for i in range(n):
        d = et[i].date()
        if d != last_date:
            last_val = np.nan
            last_date = d
        if _in_premarket(et[i]):
            last_val = running[i]
        out[i] = last_val
    return out


@primitive(name='pm_high', group='levels',
           description=('Premarket high (04:00-09:30 ET). Running during PM; '
                        'frozen through the rest of the day. Needs extended-'
                        'hours bars in the feed (Alpaca IEX includes them).'),
           params=(), inputs=('bars',))
def pm_high(bars: Bars):
    return _pm_level(bars, 'high')


@primitive(name='pm_low', group='levels',
           description='Premarket low (04:00-09:30 ET), frozen after 09:30.',
           params=(), inputs=('bars',))
def pm_low(bars: Bars):
    return _pm_level(bars, 'low')


def _overnight_extreme(df: pd.DataFrame, which: str):
    """Overnight = 18:00 prev calendar day → 09:30 today ET. Running during
    the ON window, frozen from 09:30 until 18:00 starts the next one."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    n = len(df)
    on_date = []
    in_on = []
    for i in range(n):
        t = et[i]
        pred = (t.hour >= 18) or (t.hour < 9) or (t.hour == 9 and t.minute < 30)
        in_on.append(pred)
        if t.hour >= 18:
            on_date.append((t + pd.Timedelta(days=1)).date())
        else:
            on_date.append(t.date())

    running = np.full(n, np.nan)
    cur_date = None
    cur_val  = np.nan
    for i in range(n):
        if not in_on[i]:
            continue
        d = on_date[i]
        v = high[i] if which == 'high' else low[i]
        if d != cur_date:
            cur_val = v
            cur_date = d
        else:
            cur_val = max(cur_val, v) if which == 'high' else min(cur_val, v)
        running[i] = cur_val

    out = np.full(n, np.nan)
    holds: dict = {}
    for i in range(n):
        if in_on[i]:
            holds[on_date[i]] = running[i]
            out[i] = running[i]
        else:
            d = et[i].date()
            if d in holds:
                out[i] = holds[d]
    return out


@primitive(name='overnight_high', group='levels',
           description=('Overnight high (18:00 prev day - 09:30 today ET). '
                        'Running during ON; frozen through the trading day.'),
           params=(), inputs=('bars',))
def overnight_high(bars: Bars):
    return _overnight_extreme(bars.df, 'high')


@primitive(name='overnight_low', group='levels',
           description='Overnight low (18:00 prev day - 09:30 today ET).',
           params=(), inputs=('bars',))
def overnight_low(bars: Bars):
    return _overnight_extreme(bars.df, 'low')


# ────────────────────────────────────────────────────────────
# Weekly / monthly / monday
# ────────────────────────────────────────────────────────────

def _period_keys(et, period: str):
    if period == 'week':
        iso = et.isocalendar()
        return list(zip(iso.year.to_numpy(), iso.week.to_numpy()))
    if period == 'month':
        return [(t.year, t.month) for t in et]
    if period == 'year':
        return [(t.year,) for t in et]
    raise ValueError(period)


def _period_agg(df: pd.DataFrame, which: str, period: str):
    """Running RTH high/low/open per calendar period (`week` / `month` /
    `year`). RTH-only matches TV weekly/monthly equity bars; the current
    value is held on non-RTH bars once the period has RTH data."""
    et = df.index.tz_convert(_ET)
    pred = rth_pred(df)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    n = len(df)
    out = np.full(n, np.nan)
    keys = _period_keys(et, period)
    cur_key = None
    cur_high = np.nan; cur_low = np.nan; cur_open = np.nan
    for i in range(n):
        if keys[i] != cur_key:
            cur_key = keys[i]
            cur_high = np.nan; cur_low = np.nan; cur_open = np.nan
        if pred(et[i]):
            if np.isnan(cur_open):
                cur_open = openp[i]
                cur_high = high[i]
                cur_low  = low[i]
            else:
                cur_high = max(cur_high, high[i])
                cur_low  = min(cur_low,  low[i])
        if which == 'high':   out[i] = cur_high
        elif which == 'low':  out[i] = cur_low
        elif which == 'open': out[i] = cur_open
    return out


@primitive(name='weekly_open', group='levels',
           description='This ISO week\'s RTH open (Monday 09:30 ET bar).',
           params=(), inputs=('bars',))
def weekly_open(bars: Bars):
    return _period_agg(bars.df, 'open', 'week')


@primitive(name='weekly_high', group='levels',
           description='This ISO week\'s running RTH high.',
           params=(), inputs=('bars',))
def weekly_high(bars: Bars):
    return _period_agg(bars.df, 'high', 'week')


@primitive(name='weekly_low', group='levels',
           description='This ISO week\'s running RTH low.',
           params=(), inputs=('bars',))
def weekly_low(bars: Bars):
    return _period_agg(bars.df, 'low', 'week')


@primitive(name='monthly_open', group='levels',
           description='This ET month\'s RTH open.',
           params=(), inputs=('bars',))
def monthly_open(bars: Bars):
    return _period_agg(bars.df, 'open', 'month')


@primitive(name='monthly_high', group='levels',
           description='This ET month\'s running RTH high.',
           params=(), inputs=('bars',))
def monthly_high(bars: Bars):
    return _period_agg(bars.df, 'high', 'month')


@primitive(name='monthly_low', group='levels',
           description='This ET month\'s running RTH low.',
           params=(), inputs=('bars',))
def monthly_low(bars: Bars):
    return _period_agg(bars.df, 'low', 'month')


def _prev_period_val(df: pd.DataFrame, which: str, period: str) -> np.ndarray:
    """The COMPLETED previous period's open/high/low at every bar of the
    current period (the S/R script's PWO / PMO / PYO lines). Causal — the
    previous period is finished by the time any current-period bar prints.
    The fetch window must reach back into the previous period."""
    et = df.index.tz_convert(_ET)
    pred = rth_pred(df)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    n = len(df)
    keys = _period_keys(et, period)

    per: dict = {}
    order: list = []
    for i in range(n):
        if not pred(et[i]):
            continue
        k = keys[i]
        if k not in per:
            per[k] = {'open': openp[i], 'high': high[i], 'low': low[i]}
            order.append(k)
        else:
            per[k]['high'] = max(per[k]['high'], high[i])
            per[k]['low']  = min(per[k]['low'],  low[i])

    key_pos = {k: j for j, k in enumerate(order)}
    out = np.full(n, np.nan)
    for i in range(n):
        k = keys[i]
        if k not in key_pos:
            continue
        j = key_pos[k] - 1
        if j >= 0:
            out[i] = per[order[j]][which]
    return out


@primitive(name='yearly_open', group='levels',
           description='This year\'s RTH open (first RTH bar of the year — the S/R script\'s YO line). The fetch window must include January for a real value.',
           params=(), inputs=('bars',))
def yearly_open(bars: Bars):
    return _period_agg(bars.df, 'open', 'year')


@primitive(name='prev_week_open', group='levels',
           description='Previous ISO week\'s RTH open (PWO). Fetch window must reach into last week.',
           params=(), inputs=('bars',))
def prev_week_open(bars: Bars):
    return _prev_period_val(bars.df, 'open', 'week')


@primitive(name='prev_month_open', group='levels',
           description='Previous month\'s RTH open (PMO). Fetch window must reach into last month.',
           params=(), inputs=('bars',))
def prev_month_open(bars: Bars):
    return _prev_period_val(bars.df, 'open', 'month')


@primitive(name='prev_year_open', group='levels',
           description='Previous year\'s RTH open (PYO). Fetch window must reach into last year.',
           params=(), inputs=('bars',))
def prev_year_open(bars: Bars):
    return _prev_period_val(bars.df, 'open', 'year')


def _monday_extreme(df: pd.DataFrame, which: str) -> np.ndarray:
    et = df.index.tz_convert(_ET)
    pred = rth_pred(df)
    iso = et.isocalendar()
    years = iso.year.to_numpy()
    weeks = iso.week.to_numpy()
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    n = len(df)
    per_week: dict = {}
    for i in range(n):
        t = et[i]
        if t.dayofweek == 0 and pred(t):
            key = (int(years[i]), int(weeks[i]))
            v = high[i] if which == 'high' else low[i]
            if key not in per_week:
                per_week[key] = v
            else:
                per_week[key] = max(per_week[key], v) if which == 'high' else min(per_week[key], v)
    out = np.full(n, np.nan)
    for i in range(n):
        key = (int(years[i]), int(weeks[i]))
        if key in per_week:
            out[i] = per_week[key]
    return out


@primitive(name='monday_high', group='levels',
           description=('This ISO week\'s Monday RTH high — constant across '
                        'the whole week. NaN until Monday RTH has data.'),
           params=(), inputs=('bars',))
def monday_high(bars: Bars):
    return _monday_extreme(bars.df, 'high')


@primitive(name='monday_low', group='levels',
           description='This ISO week\'s Monday RTH low.',
           params=(), inputs=('bars',))
def monday_low(bars: Bars):
    return _monday_extreme(bars.df, 'low')
