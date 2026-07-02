"""
Rolling window operations. Pure math — knows nothing about markets.

Every function accepts a 1-D array-like (list / numpy array / pandas
Series) and returns a numpy array of the same length. Leading positions
before there's enough data return NaN, matching what TradingView shows
for a bar index shorter than the lookback.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _to_series(x) -> pd.Series:
    """Coerce input to a pandas Series so we get its rolling machinery
    without having to re-implement variance calculators. Cheap because
    pandas will avoid a copy when x is already a Series."""
    if isinstance(x, pd.Series):
        return x
    return pd.Series(np.asarray(x, dtype=float))


def _validate_length(x, length: int) -> None:
    if not isinstance(length, int) or length < 1:
        raise ValueError(f'length must be a positive integer, got {length!r}')


def rolling_mean(x, length: int) -> np.ndarray:
    """Rolling arithmetic mean over the last `length` samples.

    Leading (length - 1) positions are NaN — matches TradingView's
    behavior of showing "no line" until enough bars exist.
    """
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).mean().to_numpy()


def rolling_sum(x, length: int) -> np.ndarray:
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).sum().to_numpy()


def rolling_std(x, length: int, ddof: int = 0) -> np.ndarray:
    """Rolling standard deviation.

    ddof=0 (population) matches TradingView's ta.stdev.
    """
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).std(ddof=ddof).to_numpy()


def rolling_variance(x, length: int, ddof: int = 0) -> np.ndarray:
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).var(ddof=ddof).to_numpy()


def rolling_max(x, length: int) -> np.ndarray:
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).max().to_numpy()


def rolling_min(x, length: int) -> np.ndarray:
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).min().to_numpy()


def rolling_median(x, length: int) -> np.ndarray:
    _validate_length(x, length)
    s = _to_series(x)
    return s.rolling(window=length, min_periods=length).median().to_numpy()
