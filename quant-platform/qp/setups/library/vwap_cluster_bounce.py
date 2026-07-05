"""
Setup A — "VWAP Cluster Bounce" (Pine parity for Script 1).

Trigger: two or more of the tracked VWAPs converge within
`cluster_pct` of each other (with at least one being a time-anchored
one — 1D/2D/W/M), and price bounces off that cluster with candle
quality, volume, and 5D-MA / SMA20 direction confirmation.

Earnings VWAPs are not auto-fetched yet, so they're omitted from the
cluster set. They can be added by callers via qp.vwap.earnings_vwap
with a manual anchor date.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.vwap import (
    session_vwap, n_day_vwap, weekly_vwap, monthly_vwap,
    today_hh_vwap, today_ll_vwap, week_hh_vwap, week_ll_vwap,
    gap_vwap, last_hour_ll_vwap, last_hour_hh_vwap,
    pivot_ll_vwap, pivot_hh_vwap,
)
from qp.ma import sma, n_session_sma
from qp.setups.spec import StopRule, TargetRule
from qp.setups.library.shared_defaults import evaluate_defaults


NAME        = 'VWAP Cluster Bounce'
DESCRIPTION = ('Two-or-more VWAPs converge; price bounces off the cluster '
               'with candle quality, volume, and 5D-MA / SMA20 confirmation.')
SIDE        = 'both'


CHART_SPECS = [
    {'ind': 'vwap',              'length': 0,  'label': 'Daily VWAP'},
    {'ind': 'vwap_2d_anchored',  'length': 0,  'label': '2-Day Anchored VWAP'},
    {'ind': 'weekly_vwap',       'length': 0,  'label': 'Weekly VWAP'},
    {'ind': 'monthly_vwap',      'length': 0,  'label': 'Monthly VWAP'},
    {'ind': 'today_hh_vwap',     'length': 0,  'label': 'Today HH VWAP'},
    {'ind': 'today_ll_vwap',     'length': 0,  'label': 'Today LL VWAP'},
    {'ind': 'week_hh_vwap',      'length': 0,  'label': 'Week HH VWAP'},
    {'ind': 'week_ll_vwap',      'length': 0,  'label': 'Week LL VWAP'},
    {'ind': 'gap_vwap',          'length': 14, 'label': 'Gap VWAP'},
    {'ind': 'last_hour_ll_vwap', 'length': 0,  'label': 'Last-Hour LL VWAP'},
    {'ind': 'last_hour_hh_vwap', 'length': 0,  'label': 'Last-Hour HH VWAP'},
    {'ind': 'sma_5d',            'length': 0,  'label': '5-Day Rolling SMA'},
    {'ind': 'sma',               'length': 20, 'label': 'SMA(20)'},
]

# Bounce trades tend to have a tighter stop than swings — 1× ATR, 2R
# target as the default risk envelope.
STOP   = StopRule(kind='atr', mult=1.0, atr_length=14)
TARGET = TargetRule(kind='r_multiple', r=2.0)


def evaluate(bars: pd.DataFrame,
             cluster_pct: float = 1.5,
             vol_mult: float = 1.2,
             min_body_pct: float = 0.3,
             max_wick_pct: float = 0.5,
             lookback: int = 20,
             side: str = 'long') -> np.ndarray:
    """Trigger for the requested `side` ('long' or 'short')."""
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    n = len(bars)

    time_series = [
        np.asarray(session_vwap(bars)),
        np.asarray(n_day_vwap(bars, 2)),
        np.asarray(weekly_vwap(bars)),
        np.asarray(monthly_vwap(bars)),
    ]
    anchor_series = [
        np.asarray(today_hh_vwap(bars)),
        np.asarray(today_ll_vwap(bars)),
        np.asarray(week_hh_vwap(bars)),
        np.asarray(week_ll_vwap(bars)),
        np.asarray(pivot_ll_vwap(bars, lookback=25)),
        np.asarray(pivot_hh_vwap(bars, lookback=25)),
        np.asarray(last_hour_ll_vwap(bars)),
        np.asarray(last_hour_hh_vwap(bars)),
        np.asarray(gap_vwap(bars)),
    ]
    all_series = time_series + anchor_series

    thr = np.abs(c) * (cluster_pct / 100.0)
    close_to_time = np.zeros(n, dtype=int)
    for s in time_series:
        close_to_time += (np.isfinite(s) & (np.abs(s - c) <= thr)).astype(int)
    close_to_all = np.zeros(n, dtype=int)
    for s in all_series:
        close_to_all += (np.isfinite(s) & (np.abs(s - c) <= thr)).astype(int)
    has_cluster = (close_to_all >= 2) & (close_to_time >= 1)

    rng   = np.where((h - l) > 0, (h - l), np.nan)
    body  = np.abs(c - o)
    upper = h - np.maximum(o, c)
    lower = np.minimum(o, c) - l
    body_pct       = body / rng
    upper_wick_pct = upper / rng
    lower_wick_pct = lower / rng

    vol_ma = pd.Series(v).rolling(lookback, min_periods=1).mean().to_numpy()
    vol_ma_prev = np.concatenate(([np.nan], vol_ma[:-1]))
    vol_ok = v >= vol_mult * vol_ma_prev

    ma5  = np.asarray(n_session_sma(bars, 5))
    ma20 = np.asarray(sma(c, 20))

    if side == 'long':
        green = c > o
        candle_ok = green & (body_pct >= min_body_pct) & (upper_wick_pct <= max_wick_pct)
        directional = (c > ma5) & (c > ma20)
    else:
        red = c < o
        candle_ok = red & (body_pct >= min_body_pct) & (lower_wick_pct <= max_wick_pct)
        directional = (c < ma5) & (c < ma20)

    fired = has_cluster & candle_ok & vol_ok & directional
    return np.where(np.isnan(fired.astype(float)), False, fired).astype(bool)


def debug_last_bar(bars: pd.DataFrame,
                   cluster_pct: float = 1.5,
                   vol_mult: float = 1.2,
                   min_body_pct: float = 0.3,
                   max_wick_pct: float = 0.5,
                   lookback: int = 20,
                   side: str = 'long',
                   **_ignored) -> dict:
    """Per-condition status for the last bar. Same intermediate calcs
    as evaluate()."""
    n = len(bars)
    if n < lookback + 1:
        return {'canRun': False, 'reason': f'need {lookback+1}+ bars, have {n}',
                'conditions': []}
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)
    v = bars['volume'].to_numpy(dtype=float)

    time_series = {
        'Daily VWAP':   np.asarray(session_vwap(bars)),
        '2D VWAP':      np.asarray(n_day_vwap(bars, 2)),
        'Weekly VWAP':  np.asarray(weekly_vwap(bars)),
        'Monthly VWAP': np.asarray(monthly_vwap(bars)),
    }
    anchor_series = {
        'Today HH': np.asarray(today_hh_vwap(bars)),
        'Today LL': np.asarray(today_ll_vwap(bars)),
        'Week HH':  np.asarray(week_hh_vwap(bars)),
        'Week LL':  np.asarray(week_ll_vwap(bars)),
        'Pivot LL': np.asarray(pivot_ll_vwap(bars, lookback=25)),
        'Pivot HH': np.asarray(pivot_hh_vwap(bars, lookback=25)),
        'LH LL':    np.asarray(last_hour_ll_vwap(bars)),
        'LH HH':    np.asarray(last_hour_hh_vwap(bars)),
        'Gap':      np.asarray(gap_vwap(bars)),
    }
    i = n - 1
    thr = abs(c[i]) * (cluster_pct / 100.0)
    hits_time   = [k for k, s in time_series.items()
                   if np.isfinite(s[i]) and abs(s[i] - c[i]) <= thr]
    hits_anchor = [k for k, s in anchor_series.items()
                   if np.isfinite(s[i]) and abs(s[i] - c[i]) <= thr]
    total = len(hits_time) + len(hits_anchor)
    has_cluster = total >= 2 and len(hits_time) >= 1

    rng   = (h[i] - l[i]) or float('nan')
    body  = abs(c[i] - o[i])
    upper = h[i] - max(o[i], c[i])
    lower = min(o[i], c[i]) - l[i]
    body_pct       = (body / rng) if rng == rng else 0.0
    upper_wick_pct = (upper / rng) if rng == rng else 0.0
    lower_wick_pct = (lower / rng) if rng == rng else 0.0

    vol_ma_prev = float(pd.Series(v).rolling(lookback, min_periods=1).mean().iloc[i - 1])
    vol_ok = v[i] >= vol_mult * vol_ma_prev

    ma5  = float(np.asarray(n_session_sma(bars, 5))[i])
    ma20 = float(np.asarray(sma(c, 20))[i])

    if side == 'long':
        green = c[i] > o[i]
        candle_ok = green and body_pct >= min_body_pct and upper_wick_pct <= max_wick_pct
        directional = c[i] > ma5 and c[i] > ma20
        candle_desc = f'green, body {body_pct*100:.0f}%, upper wick {upper_wick_pct*100:.0f}%'
        dir_desc = f'close {c[i]:.2f} vs 5D {ma5:.2f} / SMA20 {ma20:.2f}'
    else:
        red = c[i] < o[i]
        candle_ok = red and body_pct >= min_body_pct and lower_wick_pct <= max_wick_pct
        directional = c[i] < ma5 and c[i] < ma20
        candle_desc = f'red, body {body_pct*100:.0f}%, lower wick {lower_wick_pct*100:.0f}%'
        dir_desc = f'close {c[i]:.2f} vs 5D {ma5:.2f} / SMA20 {ma20:.2f}'

    cluster_note = (f'{total} tight VWAPs ({len(hits_time)} time + '
                    f'{len(hits_anchor)} anchor)' if total else 'no cluster')
    if hits_time or hits_anchor:
        cluster_note += ': ' + ' / '.join(hits_time + hits_anchor)

    mandatory = [
        {'name': f'VWAP cluster within {cluster_pct}%',
         'pass': bool(has_cluster), 'note': cluster_note},
        {'name': 'Candle quality', 'pass': bool(candle_ok), 'note': candle_desc},
        {'name': f'Volume ≥ {vol_mult}× {lookback}-bar mean',
         'pass': bool(vol_ok),
         'note': f'v {v[i]:.0f} vs mean {vol_ma_prev:.0f}'},
        {'name': f'Above 5D + SMA20' if side == 'long' else 'Below 5D + SMA20',
         'pass': bool(directional), 'note': dir_desc},
    ]
    return {
        'canRun':     True,
        'mandatory':  mandatory,
        'default':    evaluate_defaults(bars, side=side),
        'additional': ADDITIONAL_CHECKS(bars, side=side),
        'conditions': mandatory,
    }


def ADDITIONAL_CHECKS(bars: pd.DataFrame, side: str = 'long') -> list[dict]:
    """Per-setup extras — informational, do not gate the fire."""
    n = len(bars)
    if n < 2: return []
    o = float(bars['open'].iloc[-1]);  h = float(bars['high'].iloc[-1])
    l = float(bars['low'].iloc[-1]);   cl = float(bars['close'].iloc[-1])
    rng = h - l
    # Body >= 40% of range — favours a decisive bounce/rejection candle.
    body_pct = (abs(cl - o) / rng * 100.0) if rng > 0 else 0.0
    return [{
        'name': 'Bounce body ≥ 40% of range',
        'pass': bool(body_pct >= 40.0),
        'note': f'body {body_pct:.0f}%',
    }]
