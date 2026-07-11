"""
Trend primitives — make the "slope" idea a NUMBER you can see.

`rising` / `falling` in the strategy builder are just this number thresholded.
Plot `slope` on its own and you can judge with your eyes: it sits near 0 in a
choppy tape and swings to large ± values in a genuine trend — so you pick your
threshold by looking, not guessing.

Method (the exact one the strategy engine uses): fit a least-squares line over
`length` bars; the net modelled move across the window is `slope × (length-1)`.
Divide that by the window's own standard deviation → a scale-free STRENGTH in
"volatility units": net directional move ÷ bar-to-bar scatter. Works on price
or any indicator, any symbol, any timeframe.
"""

from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from qp.registry import primitive, Param


def slope_strength(src, length: int) -> np.ndarray:
    """Regression-slope strength of `src` over a trailing `length`-bar window
    (net move ÷ window volatility). Shared by the `slope` primitive AND the
    builder's rising/falling test, so they are guaranteed identical."""
    L = np.asarray(src, dtype=float)
    n = len(L)
    out = np.full(n, np.nan)
    w = max(2, int(length))
    if n < w:
        return out
    win = sliding_window_view(L, w)                 # (n-w+1, w), aligned to window END
    x = np.arange(w, dtype=float)
    xm = x.mean()
    sxx = ((x - xm) ** 2).sum()
    with np.errstate(invalid='ignore', divide='ignore'):
        ym = win.mean(axis=1, keepdims=True)
        slp = ((x - xm) * (win - ym)).sum(axis=1) / sxx
        move = slp * (w - 1)
        sd = win.std(axis=1)
        strength = np.zeros(len(slp))
        nz = sd > 1e-12
        strength[nz] = move[nz] / sd[nz]
        ramp = (~nz) & (np.abs(move) > 1e-9)        # perfectly smooth ramp, ~no scatter
        strength[ramp] = np.sign(move[ramp]) * 1e9
        out[w - 1:] = strength
    return out


@primitive(
    name='slope',
    group='trend',
    description=('Trend-slope STRENGTH of the source over `length` bars: net '
                 'modelled move ÷ the window\'s own volatility. ~0 in chop, '
                 'large ± in a real trend. This is the exact number the '
                 'strategy rising/falling test thresholds — plot it to pick '
                 'your threshold by eye.'),
    params=(Param('length', 'int', default=8, min=2),),
    inputs=('source',),
)
def slope(source, length: int):
    return slope_strength(source, length)
