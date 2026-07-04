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
