"""
Bollinger Bands — SMA(source, length) ± mult × stdev(source, length).

Matches TradingView `ta.bb`:

    basis = ta.sma(source, length)
    dev   = mult * ta.stdev(source, length)   # ddof = 0
    upper = basis + dev
    lower = basis - dev

`source` defaults to close, so callers on OHLC data can just pass
`bars` and get the standard chart. To use HLC3 or another price
representation, compute it upstream and pass it as `source`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from qp.ma import sma
from qp.volatility.stdev import stdev


@dataclass(frozen=True)
class BollingerBands:
    basis: np.ndarray
    upper: np.ndarray
    lower: np.ndarray


def bollinger(source, length: int = 20, mult: float = 2.0) -> BollingerBands:
    """Compute Bollinger Bands over a 1-D `source`. Returns three arrays."""
    if length < 1:
        raise ValueError(f'length must be >= 1, got {length!r}')
    src = np.asarray(source, dtype=float)
    basis = sma(src, length)
    dev = mult * stdev(src, length)
    return BollingerBands(basis=basis, upper=basis + dev, lower=basis - dev)
