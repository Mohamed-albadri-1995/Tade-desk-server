"""
Price-structure primitives.

- pivot_high: value equals the pivot's price on the confirmation bar (i.e.,
              `right` bars *after* the pivot itself), NaN elsewhere. Matches
              Pine `ta.pivothigh(source, left, right)`.
- pivot_low:  same for lows.
"""

from __future__ import annotations

import numpy as np

from qp.registry import primitive, Param


def _pivot(source, left: int, right: int, side: str):
    src = np.asarray(source, dtype=float)
    left  = int(left)
    right = int(right)
    n = len(src)
    out = np.full(n, np.nan)
    # Pine semantics: `v >= left values AND v > right values` (high side).
    # Left ties count as a pivot; right side must be strictly less.
    for i in range(left, n - right):
        v = src[i]
        left_win  = src[i - left: i]
        right_win = src[i + 1: i + right + 1]
        if side == 'high':
            is_pivot = (v >= left_win.max()) and (v > right_win.max())
        else:
            is_pivot = (v <= left_win.min()) and (v < right_win.min())
        if is_pivot:
            out[i + right] = v
    return out


@primitive(
    name='pivot_high',
    group='structure',
    description=('Pivot high — matches Pine `ta.pivothigh(source, left, '
                 'right)`. Returns the pivot\'s price on the confirmation '
                 'bar (right bars after the pivot), NaN elsewhere.'),
    params=(
        Param('left',  'int', default=10, min=1),
        Param('right', 'int', default=10, min=1),
    ),
    inputs=('source',),
)
def pivot_high(source, left: int, right: int):
    return _pivot(source, left, right, 'high')


@primitive(
    name='pivot_low',
    group='structure',
    description='Pivot low — matches Pine `ta.pivotlow(source, left, right)`.',
    params=(
        Param('left',  'int', default=10, min=1),
        Param('right', 'int', default=10, min=1),
    ),
    inputs=('source',),
)
def pivot_low(source, left: int, right: int):
    return _pivot(source, left, right, 'low')
