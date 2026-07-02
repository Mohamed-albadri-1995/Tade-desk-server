"""
Basic transforms — change, ROC, percent change, slope, linear regression.

All work on 1-D array-likes. None of them know what "close" or "volume"
is; that's the whole point of the stage-3 separation. You can compute
`slope(vwap)`, `slope(ema9)`, `slope(bb_middle)`, `slope(anything)` with
the same function.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
import pandas as pd


def _asarray(x) -> np.ndarray:
    return np.asarray(x, dtype=float)


def change(x, offset: int = 1) -> np.ndarray:
    """x[i] - x[i - offset]. Leading positions NaN.

    Matches TradingView's ta.change(source, length=1) exactly for the
    default offset.
    """
    if not isinstance(offset, int) or offset < 1:
        raise ValueError(f'offset must be a positive integer, got {offset!r}')
    a = _asarray(x)
    out = np.full_like(a, np.nan, dtype=float)
    if a.size > offset:
        out[offset:] = a[offset:] - a[:-offset]
    return out


def difference(x, offset: int = 1) -> np.ndarray:
    """Alias for change() — kept because some traders think in "difference"."""
    return change(x, offset)


def roc(x, length: int) -> np.ndarray:
    """Rate of change (percentage), TradingView's ta.roc:
        roc[i] = (x[i] - x[i - length]) / x[i - length] * 100
    NaN where the denominator would be zero or the lookback isn't
    reachable.
    """
    if not isinstance(length, int) or length < 1:
        raise ValueError(f'length must be a positive integer, got {length!r}')
    a = _asarray(x)
    out = np.full_like(a, np.nan, dtype=float)
    if a.size > length:
        prev = a[:-length]
        curr = a[length:]
        # Avoid divide-by-zero warnings; keep NaN in those slots.
        with np.errstate(divide='ignore', invalid='ignore'):
            out[length:] = np.where(prev != 0, (curr - prev) / prev * 100.0, np.nan)
    return out


def pct_change(x, length: int = 1) -> np.ndarray:
    """Fractional (not percentage) change over `length` samples.

    Where `roc` returns 5.0 meaning "5%", `pct_change` returns 0.05.
    Useful when downstream math treats it as a coefficient (e.g. inside
    a compounding calculation).
    """
    return roc(x, length) / 100.0


def normalize(x, method: str = 'minmax') -> np.ndarray:
    """Rescale a series to [0, 1] (minmax) or zero-mean unit-std (zscore).
    Constant inputs return zeros (avoids /0 blow-ups)."""
    a = _asarray(x)
    if method == 'minmax':
        lo, hi = np.nanmin(a), np.nanmax(a)
        if hi == lo:
            return np.zeros_like(a)
        return (a - lo) / (hi - lo)
    if method == 'zscore':
        mu, sd = np.nanmean(a), np.nanstd(a)
        if sd == 0:
            return np.zeros_like(a)
        return (a - mu) / sd
    raise ValueError(f'unknown normalize method: {method!r}')


def linear_regression(x, length: int) -> Tuple[np.ndarray, np.ndarray]:
    """Rolling ordinary-least-squares regression fit of the last `length`
    samples of `x` against 0..length-1.

    Returns (slope_array, intercept_array) — both length == len(x), NaN
    where the window isn't full. Matches TradingView's ta.linreg by
    computing the same OLS-on-a-window fit; TradingView's `linreg`
    returns the projected value at the current bar which is
    slope*(length-1) + intercept.
    """
    if not isinstance(length, int) or length < 2:
        raise ValueError(f'length must be an integer ≥ 2, got {length!r}')
    a = _asarray(x)
    n = a.size
    slopes = np.full(n, np.nan, dtype=float)
    intercepts = np.full(n, np.nan, dtype=float)
    if n < length:
        return slopes, intercepts

    # Precompute x-axis (0..length-1) statistics once.
    ax = np.arange(length, dtype=float)
    ax_mean = ax.mean()
    ax_dev  = ax - ax_mean
    ax_ss   = np.sum(ax_dev ** 2)

    for i in range(length - 1, n):
        window = a[i - length + 1: i + 1]
        y_mean = np.nanmean(window)
        num = np.sum(ax_dev * (window - y_mean))
        m = num / ax_ss
        b = y_mean - m * ax_mean
        slopes[i]     = m
        intercepts[i] = b
    return slopes, intercepts


def slope(x, length: int) -> np.ndarray:
    """Slope (rise / run per bar) of the OLS regression of the last
    `length` samples. Convenience wrapper over linear_regression."""
    m, _ = linear_regression(x, length)
    return m


def angle_deg(x, length: int) -> np.ndarray:
    """Slope expressed as an angle in degrees. Useful when comparing
    slopes across series with different y-units (rescale to z-score
    first if strict comparability matters)."""
    return np.degrees(np.arctan(slope(x, length)))


def acceleration(x, length: int) -> np.ndarray:
    """Change of the slope — second derivative on the rolling window.
    Positive = trend steepening in the same direction.
    """
    return change(slope(x, length))
