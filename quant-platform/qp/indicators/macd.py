"""
MACD — Moving Average Convergence Divergence.

TradingView `ta.macd(source, fast, slow, signal)`:

    macd_line   = ema(source, fast) - ema(source, slow)
    signal_line = ema(macd_line, signal)
    histogram   = macd_line - signal_line

Defaults 12 / 26 / 9. Returns a frozen dataclass so callers can access
`.macd`, `.signal`, `.hist` explicitly instead of unpacking tuples.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from qp.ma import ema


@dataclass(frozen=True)
class MACDResult:
    macd:   np.ndarray
    signal: np.ndarray
    hist:   np.ndarray


def macd(source, fast: int = 12, slow: int = 26,
         signal: int = 9) -> MACDResult:
    if fast < 1 or slow < 1 or signal < 1:
        raise ValueError(f'fast, slow, signal must be >= 1; '
                         f'got {fast!r}, {slow!r}, {signal!r}')
    if fast >= slow:
        raise ValueError(f'fast ({fast}) must be < slow ({slow})')
    x = np.asarray(source, dtype=float)
    macd_line = ema(x, fast) - ema(x, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return MACDResult(macd=macd_line, signal=signal_line, hist=hist)
