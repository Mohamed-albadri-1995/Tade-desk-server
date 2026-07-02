"""
Crossover / crossunder primitives — TradingView `ta.crossover` /
`ta.crossunder` parity.

    crossover(a, b)[i]  == True  iff a[i] > b[i] AND a[i-1] <= b[i-1]
    crossunder(a, b)[i] == True  iff a[i] < b[i] AND a[i-1] >= b[i-1]

The first bar is always False (no previous value). NaN on either side
of either bar → False.
"""

from __future__ import annotations

import numpy as np


def _align(a, b):
    A = np.asarray(a, dtype=float)
    B = np.asarray(b, dtype=float)
    if A.shape != B.shape:
        raise ValueError(f'shape mismatch: {A.shape} vs {B.shape}')
    return A, B


def crossover(a, b) -> np.ndarray:
    """True on the bar where `a` crosses from ≤ to > `b`."""
    A, B = _align(a, b)
    n = A.size
    out = np.zeros(n, dtype=bool)
    if n < 2:
        return out
    prev_valid = np.isfinite(A[:-1]) & np.isfinite(B[:-1])
    curr_valid = np.isfinite(A[1:])  & np.isfinite(B[1:])
    valid = prev_valid & curr_valid
    fire = (A[1:] > B[1:]) & (A[:-1] <= B[:-1]) & valid
    out[1:] = fire
    return out


def crossunder(a, b) -> np.ndarray:
    A, B = _align(a, b)
    n = A.size
    out = np.zeros(n, dtype=bool)
    if n < 2:
        return out
    prev_valid = np.isfinite(A[:-1]) & np.isfinite(B[:-1])
    curr_valid = np.isfinite(A[1:])  & np.isfinite(B[1:])
    valid = prev_valid & curr_valid
    fire = (A[1:] < B[1:]) & (A[:-1] >= B[:-1]) & valid
    out[1:] = fire
    return out


def cross(a, b) -> np.ndarray:
    """`crossover(a, b) OR crossunder(a, b)` — TradingView `ta.cross`."""
    return crossover(a, b) | crossunder(a, b)
