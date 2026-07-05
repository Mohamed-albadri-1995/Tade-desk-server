"""
Setup B — "Healthy Pullback L3" (Pine parity for Script 3, L3 section).

Long-only. On the current bar:
    - close > daily_vwap AND close > BB EMA basis
    - (strict) close > 2-day VWAP AND close > LL AVWAP
    - previous bar was a red rejection candle whose low kissed any of
      the three long VWAPs (within `vwap_touch_pct`) and closed inside
      the BB range
    - current bar is green and closes above the previous bar's high
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.vwap import session_vwap, n_day_vwap, today_ll_vwap
from qp.volatility import bollinger_ema, atr
from qp.setups.spec import StopRule, TargetRule
from qp.setups.library.shared_defaults import evaluate_defaults


NAME        = 'Healthy Pullback L3'
DESCRIPTION = ('Prior bar rejects off Daily/2D/LL VWAP with a lower wick; '
               'current bar closes above the rejection high while price '
               'stays inside the BB EMA range and above all three VWAPs.')
SIDE        = 'long'


CHART_SPECS = [
    {'ind': 'vwap',              'length': 0,  'label': 'Daily VWAP'},
    {'ind': 'vwap_2d_anchored',  'length': 0,  'label': '2-Day Anchored VWAP'},
    {'ind': 'today_ll_vwap',     'length': 0,  'label': 'LL Anchored VWAP'},
    {'ind': 'bollinger_ema',     'length': 21, 'label': 'BB EMA (21)',
     'mult': 2.0},
]

# Risk envelope (compare tool + trade desk consume both). ATR-multiple
# stop with an R-multiple target keeps the scaling honest across
# ticker prices.
STOP   = StopRule(kind='atr', mult=1.0, atr_length=14)
TARGET = TargetRule(kind='r_multiple', r=2.0)


def evaluate(bars: pd.DataFrame,
             bb_length: int = 21,
             bb_mult: float = 2.0,
             min_wick_pct: float = 15.0,
             vwap_touch_pct: float = 0.2,
             require_volume: bool = False,
             bias_strict: bool = True) -> np.ndarray:
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)
    v = bars['volume'].to_numpy(dtype=float)

    dv  = np.asarray(session_vwap(bars))
    v2  = np.asarray(n_day_vwap(bars, 2))
    llv = np.asarray(today_ll_vwap(bars))
    bb  = bollinger_ema(c, length=bb_length, mult=bb_mult, zone_pct=25.0)

    n = len(bars)
    fired = np.zeros(n, dtype=bool)
    if n < 2:
        return fired

    bias_base = (c > dv) & (c > bb.basis)
    bias_full = bias_base & (c > v2) & (c > llv)
    bias      = bias_full if bias_strict else bias_base
    bias_c1   = np.concatenate(([False], bias[:-1]))

    rng_1 = h[:-1] - l[:-1]
    rng_1 = np.where(rng_1 > 0, rng_1, np.nan)
    body_bot_1 = np.minimum(o[:-1], c[:-1])
    lwick_1    = body_bot_1 - l[:-1]
    lwick_pct  = (lwick_1 / rng_1) * 100.0
    red_prev   = c[:-1] < o[:-1]
    below_bb_upper = h[:-1] < bb.upper[:-1]

    tol  = vwap_touch_pct / 100.0
    l_dv = (l[:-1] <= dv[:-1]  * (1 + tol)) & (l[:-1] >= dv[:-1]  * (1 - tol))
    l_v2 = (l[:-1] <= v2[:-1]  * (1 + tol)) & (l[:-1] >= v2[:-1]  * (1 - tol))
    l_av = (l[:-1] <= llv[:-1] * (1 + tol)) & (l[:-1] >= llv[:-1] * (1 - tol))
    any_touch = l_dv | l_v2 | l_av

    c1 = red_prev & (lwick_pct >= min_wick_pct) & any_touch & below_bb_upper

    green_now = c[1:] > o[1:]
    breakout  = c[1:] > h[:-1]
    vol_ok    = (v[1:] > v[:-1]) if require_volume else np.ones(n - 1, dtype=bool)
    c2 = green_now & breakout & vol_ok

    fired[1:] = bias_c1[1:] & bias[1:] & c1 & c2
    return fired


def debug_last_bar(bars: pd.DataFrame,
                   bb_length: int = 21,
                   bb_mult: float = 2.0,
                   min_wick_pct: float = 15.0,
                   vwap_touch_pct: float = 0.2,
                   bias_strict: bool = True,
                   **_ignored) -> dict:
    """Per-condition pass/note for the LAST bar. Same intermediate calcs
    as evaluate(). Shape mirrors the JS engine debug() contract so the
    trade desk can splice it into mandatoryChecks without adapters."""
    n = len(bars)
    if n < 2:
        return {'canRun': False, 'reason': f'need 2+ bars, have {n}',
                'conditions': []}
    o = bars['open'].to_numpy(dtype=float)
    h = bars['high'].to_numpy(dtype=float)
    l = bars['low'].to_numpy(dtype=float)
    c = bars['close'].to_numpy(dtype=float)
    dv  = np.asarray(session_vwap(bars))
    v2  = np.asarray(n_day_vwap(bars, 2))
    llv = np.asarray(today_ll_vwap(bars))
    bb  = bollinger_ema(c, length=bb_length, mult=bb_mult, zone_pct=25.0)

    i, p = n - 1, n - 2
    biasBase   = (c[i] > dv[i]) and (c[i] > bb.basis[i])
    biasFull   = biasBase and (c[i] > v2[i]) and (c[i] > llv[i])
    biasNow    = biasFull if bias_strict else biasBase
    biasBaseP  = (c[p] > dv[p]) and (c[p] > bb.basis[p])
    biasFullP  = biasBaseP and (c[p] > v2[p]) and (c[p] > llv[p])
    biasPrev   = biasFullP if bias_strict else biasBaseP
    rng_p      = (h[p] - l[p]) if (h[p] - l[p]) > 0 else float('nan')
    lwick_p    = (min(o[p], c[p]) - l[p])
    lwick_pct  = (lwick_p / rng_p) * 100.0 if rng_p == rng_p else 0.0
    redPrev    = c[p] < o[p]
    notExtnd   = h[p] < bb.upper[p]
    tol        = vwap_touch_pct / 100.0
    def _touch(ref): return (l[p] <= ref * (1 + tol)) and (l[p] >= ref * (1 - tol))
    anyTouch   = _touch(dv[p]) or _touch(v2[p]) or _touch(llv[p])
    greenNow   = c[i] > o[i]
    breakout   = c[i] > h[p]
    mandatory = [
        {'name': 'Long bias (prev bar)',        'pass': bool(biasPrev),
         'note': f'close {c[p]:.2f} vs DV {dv[p]:.2f} / BB {bb.basis[p]:.2f}'},
        {'name': 'Long bias (this bar)',        'pass': bool(biasNow),
         'note': f'close {c[i]:.2f} vs DV {dv[i]:.2f}'},
        {'name': 'Prev candle red',             'pass': bool(redPrev),
         'note': f'prev close {c[p]:.2f} vs open {o[p]:.2f}'},
        {'name': f'Lower wick ≥ {min_wick_pct}%',
         'pass': bool(lwick_pct >= min_wick_pct),
         'note': f'{lwick_pct:.1f}%'},
        {'name': 'Prev low touched a VWAP',     'pass': bool(anyTouch),
         'note': f'prev.l {l[p]:.2f} vs 3 VWAPs ±{vwap_touch_pct}%'},
        {'name': 'Not extended (prev.h < BB upper)',
         'pass': bool(notExtnd),
         'note': f'prev.h {h[p]:.2f} vs BB up {bb.upper[p]:.2f}'},
        {'name': 'This bar green',              'pass': bool(greenNow),
         'note': f'close {c[i]:.2f} vs open {o[i]:.2f}'},
        {'name': 'Close > prev high',           'pass': bool(breakout),
         'note': f'close {c[i]:.2f} vs prev.h {h[p]:.2f}'},
    ]
    # Kept legacy `conditions` for older callers that don't understand
    # the split. New code should read mandatory/default/additional.
    return {
        'canRun':     True,
        'mandatory':  mandatory,
        'default':    evaluate_defaults(bars, side='long'),
        'additional': ADDITIONAL_CHECKS(bars, side='long'),
        'conditions': mandatory,
    }


def ADDITIONAL_CHECKS(bars: pd.DataFrame, side: str = 'long') -> list[dict]:
    """Per-setup extra checks (informational — do not gate the fire).
    Add or edit here to change what appears in the "Additional" section
    of this setup's trade card."""
    n = len(bars)
    out = []
    if n < 22:
        return out
    c = bars['close'].to_numpy(dtype=float)
    # Prior 20-bar range compression — a sign the pullback was orderly.
    hi20 = float(np.max(bars['high'].to_numpy(dtype=float)[-21:-1]))
    lo20 = float(np.min(bars['low'].to_numpy(dtype=float)[-21:-1]))
    rng_pct = (hi20 - lo20) / c[-1] * 100.0 if c[-1] else 0.0
    out.append({
        'name': '20-bar range < 2% (orderly pullback)',
        'pass': bool(rng_pct < 2.0),
        'note': f'range {rng_pct:.2f}%',
    })
    # Close in the upper half of the CURRENT bar's range — a strength cue.
    o = float(bars['open'].iloc[-1]);  h = float(bars['high'].iloc[-1])
    l = float(bars['low'].iloc[-1]);   cl = float(bars['close'].iloc[-1])
    rng = h - l
    upper_half = (cl >= (l + h) / 2.0) if rng > 0 else False
    out.append({
        'name': 'Close in upper half of bar range',
        'pass': bool(upper_half),
        'note': f'close {cl:.2f} vs midpoint {(l+h)/2.0:.2f}',
    })
    return out
