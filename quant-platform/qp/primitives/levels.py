"""
Horizontal-level primitives.

Every primitive returns an array the same length as bars. The value is the
level (a scalar per bar) — plotted as a step-line by the compare tool.

Session definitions (America/New_York):
  RTH        09:30 – 16:00
  Premarket  04:00 – 09:30
  Overnight  18:00 (prev day) – 09:30 (current day)

Weekly / monthly extremes cover ALL bars in the period (RTH + extended),
matching TradingView's `request.security(sym, "W", high, ...)` which
returns the exchange-session high.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive
from qp.primitives.bars import Bars

_ET = 'America/New_York'


# ────────────────────────────────────────────────────────────
# Helpers — group bars by session and compute per-session aggregates
# ────────────────────────────────────────────────────────────

def _in_rth(ts) -> bool:
    return ((ts.hour > 9 or (ts.hour == 9 and ts.minute >= 30))
            and ts.hour < 16)


def _in_premarket(ts) -> bool:
    return ts.hour >= 4 and (ts.hour < 9 or (ts.hour == 9 and ts.minute < 30))


def _in_overnight(ts) -> bool:
    # 18:00–24:00 previous calendar day OR 00:00–09:30 current
    return (ts.hour >= 18) or (ts.hour < 9) or (ts.hour == 9 and ts.minute < 30)


def _running_session_extreme(df, session_pred, which: str):
    """For each bar, return the running max/min/open of the current session
    the bar belongs to (as defined by consecutive True in session_pred);
    NaN for bars outside a session."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    n = len(df)
    out = np.full(n, np.nan)
    in_sess = False
    cur_high  = np.nan
    cur_low   = np.nan
    cur_open  = np.nan
    for i in range(n):
        pred = session_pred(et[i])
        if pred and not in_sess:
            # session begins
            cur_high = high[i]
            cur_low  = low[i]
            cur_open = openp[i]
            in_sess = True
        elif pred:
            cur_high = max(cur_high, high[i])
            cur_low  = min(cur_low,  low[i])
        elif not pred:
            in_sess = False
        if pred:
            if which == 'high':  out[i] = cur_high
            elif which == 'low': out[i] = cur_low
            elif which == 'open':out[i] = cur_open
    return out


