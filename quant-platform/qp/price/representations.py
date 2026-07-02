"""
Price representations. Each function takes a bars DataFrame with
columns `open`, `high`, `low`, `close` (and `volume` where noted) and
returns a numpy array of the same length.

Every representation matches TradingView's built-in equivalent name for
name — that's the whole point.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


REQUIRED = ('open', 'high', 'low', 'close')


def _check_ohlc(bars: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED if c not in bars.columns]
    if missing:
        raise ValueError(f'bars is missing required columns: {missing}')


def hl2(bars: pd.DataFrame) -> np.ndarray:
    """(high + low) / 2. TradingView `hl2`."""
    _check_ohlc(bars)
    return ((bars['high'].to_numpy(dtype=float) + bars['low'].to_numpy(dtype=float)) / 2.0)


def hlc3(bars: pd.DataFrame) -> np.ndarray:
    """(high + low + close) / 3. TradingView `hlc3`, aka typical price."""
    _check_ohlc(bars)
    return ((bars['high'].to_numpy(dtype=float)
             + bars['low'].to_numpy(dtype=float)
             + bars['close'].to_numpy(dtype=float)) / 3.0)


def ohlc4(bars: pd.DataFrame) -> np.ndarray:
    """(open + high + low + close) / 4. TradingView `ohlc4`."""
    _check_ohlc(bars)
    return ((bars['open'].to_numpy(dtype=float)
             + bars['high'].to_numpy(dtype=float)
             + bars['low'].to_numpy(dtype=float)
             + bars['close'].to_numpy(dtype=float)) / 4.0)


def typical_price(bars: pd.DataFrame) -> np.ndarray:
    """Alias for hlc3 — some traders think of it as typical, others as
    hlc3. Same math."""
    return hlc3(bars)


def median_price(bars: pd.DataFrame) -> np.ndarray:
    """Alias for hl2. Same math."""
    return hl2(bars)


def weighted_close(bars: pd.DataFrame) -> np.ndarray:
    """(high + low + 2 * close) / 4. TradingView `wclose`. Weights the
    close more heavily than hl2/hlc3, useful when downstream logic wants
    the close's information content amplified."""
    _check_ohlc(bars)
    return ((bars['high'].to_numpy(dtype=float)
             + bars['low'].to_numpy(dtype=float)
             + 2.0 * bars['close'].to_numpy(dtype=float)) / 4.0)
