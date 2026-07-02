"""
EMA — Exponential Moving Average.

Definition (TradingView ta.ema parity):
    k        = 2 / (length + 1)
    ema[0]   = x[0]                          # TradingView seeds with the first sample
    ema[i]   = k * x[i] + (1 - k) * ema[i-1]

Note the seed: TradingView does NOT wait for `length` bars before
producing a value — it seeds with the first sample. Different
implementations (pandas' `ewm(span=length, adjust=False)`) match this
exactly.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def ema(x, length: int) -> np.ndarray:
    """Exponential moving average of `x` with span `length`.

    Matches TradingView's ta.ema bar-for-bar (verified in
    scripts/validate_ema.py).
    """
    if not isinstance(length, int) or length < 1:
        raise ValueError(f'length must be a positive integer, got {length!r}')
    s = pd.Series(np.asarray(x, dtype=float))
    return s.ewm(span=length, adjust=False, min_periods=1).mean().to_numpy()
