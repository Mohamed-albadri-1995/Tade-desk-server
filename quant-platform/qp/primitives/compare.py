"""
Bar-by-bar comparison primitives — the boolean building blocks that
every condition in the DSL will eventually delegate to.

Every function takes 1-D arrays of equal length and returns a boolean
array of the same length. NaN on either side → False (a comparison
against unknown is not a signal).

Names match TradingView's mental model:
    - above / below              — strict inequality per bar.
    - above_equal / below_equal  — non-strict.
"""

from __future__ import annotations

import numpy as np


def _align(a, b):
    A = np.asarray(a, dtype=float)
    B = np.asarray(b, dtype=float)
    if A.shape != B.shape:
        raise ValueError(f'shape mismatch: {A.shape} vs {B.shape}')
    return A, B


def above(a, b) -> np.ndarray:
    """`a > b` per bar. NaN either side → False."""
    A, B = _align(a, b)
    valid = np.isfinite(A) & np.isfinite(B)
    out = np.zeros(A.shape, dtype=bool)
    np.greater(A, B, where=valid, out=out)
    return out


def below(a, b) -> np.ndarray:
    A, B = _align(a, b)
    valid = np.isfinite(A) & np.isfinite(B)
    out = np.zeros(A.shape, dtype=bool)
    np.less(A, B, where=valid, out=out)
    return out


def above_equal(a, b) -> np.ndarray:
    A, B = _align(a, b)
    valid = np.isfinite(A) & np.isfinite(B)
    out = np.zeros(A.shape, dtype=bool)
    np.greater_equal(A, B, where=valid, out=out)
    return out


def below_equal(a, b) -> np.ndarray:
    A, B = _align(a, b)
    valid = np.isfinite(A) & np.isfinite(B)
    out = np.zeros(A.shape, dtype=bool)
    np.less_equal(A, B, where=valid, out=out)
    return out
