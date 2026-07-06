"""
Rolling extreme primitives.

- highest: highest value of `source` over the last `length` bars.
           Matches Pine `ta.highest(source, length)`.
- lowest:  lowest value of `source` over the last `length` bars.
           Matches Pine `ta.lowest(source, length)`.

Typical use: `ta.highest(high, 20)` for the 20-bar breakout level.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive, Param


@primitive(
    name='highest',
    group='extremes',
    description=('Highest value of `source` over the last `length` bars '
                 '(inclusive of current bar). Matches Pine `ta.highest`.'),
    params=(Param('length', 'int', default=20, min=1),),
    inputs=('source',),
)
def highest(source, length: int):
    s = pd.Series(np.asarray(source, dtype=float))
    return s.rolling(int(length), min_periods=int(length)).max().to_numpy()


@primitive(
    name='lowest',
    group='extremes',
    description=('Lowest value of `source` over the last `length` bars '
                 '(inclusive of current bar). Matches Pine `ta.lowest`.'),
    params=(Param('length', 'int', default=20, min=1),),
    inputs=('source',),
)
def lowest(source, length: int):
    s = pd.Series(np.asarray(source, dtype=float))
    return s.rolling(int(length), min_periods=int(length)).min().to_numpy()
