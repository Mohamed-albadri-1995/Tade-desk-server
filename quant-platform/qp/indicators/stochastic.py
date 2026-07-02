"""
Stochastic Oscillator — TradingView `ta.stoch`.

    lowest_low  = rolling_min(low,  length)
    highest_high = rolling_max(high, length)
    %K raw      = 100 * (close - lowest_low) / (highest_high - lowest_low)
    %K          = sma(%K raw, smooth_k)      (Slow %K)
    %D          = sma(%K, smooth_d)          (Slow %D)

Standard defaults are 14 / 3 / 3. When (highest_high - lowest_low) == 0
(flat window), TradingView shows the last valid value; here we emit 50
(neutral) so downstream comparisons don't inherit stale state — a
NaN would be strictly correct but breaks callers that expect a value.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from qp.ma import sma
from qp.math_foundation import rolling_max, rolling_min


@dataclass(frozen=True)
class StochasticResult:
    k: np.ndarray
    d: np.ndarray


def stochastic(bars: pd.DataFrame,
               length: int = 14,
               smooth_k: int = 3,
               smooth_d: int = 3) -> StochasticResult:
    if length < 1 or smooth_k < 1 or smooth_d < 1:
        raise ValueError('length, smooth_k, smooth_d must be >= 1')
    high  = bars['high'].to_numpy(dtype=float)
    low   = bars['low'].to_numpy(dtype=float)
    close = bars['close'].to_numpy(dtype=float)

    ll = rolling_min(low, length)
    hh = rolling_max(high, length)
    span = hh - ll

    with np.errstate(divide='ignore', invalid='ignore'):
        raw = np.where(span > 0, 100.0 * (close - ll) / span, 50.0)
    # Preserve NaN in the leading positions where rolling_min/max hasn't seeded.
    raw[np.isnan(ll) | np.isnan(hh)] = np.nan

    k = sma(raw, smooth_k)
    d = sma(k, smooth_d)
    return StochasticResult(k=k, d=d)
