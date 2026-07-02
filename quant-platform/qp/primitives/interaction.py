"""
Touch / reject primitives — how price interacted with a level on this
bar. These are the workhorses of level-reject strategies.

    touch(bars, level, tol)   — the bar's [low, high] range crosses
                                within `tol` (absolute price units) of
                                `level`. NaN levels → False.
    touch_pct(bars, level, tol_pct)
                              — same, but `tol_pct` is a fraction of
                                the level (e.g. 0.001 = 0.1% of level).

    reject_high(bars, level, tol)
                              — the bar TOUCHED the level and the CLOSE
                                came back BELOW it. "Rejected from
                                above."
    reject_low(bars, level, tol)
                              — the bar TOUCHED the level and the CLOSE
                                came back ABOVE it. "Rejected from
                                below."

All levels are per-bar arrays (same length as `bars`) so callers can
pass in a VWAP series, a prev-day-high projection, etc.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _validate(bars: pd.DataFrame, level) -> np.ndarray:
    for col in ('high', 'low', 'close'):
        if col not in bars.columns:
            raise ValueError(f'bars is missing required column {col!r}')
    L = np.asarray(level, dtype=float)
    if L.shape != (len(bars),):
        raise ValueError(f'level must be length {len(bars)}, got {L.shape}')
    return L


def touch(bars: pd.DataFrame, level, tol: float = 0.0) -> np.ndarray:
    """True on bars where `[low - tol, high + tol]` contains `level`."""
    if tol < 0:
        raise ValueError(f'tol must be >= 0, got {tol!r}')
    L = _validate(bars, level)
    high = bars['high'].to_numpy(dtype=float)
    low  = bars['low'].to_numpy(dtype=float)
    out = np.zeros(len(bars), dtype=bool)
    valid = np.isfinite(L)
    within = (low - tol <= L) & (L <= high + tol)
    out = within & valid
    return out


def touch_pct(bars: pd.DataFrame, level, tol_pct: float) -> np.ndarray:
    """Like `touch` but `tol_pct` is a fraction of `level`."""
    if tol_pct < 0:
        raise ValueError(f'tol_pct must be >= 0, got {tol_pct!r}')
    L = _validate(bars, level)
    high = bars['high'].to_numpy(dtype=float)
    low  = bars['low'].to_numpy(dtype=float)
    tol_arr = np.abs(L) * tol_pct
    valid = np.isfinite(L)
    within = (low - tol_arr <= L) & (L <= high + tol_arr)
    return within & valid


def reject_high(bars: pd.DataFrame, level, tol: float = 0.0) -> np.ndarray:
    """Touched `level` AND closed below it."""
    L = _validate(bars, level)
    touched = touch(bars, level, tol)
    close = bars['close'].to_numpy(dtype=float)
    below = np.zeros(len(bars), dtype=bool)
    valid = np.isfinite(L) & np.isfinite(close)
    np.less(close, L, where=valid, out=below)
    return touched & below


def reject_low(bars: pd.DataFrame, level, tol: float = 0.0) -> np.ndarray:
    """Touched `level` AND closed above it."""
    L = _validate(bars, level)
    touched = touch(bars, level, tol)
    close = bars['close'].to_numpy(dtype=float)
    above = np.zeros(len(bars), dtype=bool)
    valid = np.isfinite(L) & np.isfinite(close)
    np.greater(close, L, where=valid, out=above)
    return touched & above
