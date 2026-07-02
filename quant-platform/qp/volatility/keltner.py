"""
Keltner Channels — EMA(source, length) ± mult × ATR(bars, atr_length).

TradingView `ta.kc(src, length, mult)` defaults to EMA basis and
`ta.tr(true)` (uses close for the "previous" component). This function
mirrors that: basis = EMA(source, length), band width = mult × ATR
using RMA-smoothed True Range over `atr_length` bars.

    basis  = ta.ema(source, length)
    band   = mult * ta.atr(atr_length)
    upper  = basis + band
    lower  = basis - band

Callers can override `atr_length` to decouple the channel width from
the basis smoothing. Some traders like ATR(20) with EMA(20); others
run EMA(20) with ATR(10).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from qp.ma import ema
from qp.volatility.atr import atr as _atr


@dataclass(frozen=True)
class KeltnerChannels:
    basis: np.ndarray
    upper: np.ndarray
    lower: np.ndarray


def keltner(bars: pd.DataFrame,
            length: int = 20,
            mult: float = 2.0,
            source: Optional[np.ndarray] = None,
            atr_length: Optional[int] = None,
            atr_method: str = 'rma') -> KeltnerChannels:
    """Compute Keltner Channels.

    - `length`: EMA period for the basis.
    - `mult`: ATR multiplier.
    - `source`: 1-D price series (defaults to close).
    - `atr_length`: ATR period (defaults to `length`).
    - `atr_method`: 'rma' | 'ema' | 'sma' (defaults to 'rma').
    """
    if length < 1:
        raise ValueError(f'length must be >= 1, got {length!r}')
    src = np.asarray(source if source is not None
                     else bars['close'].to_numpy(dtype=float), dtype=float)
    basis = ema(src, length)
    band  = mult * _atr(bars, atr_length or length, method=atr_method)
    return KeltnerChannels(basis=basis, upper=basis + band, lower=basis - band)