def _hold_last(arr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Return arr but with values held forward outside `mask` — i.e. once a
    session ends, the last value of that session persists into the next
    non-session bars until either a new session starts (mask flips True
    again) or the next reset day."""
    out = np.full(len(arr), np.nan)
    last = np.nan
    for i in range(len(arr)):
        if mask[i]:
            last = arr[i]
        out[i] = last
    return out


def _daily_agg(df: pd.DataFrame, session_pred, which: str, ago: int = 0):
    """For each bar, look up the aggregated value from N sessions ago (0 =
    today's completed session). Returns NaN until enough sessions exist."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    n = len(df)
    dates = et.date

    # Build a per-day aggregate dict
    per_day: dict = {}
    order: list = []
    for i in range(n):
        if not session_pred(et[i]):
            continue
        d = dates[i]
        if d not in per_day:
            per_day[d] = {'high': high[i], 'low': low[i], 'open': openp[i]}
            order.append(d)
        else:
            per_day[d]['high'] = max(per_day[d]['high'], high[i])
            per_day[d]['low']  = min(per_day[d]['low'],  low[i])

    day_to_pos = {d: k for k, d in enumerate(order)}
    out = np.full(n, np.nan)
    for i in range(n):
        d = dates[i]
        if d not in day_to_pos:
            continue
        pos = day_to_pos[d] - int(ago)
        if pos < 0:
            continue
        target = order[pos]
        out[i] = per_day[target][which]
    return out


# ────────────────────────────────────────────────────────────
# Previous day / today
# ────────────────────────────────────────────────────────────

@primitive(name='prev_day_high', group='levels',
           description='Yesterday\'s RTH high, held constant across today.',
           params=(), inputs=('bars',))
def prev_day_high(bars: Bars):
    return _daily_agg(bars.df, _in_rth, 'high', ago=1)


@primitive(name='prev_day_low', group='levels',
           description='Yesterday\'s RTH low.',
           params=(), inputs=('bars',))
def prev_day_low(bars: Bars):
    return _daily_agg(bars.df, _in_rth, 'low', ago=1)


@primitive(name='prev_day_open', group='levels',
           description='Yesterday\'s RTH open.',
           params=(), inputs=('bars',))
def prev_day_open(bars: Bars):
    return _daily_agg(bars.df, _in_rth, 'open', ago=1)


@primitive(name='day_open', group='levels',
           description='Today\'s RTH open (constant during today\'s bars, NaN before RTH).',
           params=(), inputs=('bars',))
def day_open(bars: Bars):
    return _daily_agg(bars.df, _in_rth, 'open', ago=0)


@primitive(name='today_high', group='levels',
           description='Today\'s running RTH high so far.',
           params=(), inputs=('bars',))
def today_high(bars: Bars):
    return _running_session_extreme(bars.df, _in_rth, 'high')


@primitive(name='today_low', group='levels',
           description='Today\'s running RTH low so far.',
           params=(), inputs=('bars',))
def today_low(bars: Bars):
    return _running_session_extreme(bars.df, _in_rth, 'low')


# ────────────────────────────────────────────────────────────
# Premarket / Overnight
# ────────────────────────────────────────────────────────────

@primitive(name='pm_high', group='levels',
           description=('Premarket high (04:00–09:30 ET). During PM: running '
                        'max. During and after RTH: frozen at PM close.'),
           params=(), inputs=('bars',))
def pm_high(bars: Bars):
    df = bars.df
    et = df.index.tz_convert(_ET)
    n = len(df)
    running = _running_session_extreme(df, _in_premarket, 'high')
    mask = np.array([_in_premarket(t) for t in et], dtype=bool)
    # Hold last PM value forward within the same ET day
    out = np.full(n, np.nan)
    last_val = np.nan
    last_date = None
    for i in range(n):
        d = et[i].date()
        if d != last_date:
            last_val = np.nan
            last_date = d
        if mask[i]:
            last_val = running[i]
        out[i] = last_val
    return out


@primitive(name='pm_low', group='levels',
           description='Premarket low (04:00–09:30 ET), frozen after 09:30.',
           params=(), inputs=('bars',))
def pm_low(bars: Bars):
    df = bars.df
    et = df.index.tz_convert(_ET)
    n = len(df)
    running = _running_session_extreme(df, _in_premarket, 'low')
    mask = np.array([_in_premarket(t) for t in et], dtype=bool)
    out = np.full(n, np.nan)
    last_val = np.nan
    last_date = None
    for i in range(n):
        d = et[i].date()
        if d != last_date:
            last_val = np.nan
            last_date = d
        if mask[i]:
            last_val = running[i]
        out[i] = last_val
    return out


def _overnight_extreme(df: pd.DataFrame, which: str):
    """Overnight = 18:00 prev calendar day → 09:30 today ET. Value is
    running during the ON window, then frozen from 09:30 through 18:00
    that day. Uses "logical ON date" = the ET date at 09:30 belonging to
    that overnight session."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    n = len(df)
    # Assign each bar an "ON-session-of" date. A bar at 22:00 on 2026-07-05
    # belongs to the ON session that ends at 09:30 on 2026-07-06.
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

    # First pass: per (ON date) compute running high/low sequentially
    running = np.full(n, np.nan)
    cur_date = None
    cur_val  = np.nan
    for i in range(n):
        if not in_on[i]:
            continue
        d = on_date[i]
        if d != cur_date:
            cur_val = high[i] if which == 'high' else low[i]
            cur_date = d
        else:
            v = high[i] if which == 'high' else low[i]
            cur_val = max(cur_val, v) if which == 'high' else min(cur_val, v)
        running[i] = cur_val

    # Second pass: for bars OUTSIDE ON, hold the last completed ON value
    # for that day (until 18:00, when a new ON begins).
    out = np.full(n, np.nan)
    holds: dict = {}  # ON date → final value
    for i in range(n):
        if in_on[i]:
            holds[on_date[i]] = running[i]
            out[i] = running[i]
        else:
            # Non-ON bar (RTH or 16:00-18:00 gap) — use today's completed ON
            d = et[i].date()
            if d in holds:
                out[i] = holds[d]
    return out


@primitive(name='overnight_high', group='levels',
           description=('Overnight high (18:00 prev day – 09:30 today ET). '
                        'Running during ON; frozen through RTH and until 18:00 '
                        'when the next ON session begins.'),
           params=(), inputs=('bars',))
def overnight_high(bars: Bars):
    return _overnight_extreme(bars.df, 'high')


@primitive(name='overnight_low', group='levels',
           description='Overnight low (18:00 prev day – 09:30 today ET).',
           params=(), inputs=('bars',))
def overnight_low(bars: Bars):
    return _overnight_extreme(bars.df, 'low')


# ────────────────────────────────────────────────────────────
# Weekly / monthly / monday
# ────────────────────────────────────────────────────────────

def _period_agg(df: pd.DataFrame, which: str, period: str):
    """Running high/low/open per calendar period (`week` or `month`), all bars."""
    et = df.index.tz_convert(_ET)
    high  = df['high'].to_numpy(dtype=float)
    low   = df['low'].to_numpy(dtype=float)
    openp = df['open'].to_numpy(dtype=float)
    n = len(df)
    out = np.full(n, np.nan)
    if period == 'week':
        iso = et.isocalendar()
        keys = list(zip(iso.year, iso.week))
    else:  # 'month'
        keys = [(t.year, t.month) for t in et]
    cur_key = None
    cur_high = np.nan; cur_low = np.nan; cur_open = np.nan
    for i in range(n):
        if keys[i] != cur_key:
            cur_key = keys[i]
            cur_high = high[i]
            cur_low  = low[i]
            cur_open = openp[i]
        else:
            cur_high = max(cur_high, high[i])
            cur_low  = min(cur_low,  low[i])
        if which == 'high':  out[i] = cur_high
        elif which == 'low': out[i] = cur_low
        elif which == 'open':out[i] = cur_open
    return out


@primitive(name='weekly_open', group='levels',
           description='This ISO week\'s open — open of the first bar of the week.',
           params=(), inputs=('bars',))
def weekly_open(bars: Bars):
    return _period_agg(bars.df, 'open', 'week')


@primitive(name='weekly_high', group='levels',
           description='This ISO week\'s running high (all sessions).',
           params=(), inputs=('bars',))
def weekly_high(bars: Bars):
    return _period_agg(bars.df, 'high', 'week')


@primitive(name='weekly_low', group='levels',
           description='This ISO week\'s running low.',
           params=(), inputs=('bars',))
def weekly_low(bars: Bars):
    return _period_agg(bars.df, 'low', 'week')


@primitive(name='monthly_open', group='levels',
           description='This ET month\'s open — open of the first bar of the month.',
           params=(), inputs=('bars',))
def monthly_open(bars: Bars):
    return _period_agg(bars.df, 'open', 'month')


@primitive(name='monthly_high', group='levels',
           description='This ET month\'s running high.',
           params=(), inputs=('bars',))
def monthly_high(bars: Bars):
    return _period_agg(bars.df, 'high', 'month')


@primitive(name='monthly_low', group='levels',
           description='This ET month\'s running low.',
           params=(), inputs=('bars',))
def monthly_low(bars: Bars):
    return _period_agg(bars.df, 'low', 'month')


def _monday_extreme(df: pd.DataFrame, which: str) -> np.ndarray:
    et = df.index.tz_convert(_ET)
    iso = et.isocalendar()
    years = iso.year.to_numpy()
    weeks = iso.week.to_numpy()
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    n = len(df)
    per_week: dict = {}
    for i in range(n):
        t = et[i]
        if t.dayofweek == 0 and _in_rth(t):
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
           description=('This ISO week\'s Monday RTH high — constant across the '
                        'whole week. NaN until Monday RTH has some data.'),
           params=(), inputs=('bars',))
def monday_high(bars: Bars):
    return _monday_extreme(bars.df, 'high')


@primitive(name='monday_low', group='levels',
           description='This ISO week\'s Monday RTH low.',
           params=(), inputs=('bars',))
def monday_low(bars: Bars):
    return _monday_extreme(bars.df, 'low')
