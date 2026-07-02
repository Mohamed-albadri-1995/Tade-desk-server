"""
Rolling N-bar highest / lowest — bar-count based, session-agnostic.

Thin wrappers on `qp.math_foundation.rolling_max` / `rolling_min` so
downstream callers can `from qp.levels import rolling_high, rolling_low`
without reaching into math_foundation.

TradingView parity: `ta.highest(series, length)` and
`ta.lowest(series, length)`.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.math_foundation import rolling_max, rolling_min


def rolling_high(source, length: int) -> np.ndarray:
    """Highest value in the last `length` bars, inclusive."""
    return rolling_max(source, length)


def rolling_low(source, length: int) -> np.ndarray:
    return rolling_min(source, length)


def bars_high(bars: pd.DataFrame, length: int) -> np.ndarray:
    """Convenience: highest high over the last `length` bars."""
    return rolling_max(bars['high'].to_numpy(dtype=float), length)


def bars_low(bars: pd.DataFrame, length: int) -> np.ndarray:
    """Convenience: lowest low over the last `length` bars."""
    return rolling_min(bars['low'].to_numpy(dtype=float), length)
