"""
Dynamic support / resistance zones — Pine parity for the
LonesomeTheBlue "Support Resistance - Dynamic v2" script (top half of
Script 2).

The algorithm (as evaluated on the LAST bar):

    1. Collect the last `maxnumpp` pivot highs / pivot lows over the
       whole loaded window (period=`prd`).
    2. Channel width = ChannelW% × (highest-300 − lowest-300).
    3. For each pivot p:
         - lo = p, hi = p
         - for every other pivot q, extend [lo, hi] to include q if
           the resulting width still fits `cwidth`. Track how many
           pivots fit — that's "strength".
    4. Discard zones weaker than `min_strength`, then dedupe zones
       that overlap (keep the stronger one).
    5. Sort by strength desc, keep top `maxnumsr`.
    6. Zone mid = (hi + lo) / 2. Above `close` → resistance, below →
       support.

Returns constant per-bar arrays for the top N zones' mid prices
(NaN before enough pivots exist). Callers can style them however.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.structure.pivots import pivot_highs, pivot_lows


def dynamic_sr_zones(bars: pd.DataFrame,
                     prd: int = 10,
                     max_pivots: int = 20,
                     max_zones: int = 6,
                     channel_pct: float = 10.0,
                     min_strength: int = 1) -> list[np.ndarray]:
    """Return `max_zones` per-bar arrays. Each element is the mid
    price of one identified S/R zone, held constant across ALL bars
    (the Pine version only draws on the last bar; here we return a
    horizontal series for the compare tool). Zones ranked by strength
    descending.

    Empty (all NaN) arrays fill in beyond however many zones the data
    supported.
    """
    n = len(bars)
    highs = bars['high'].to_numpy(dtype=float)
    lows  = bars['low'].to_numpy(dtype=float)
    zones_out: list[np.ndarray] = [np.full(n, np.nan) for _ in range(max_zones)]
    if n < 300:
        return zones_out

    ph = pivot_highs(bars, left=prd, right=prd)
    pl = pivot_lows(bars,  left=prd, right=prd)

    # Ordered by bar_index (Pine unshifts the newest first — we sort
    # newest-first here too so the clustering matches the direction it
    # walks in on the last bar).
    pivot_vals: list[float] = []
    for i in range(n - 1, -1, -1):
        if np.isfinite(ph[i]):
            pivot_vals.append(ph[i])
        elif np.isfinite(pl[i]):
            pivot_vals.append(pl[i])
        if len(pivot_vals) >= max_pivots:
            break
    if not pivot_vals:
        return zones_out

    # Channel width = 10% × (highest-300 − lowest-300) at the last bar.
    tail = min(300, n)
    hi_range = float(np.nanmax(highs[-tail:]))
    lo_range = float(np.nanmin(lows[-tail:]))
    cwidth = (hi_range - lo_range) * (channel_pct / 100.0)

    def get_sr(anchor_idx: int):
        lo = pivot_vals[anchor_idx]
        hi = lo
        strength = 0
        for j in range(len(pivot_vals)):
            cpp = pivot_vals[j]
            width = (hi - cpp) if cpp <= lo else (cpp - lo)
            if width <= cwidth:
                if cpp <= hi:
                    lo = min(lo, cpp)
                else:
                    hi = max(hi, cpp)
                strength += 1
        return hi, lo, strength

    candidates = []
    for idx in range(len(pivot_vals)):
        hi, lo, s = get_sr(idx)
        if s >= min_strength:
            candidates.append((s, hi, lo))
    # Dedupe: drop a zone whose (lo, hi) overlaps a stronger one already kept.
    candidates.sort(key=lambda x: -x[0])
    kept: list[tuple[int, float, float]] = []
    for s, hi, lo in candidates:
        overlap = False
        for _s2, hi2, lo2 in kept:
            if not (hi < lo2 or lo > hi2):
                overlap = True
                break
        if not overlap:
            kept.append((s, hi, lo))
        if len(kept) >= max_zones:
            break

    for slot, (_s, hi, lo) in enumerate(kept):
        mid = (hi + lo) / 2.0
        zones_out[slot][:] = mid
    return zones_out
