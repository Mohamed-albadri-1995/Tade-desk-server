"""
Anchored VWAP — the primitive every VWAP flavour delegates to.

Definition (matches TradingView ta.vwap when the reset mask fires on
`ta.change(time('D'))` etc.):

    cum_pv = cum_v = 0
    for each bar i:
        if reset[i]:
            cum_pv = 0
            cum_v  = 0
        cum_pv += price[i] * volume[i]
        cum_v  += volume[i]
        vwap[i] = cum_pv / cum_v   (NaN when cum_v == 0)

`price` defaults to HLC3 — TradingView's default. Callers can pass any
price series (typical, weighted_close, close) if they want a specific
weighting.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from qp.price import hlc3


def anchored_vwap(bars: pd.DataFrame,
                  reset_mask,
                  price: Optional[np.ndarray] = None) -> np.ndarray:
    """VWAP that resets whenever `reset_mask[i]` is True.

    - `bars`: DataFrame with columns [open, high, low, close, volume].
    - `reset_mask`: boolean array/Series length == len(bars). True on the
      bar where the accumulator should reset BEFORE that bar contributes.
    - `price`: 1-D price series length == len(bars). Defaults to HLC3.

    Returns np.ndarray of length len(bars).
    """
    p = np.asarray(price if price is not None else hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    mask = np.asarray(reset_mask, dtype=bool)
    if p.shape != v.shape or v.shape != mask.shape:
        raise ValueError('price, volume, and reset_mask must have identical shape')

    n = p.size
    out = np.full(n, np.nan, dtype=float)
    cum_pv = 0.0
    cum_v  = 0.0
    for i in range(n):
        if mask[i]:
            cum_pv = 0.0
            cum_v  = 0.0
        pv = p[i] * v[i] if np.isfinite(p[i]) and np.isfinite(v[i]) else 0.0
        cum_pv += pv
        cum_v  += v[i] if np.isfinite(v[i]) else 0.0
        out[i] = cum_pv / cum_v if cum_v > 0 else np.nan
    return out
