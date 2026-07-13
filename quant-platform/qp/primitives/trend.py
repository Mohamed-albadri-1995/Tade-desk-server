"""
Trend primitives — make the "slope" idea a NUMBER you can see.

`rising` / `falling` in the strategy builder are just this number thresholded.
Plot `slope` on its own and you can judge with your eyes: it sits near 0 in a
choppy tape and swings to large ± values in a genuine trend — so you pick your
threshold by looking, not guessing.

Method (the exact one the strategy engine uses): fit a least-squares line over
`length` bars; the net modelled move across the window is `slope × (length-1)`.
Divide that by the standard deviation of the RESIDUALS around the fitted line →
a scale-free STRENGTH: directional move ÷ the noise that ISN'T the trend.

Why residuals (v2), not the raw window stdev (v1): in a clean trend the raw
stdev is dominated by the trend itself, so v1 saturated near ~3.3 no matter how
steep the move was — a crawling drift and a vertical run scored the same. With
residual normalization a steep clean trend scores 10-50+, a shallow noisy drift
2-4, and chop stays near 0 — so the number now RANKS trend quality instead of
just detecting it. Works on price or any indicator, any symbol, any timeframe.
"""

from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from qp.registry import primitive, Param


def slope_strength(src, length: int) -> np.ndarray:
    """Regression-slope strength of `src` over a trailing `length`-bar window:
    net modelled move ÷ stdev of the residuals around the fitted line. Shared
    by the `slope` primitive AND the builder's rising/falling test, so they
    are guaranteed identical."""
    L = np.asarray(src, dtype=float)
    n = len(L)
    out = np.full(n, np.nan)
    w = max(3, int(length))
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
        fitted = ym + slp[:, None] * (x - xm)       # the regression line itself
        # noise AROUND the trend; ddof=2 (the fit uses 2 params) so a short
        # window doesn't understate the noise and inflate the strength.
        resid_sd = (win - fitted).std(axis=1, ddof=2)
        strength = np.zeros(len(slp))
        nz = resid_sd > 1e-12
        strength[nz] = move[nz] / resid_sd[nz]
        ramp = (~nz) & (np.abs(move) > 1e-9)        # perfectly smooth ramp, zero noise
        strength[ramp] = np.sign(move[ramp]) * 1e9
        # cap so a near-perfect ramp doesn't dwarf every other value on the plot
        out[w - 1:] = np.clip(strength, -99.0, 99.0)
    return out


@primitive(
    name='slope',
    group='trend',
    description=('Trend-slope STRENGTH of the source over `length` bars: net '
                 'modelled move ÷ the noise around the fitted line. ~0 in '
                 'chop, 2-4 in a shallow drift, 10+ in a clean steep trend '
                 '(capped ±99). This is the exact number the strategy '
                 'rising/falling test thresholds — plot it to pick your '
                 'threshold by eye.'),
    params=(Param('length', 'int', default=12, min=4),),
    inputs=('source',),
)
def slope(source, length: int):
    return slope_strength(source, length)
