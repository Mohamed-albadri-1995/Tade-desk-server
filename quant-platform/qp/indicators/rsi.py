"""
RSI — Relative Strength Index.

TradingView `ta.rsi(source, length)`:

    change  = source - source[1]
    up      = rma(max(change, 0), length)
    down    = rma(max(-change, 0), length)
    rs      = up / down
    rsi     = 100 - 100 / (1 + rs)

Edge cases mirror TradingView:
    - When `down == 0` and `up == 0`, RSI = neither over nor
      undersold; returns 50.
    - When `down == 0` and `up > 0`, RSI = 100.

Built from `qp.ma.rma` (Wilder smoothing) — no re-implementation of the
smoother.
"""

from __future__ import annotations

import numpy as np

from qp.ma import rma


def rsi(source, length: int = 14) -> np.ndarray:
    if length < 1:
        raise ValueError(f'length must be >= 1, got {length!r}')
    x = np.asarray(source, dtype=float)
    n = x.size
    change = np.empty(n, dtype=float)
    change[0] = 0.0
    change[1:] = x[1:] - x[:-1]

    gains  = np.where(change > 0, change, 0.0)
    losses = np.where(change < 0, -change, 0.0)

    up   = rma(gains, length)
    down = rma(losses, length)

    with np.errstate(divide='ignore', invalid='ignore'):
        rs = np.where(down != 0, up / down, np.inf)
        out = 100.0 - 100.0 / (1.0 + rs)

    # Where down is 0 but up isn't, RS = inf → RSI = 100. Handled by
    # the formula but numpy may leave nan; be explicit.
    out[np.isinf(rs)] = 100.0
    # Where both up and down are 0, RSI is undefined — TradingView shows 50.
    # This override must come AFTER the isinf fix (since 0/0 is treated
    # as inf by our np.where).
    zero_zero = (up == 0) & (down == 0)
    out[zero_zero] = 50.0
    # Leading positions where RMA hasn't seeded stay NaN.
    seed_mask = np.isnan(up) | np.isnan(down)
    out[seed_mask] = np.nan
    return out
