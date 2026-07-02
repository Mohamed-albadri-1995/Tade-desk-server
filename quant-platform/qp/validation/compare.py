"""
Compare a platform-computed series against a reference series
(usually pasted from TradingView) and report per-bar residuals plus
the numeric summary needed to slap a VERIFIED header on the primitive.

    result = compare(computed, reference,
                     rtol=1e-6, atol=1e-8, ignore_leading_nan=True)
    result.max_abs_diff    → 3.2e-9
    result.mismatched_bars → []
    result.passes          → True

Callers dump `result` into a validation script's stdout so a human can
inspect it. If it passes, the primitive earns a `VERIFIED` header.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List

import numpy as np


@dataclass(frozen=True)
class CompareResult:
    max_abs_diff:  float
    max_rel_diff:  float
    mismatched_bars: List[int]
    n_compared:    int
    passes:        bool


def compare(computed, reference, rtol: float = 1e-6,
            atol: float = 1e-8, ignore_leading_nan: bool = True) -> CompareResult:
    a = np.asarray(computed, dtype=float)
    b = np.asarray(reference, dtype=float)
    if a.shape != b.shape:
        raise ValueError(f'shape mismatch: {a.shape} vs {b.shape}')

    both_nan = np.isnan(a) & np.isnan(b)
    a_valid = ~np.isnan(a)
    b_valid = ~np.isnan(b)
    valid = a_valid & b_valid

    # A NaN on only one side counts as a mismatch UNLESS it's a leading
    # NaN inside the first (max_leading) positions AND ignore_leading_nan.
    one_nan = a_valid ^ b_valid  # symmetric difference

    if ignore_leading_nan:
        # Find the first index where BOTH sides are valid; everything
        # before that on either side that's NaN gets excused.
        first_both_valid = np.argmax(valid) if valid.any() else len(a)
        excused = np.arange(len(a)) < first_both_valid
        one_nan = one_nan & ~excused

    diffs = np.abs(a - b)
    with np.errstate(divide='ignore', invalid='ignore'):
        rel = np.abs(diffs / np.where(b != 0, b, np.nan))
    mismatched = []
    tol = atol + rtol * np.abs(b)
    fail_mask = valid & (diffs > tol)
    fail_mask = fail_mask | one_nan
    mismatched = np.where(fail_mask)[0].tolist()

    if not valid.any():
        return CompareResult(max_abs_diff=0.0, max_rel_diff=0.0,
                             mismatched_bars=mismatched,
                             n_compared=0, passes=len(mismatched) == 0)

    max_abs = float(np.nanmax(diffs[valid])) if valid.any() else 0.0
    max_rel = float(np.nanmax(rel[valid])) if valid.any() else 0.0
    return CompareResult(
        max_abs_diff=max_abs,
        max_rel_diff=max_rel,
        mismatched_bars=mismatched,
        n_compared=int(valid.sum()),
        passes=len(mismatched) == 0,
    )
