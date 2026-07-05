"""
Moving-average primitives.

Seed primitive: `sma`. Every other MA follows the same pattern — one
short function, @primitive-decorated, matches TradingView bar-for-bar.

Add: `ema`, `wma`, `hma`, `rma`, `vwma` here as you verify each.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive, Param


@primitive(
    name='sma',
    group='ma',
    description=('Simple moving average of `source` over `length` bars. '
                 'Matches TradingView `ta.sma(source, length)` — no warmup '
                 'weirdness: NaN for the first (length-1) bars, mean of the '
                 'trailing window afterwards.'),
    params=(Param('length', 'int', default=9, min=1,
                  description='Number of bars in the average.'),),
    inputs=('source',),
)
def sma(source, length: int):
    """Return a numpy array the same length as `source`."""
    s = pd.Series(np.asarray(source, dtype=float))
    return s.rolling(int(length), min_periods=int(length)).mean().to_numpy()
