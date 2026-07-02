"""
True Range — the foundation for ATR and every gap-aware volatility
measure. Definition matches TradingView `ta.tr`:

    tr[0] = high[0] - low[0]
    tr[i] = max(high[i] - low[i],
                abs(high[i] - close[i-1]),
                abs(low[i]  - close[i-1]))

The first bar has no previous close, so it degenerates to
`high - low`. Downstream smoothers (ATR/RMA) inherit that convention.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


REQUIRED = ('high', 'low', 'close')


def true_range(bars: pd.DataFrame) -> np.ndarray:
    """Bar-by-bar True Range. Returns np.ndarray length == len(bars)."""
    missing = [c for c in REQUIRED if c not in bars.columns]
    if missing:
        raise ValueError(f'bars is missing required columns: {missing}')

    high  = bars['high'].to_numpy(dtype=float)
    low   = bars['low'].to_numpy(dtype=float)
    close = bars['close'].to_numpy(dtype=float)

    prev_close = np.empty_like(close)
    prev_close[0] = np.nan
    prev_close[1:] = close[:-1]

    hl = high - low
    hc = np.abs(high - prev_close)
    lc = np.abs(low  - prev_close)

    out = np.maximum.reduce([hl, hc, lc])
    # First bar: no prev close → fall back to high-low.
    out[0] = high[0] - low[0]
    return out
