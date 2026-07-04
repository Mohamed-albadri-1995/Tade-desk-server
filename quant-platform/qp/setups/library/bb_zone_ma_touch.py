"""
Setup C — "BB Zone MA Touch" (Pine parity for Script 3, BBZ section).

Long or short. Requires:
    - inside the trading window (09:30–13:00 ET by default)
    - price above (long) or below (short) VWAP ±σ band
    - the last N candles' body-mass sits outside the opposite zone
      (only a small % of body sits in the "bad" zone)
    - prior bar's range crossed the SMA9 / SMA13 / SMA20, and the
      current bar bounces (or rejects) with a body big enough vs. ATR
      and a capped wick.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.vwap import session_vwap, vwap_stdev_bands
from qp.volatility import atr, bollinger
from qp.ma import sma
from qp.session import US_EQUITIES
from qp.setups.spec import StopRule, TargetRule


NAME        = 'BB Zone MA Touch'
DESCRIPTION = ('Session-window MA touch inside a BB zone with a body/wick '
               'confirmation and a VWAP ± stdev filter.')
SIDE        = 'both'


CHART_SPECS = [
    {'ind': 'vwap',      'length': 0,  'label': 'Daily VWAP'},
    {'ind': 'bollinger', 'length': 20, 'label': 'BB (20, 2)', 'mult': 2.0},
    {'ind': 'sma',       'length': 9,  'label': 'SMA(9)'},
    {'ind': 'sma',       'length': 13, 'label': 'SMA(13)'},
    {'ind': 'sma',       'length': 20, 'label': 'SMA(20)'},
]

# BBZ Pine uses SMA20 as the stop reference — we approximate here with
# a slightly tighter ATR-multiple, keeping the R-target at 3R to match
# Pine's t2_tp_ticks/t2_sl_ticks ratio (300/90 ≈ 3.3).
STOP   = StopRule(kind='atr', mult=1.0, atr_length=14)
TARGET = TargetRule(kind='r_multiple', r=3.0)


def _zone_body_ok(o, c, zone_ref, side, lookback, threshold_pct):
    """Rolling body-mass check across the last `lookback` bars."""
    n = len(c)
    ok = np.zeros(n, dtype=bool)
    body_top = np.maximum(o, c)
    body_bot = np.minimum(o, c)
    body     = body_top - body_bot
    if side == 'long':
        bad = np.maximum(0.0, np.minimum(body_top, zone_ref) - body_bot)
    else:
        bad = np.maximum(0.0, body_top - np.maximum(body_bot, zone_ref))
    for i in range(lookback - 1, n):
        s = slice(i - lookback + 1, i + 1)
        total_body = float(body[s].sum())
        bad_body   = float(bad[s].sum())
        if total_body <= 0:
            ok[i] = True
        else:
            ok[i] = (bad_body / total_body) * 100.0 < threshold_pct
    return ok


def evaluate(bars: pd.DataFrame,
             session_start_hh: int = 9,
             session_start_mm: int = 30,
             session_end_hh: int = 13,
             session_end_mm: int = 0,
             bb_length: int = 20,
             bb_mult: float = 2.0,
             short_lookback: int = 3,
             long_lookback: int = 4,
             s_zone_pct: float = 25.0,
             l_zone_pct: float = 25.0,
             outside_thresh_pct: float = 7.0,
             sdv_mult_short: float = 0.8,
             sdv_mult_long: float = 0.8,
             body_atr: float = 0.2,
             wick_ratio: float = 0.5,
             side: str = 'long') -> np.ndarray:
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)
    n = len(bars)

    local = bars.index.tz_convert(US_EQUITIES.tz)
    hh = np.asarray(local.hour)
    mm = np.asarray(local.minute)
    after_start = (hh > session_start_hh) | ((hh == session_start_hh) & (mm >= session_start_mm))
    before_end  = (hh < session_end_hh)   | ((hh == session_end_hh)   & (mm <= session_end_mm))
    in_session = after_start & before_end

    bb = bollinger(c, length=bb_length, mult=bb_mult)
    bb_range = bb.upper - bb.lower
    red_zone_top   = bb.lower + (s_zone_pct / 100.0) * bb_range
    green_zone_bot = bb.upper - (l_zone_pct / 100.0) * bb_range

    vb = vwap_stdev_bands(bars, mult=1.0)
    upper_band = vb.basis + sdv_mult_long  * vb.stdev
    lower_band = vb.basis - sdv_mult_short * vb.stdev

    atr14 = np.asarray(atr(bars, 14))
    body  = np.abs(c - o)
    upper_wick = h - np.maximum(c, o)
    lower_wick = np.minimum(c, o) - l

    ma9  = np.asarray(sma(c, 9))
    ma13 = np.asarray(sma(c, 13))
    ma20 = np.asarray(sma(c, 20))

    prev_idx = np.arange(n) - 1
    prev_idx[prev_idx < 0] = 0

    def _touch(ma, side_):
        crossed_prev = (l[prev_idx] <= ma[prev_idx]) & (h[prev_idx] >= ma[prev_idx])
        if side_ == 'long':
            return crossed_prev & (c > ma)
        else:
            return crossed_prev & (c < ma)

    if side == 'long':
        vwap_ok = c > upper_band
        zone_ok = _zone_body_ok(o, c, red_zone_top, 'long', long_lookback,
                                outside_thresh_pct)
        bounce_body = body > (atr14 * body_atr)
        bounce_wick = upper_wick < (body * wick_ratio)
        bounce_bull = c > o
        bounce_ok = bounce_bull & bounce_body & bounce_wick
        touch_any = (_touch(ma9, 'long') | _touch(ma13, 'long') | _touch(ma20, 'long')) & bounce_ok
        fired = in_session & vwap_ok & zone_ok & touch_any
    else:
        vwap_ok = c < lower_band
        zone_ok = _zone_body_ok(o, c, green_zone_bot, 'short', short_lookback,
                                outside_thresh_pct)
        reject_body = body > (atr14 * body_atr)
        reject_wick = lower_wick < (body * wick_ratio)
        reject_bear = c < o
        reject_ok = reject_bear & reject_body & reject_wick
        touch_any = (_touch(ma9, 'short') | _touch(ma13, 'short') | _touch(ma20, 'short')) & reject_ok
        fired = in_session & vwap_ok & zone_ok & touch_any

    return np.where(np.isnan(fired.astype(float)), False, fired).astype(bool)


def debug_last_bar(bars: pd.DataFrame,
                   session_start_hh: int = 9, session_start_mm: int = 30,
                   session_end_hh: int = 13, session_end_mm: int = 0,
                   bb_length: int = 20, bb_mult: float = 2.0,
                   short_lookback: int = 3, long_lookback: int = 4,
                   s_zone_pct: float = 25.0, l_zone_pct: float = 25.0,
                   outside_thresh_pct: float = 7.0,
                   sdv_mult_short: float = 0.8, sdv_mult_long: float = 0.8,
                   body_atr: float = 0.2, wick_ratio: float = 0.5,
                   side: str = 'long', **_ignored) -> dict:
    """Per-condition status for the last bar."""
    n = len(bars)
    lookback = max(long_lookback, short_lookback, bb_length)
    if n < lookback + 1:
        return {'canRun': False, 'reason': f'need {lookback+1}+ bars, have {n}',
                'conditions': []}
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)

    local = bars.index.tz_convert(US_EQUITIES.tz)
    hh = np.asarray(local.hour)
    mm = np.asarray(local.minute)
    i = n - 1
    after_start = (hh[i] > session_start_hh) or (hh[i] == session_start_hh and mm[i] >= session_start_mm)
    before_end  = (hh[i] < session_end_hh)   or (hh[i] == session_end_hh   and mm[i] <= session_end_mm)
    in_session = after_start and before_end

    bb = bollinger(c, length=bb_length, mult=bb_mult)
    rng = bb.upper[i] - bb.lower[i]
    red_zone_top   = bb.lower[i] + (s_zone_pct / 100.0) * rng
    green_zone_bot = bb.upper[i] - (l_zone_pct / 100.0) * rng

    vb = vwap_stdev_bands(bars, mult=1.0)
    upper_band = vb.basis[i] + sdv_mult_long  * vb.stdev[i]
    lower_band = vb.basis[i] - sdv_mult_short * vb.stdev[i]

    atr14 = float(np.asarray(atr(bars, 14))[i])
    body  = abs(c[i] - o[i])
    upper_wick = h[i] - max(c[i], o[i])
    lower_wick = min(c[i], o[i]) - l[i]

    ma9  = float(np.asarray(sma(c, 9))[i])
    ma13 = float(np.asarray(sma(c, 13))[i])
    ma20 = float(np.asarray(sma(c, 20))[i])

    zone_ok = _zone_body_ok(
        o, c, (red_zone_top if side == 'long' else green_zone_bot),
        side, (long_lookback if side == 'long' else short_lookback),
        outside_thresh_pct,
    )[i]

    if side == 'long':
        vwap_ok = c[i] > upper_band
        candle_ok = c[i] > o[i] and body > atr14 * body_atr and upper_wick < body * wick_ratio
    else:
        vwap_ok = c[i] < lower_band
        candle_ok = c[i] < o[i] and body > atr14 * body_atr and lower_wick < body * wick_ratio

    p_idx = i - 1
    def _touch_ma(ma):
        crossed = l[p_idx] <= ma and h[p_idx] >= ma
        return crossed and (c[i] > ma if side == 'long' else c[i] < ma)
    touched = []
    if _touch_ma(ma9):  touched.append('SMA9')
    if _touch_ma(ma13): touched.append('SMA13')
    if _touch_ma(ma20): touched.append('SMA20')
    touch_ok = bool(touched) and candle_ok

    return {
        'canRun': True,
        'conditions': [
            {'name': 'In trading window', 'pass': bool(in_session),
             'note': f'{hh[i]:02d}:{mm[i]:02d} vs '
                     f'{session_start_hh:02d}:{session_start_mm:02d}–'
                     f'{session_end_hh:02d}:{session_end_mm:02d}'},
            {'name': ('close > VWAP +σ band' if side == 'long' else 'close < VWAP −σ band'),
             'pass': bool(vwap_ok),
             'note': f'close {c[i]:.2f} vs band {(upper_band if side == "long" else lower_band):.2f}'},
            {'name': f'Body-mass outside {"red" if side == "long" else "green"} zone',
             'pass': bool(zone_ok),
             'note': f'{("long" if side == "long" else "short")}-side check over '
                     f'{long_lookback if side == "long" else short_lookback} bars'},
            {'name': 'Bounce/reject candle (body vs ATR + capped wick)',
             'pass': bool(candle_ok),
             'note': f'body {body:.2f} vs ATR×{body_atr} = {atr14*body_atr:.2f}'},
            {'name': 'Prev bar crossed a SMA + closed through',
             'pass': bool(touch_ok),
             'note': f'touched {"/".join(touched) if touched else "none"}'},
        ]
    }
