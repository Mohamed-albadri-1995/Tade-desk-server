"""
Dynamic support/resistance — faithful port of LonesomeTheBlue's
"Support Resistance - Dynamic v2" ('horizental levels').

Algorithm, bar by bar (exactly the Pine):
  1. Confirmed pivots (ta.pivothigh/pivotlow with left=right=pivot_period)
     are collected most-recent-first, capped at `max_pivots`. When a high
     and a low confirm on the same bar, only the high enters (Pine's
     `ph ? ph : pl`).
  2. On every bar where a new pivot confirms, ALL channels are rebuilt:
     - Max channel width = (highest(high,300) - lowest(low,300)) *
       channel_width_pct / 100 at that bar. NaN (fewer than 300 bars) →
       no channels form yet, same as Pine.
     - Each pivot seeds a channel; every other pivot within the width
       extends it (Pine's quirky lo/hi walk is replicated verbatim).
       Strength = number of pivots inside, seed included.
     - Overlapping channels dedupe keeping the stronger; survivors sorted
       by strength; top `max_levels` with strength >= `min_strength` win.
  3. Each surviving channel outputs its midpoint (hi+lo)/2, carried
     forward until the next pivot confirms.

Causal: pivots confirm `pivot_period` bars late, so nothing repaints
backwards. Needs ~300 bars of history before the first level appears
(the channel-width window), same as the Pine.

Returns {sr1..srN} arrays, sr1 = strongest. NaN where fewer levels exist.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive, Param
from qp.primitives.bars import Bars


def _confirmed_pivot_values(values: np.ndarray, prd: int, side: str) -> np.ndarray:
    """Pivot value at each CONFIRMATION bar (prd bars after the pivot),
    NaN elsewhere. Pine tie rules: >= left, strictly beyond right."""
    n = len(values)
    out = np.full(n, np.nan)
    for centre in range(prd, n - prd):
        v = values[centre]
        left  = values[centre - prd: centre]
        right = values[centre + 1: centre + prd + 1]
        if side == 'high':
            ok = (v >= left.max()) and (v > right.max())
        else:
            ok = (v <= left.min()) and (v < right.min())
        if ok:
            out[centre + prd] = v
    return out


@primitive(
    name='dynamic_sr',
    group='levels',
    description=('Dynamic S/R levels — port of "Support Resistance Dynamic '
                 'v2". Clusters the last `max_pivots` confirmed pivots into '
                 'channels no wider than (300-bar range * channel_width_pct '
                 '/100), ranks by pivot count, keeps the top `max_levels`. '
                 'Returns {sr1..srN}, strongest first. `source`: "hl" uses '
                 'high/low pivots, "body" uses max/min(open,close). Needs '
                 '~300 bars of history before the first level.'),
    params=(
        Param('pivot_period',      'int',   default=10, min=4,  max=30),
        Param('max_pivots',        'int',   default=20, min=5,  max=100),
        Param('channel_width_pct', 'float', default=10.0, min=1.0),
        Param('max_levels',        'int',   default=6,  min=1,  max=10),
        Param('min_strength',      'int',   default=1,  min=1,  max=10),
        Param('source',            'str',   default='hl',
              description='"hl" (high/low) or "body" (close/open)'),
    ),
    inputs=('bars',),
)
def dynamic_sr(bars: Bars, pivot_period: int, max_pivots: int,
               channel_width_pct: float, max_levels: int,
               min_strength: int, source: str = 'hl'):
    df = bars.df
    n = len(df)
    prd = int(pivot_period)
    max_pivots = int(max_pivots)
    max_levels = int(max_levels)
    min_strength = int(min_strength)

    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    if source == 'hl':
        src1, src2 = high, low
    elif source == 'body':
        o = df['open'].to_numpy(dtype=float)
        c = df['close'].to_numpy(dtype=float)
        src1, src2 = np.maximum(o, c), np.minimum(o, c)
    else:
        raise ValueError(f"source must be 'hl' or 'body', got {source!r}")

    ph = _confirmed_pivot_values(src1, prd, 'high')
    pl = _confirmed_pivot_values(src2, prd, 'low')

    # 300-bar range window — NaN until 300 bars exist, matching Pine's
    # ta.highest(300)/ta.lowest(300) warmup.
    hh300 = pd.Series(high).rolling(300, min_periods=300).max().to_numpy()
    ll300 = pd.Series(low).rolling(300, min_periods=300).min().to_numpy()

    pivotvals: list[float] = []          # most recent first
    current: list[float] = []            # level midpoints, strongest first
    out = {f'sr{k + 1}': np.full(n, np.nan) for k in range(max_levels)}

    for i in range(n):
        new_ph = not np.isnan(ph[i])
        new_pl = not np.isnan(pl[i])
        if new_ph or new_pl:
            pivotvals.insert(0, ph[i] if new_ph else pl[i])
            if len(pivotvals) > max_pivots:
                pivotvals.pop()

            cwidth = np.nan
            if not np.isnan(hh300[i]):
                cwidth = (hh300[i] - ll300[i]) * float(channel_width_pct) / 100.0

            sr_up: list[float] = []
            sr_dn: list[float] = []
            sr_st: list[int] = []
            for x in range(len(pivotvals)):
                # get_sr_vals — Pine's quirky channel walk, verbatim
                lo = pivotvals[x]
                hi = lo
                numpp = 0
                for cpp in pivotvals:
                    wdth = (hi - cpp) if cpp <= lo else (cpp - lo)
                    if not np.isnan(cwidth) and wdth <= cwidth:
                        if cpp <= hi:
                            lo = min(lo, cpp)
                        else:
                            hi = max(hi, cpp)
                        numpp += 1
                strength = numpp

                # check_sr — dedupe overlapping channels, stronger wins
                ok = True
                for j in range(len(sr_up)):
                    if (lo <= sr_up[j] <= hi) or (lo <= sr_dn[j] <= hi):
                        if strength >= sr_st[j]:
                            del sr_up[j], sr_dn[j], sr_st[j]
                        else:
                            ok = False
                        break
                if not ok:
                    continue

                # find_loc — insertion index by descending strength
                loc = len(sr_st)
                for j in range(len(sr_st) - 1, -1, -1):
                    if strength <= sr_st[j]:
                        break
                    loc = j
                if loc < max_levels and strength >= min_strength:
                    sr_up.insert(loc, hi)
                    sr_dn.insert(loc, lo)
                    sr_st.insert(loc, strength)
                    if len(sr_st) > max_levels:
                        sr_up.pop()
                        sr_dn.pop()
                        sr_st.pop()

            current = [(u + d) / 2.0 for u, d in zip(sr_up, sr_dn)]

        for k in range(min(len(current), max_levels)):
            out[f'sr{k + 1}'][i] = current[k]

    return out
