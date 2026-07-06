"""
Oscillator primitives.

- rsi: Wilder RSI. Matches TradingView `ta.rsi(source, length)` — gains
       and losses smoothed via rma, RSI = 100 - 100/(1 + avg_gain/avg_loss).
"""

from __future__ import annotations

import numpy as np

from qp.registry import primitive, Param
from qp.primitives.ma import rma as _rma


@primitive(
    name='rsi',
    group='osc',
    description=('Wilder RSI. Matches TradingView `ta.rsi(source, length)` '
                 '— rma-smoothed gains/losses, `100 - 100/(1 + avg_gain/'
                 'avg_loss)`. Value in [0,100]. NaN for first `length` bars.'),
    params=(Param('length', 'int', default=14, min=1),),
    inputs=('source',),
)
def rsi(source, length: int):
    src = np.asarray(source, dtype=float)
    length = int(length)
    n = len(src)
    out = np.full(n, np.nan)
    if n < length + 1:
        return out
    diff = np.diff(src, prepend=src[0])  # diff[0] = 0
    gain = np.where(diff > 0, diff, 0.0)
    loss = np.where(diff < 0, -diff, 0.0)
    # rma of gain/loss, skipping the artificial diff[0]=0 seed contribution
    # (matches Pine: rsi is computed on ta.change(source), first bar → NaN).
    gain[0] = np.nan
    loss[0] = np.nan
    avg_gain = _rma(gain, length)
    avg_loss = _rma(loss, length)
    with np.errstate(divide='ignore', invalid='ignore'):
        rs = np.where(avg_loss == 0, np.inf, avg_gain / avg_loss)
        out = 100.0 - 100.0 / (1.0 + rs)
    # avg_gain / avg_loss are NaN where rma isn't primed; that propagates.
    out[np.isnan(avg_gain) | np.isnan(avg_loss)] = np.nan
    return out
