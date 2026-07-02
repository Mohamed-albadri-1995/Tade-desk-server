"""
Position sizer — turns risk-per-trade (in account currency) into a
share/contract quantity.

    qty = risk_dollars / (entry_price - stop_price)

Round DOWN to the nearest whole share (or to `lot_size` if the caller
specifies fractional / futures lot sizes). Never round up — always
under-risk rather than over-risk.

For `min_qty > 0`, if the computed qty is less than `min_qty`, return
0 — the setup's stop is too wide relative to the risk budget, so the
right answer is to skip the trade.
"""

from __future__ import annotations

import math


def fixed_risk_qty(risk_dollars: float,
                   entry_price: float,
                   stop_price: float,
                   lot_size: float = 1.0,
                   min_qty: float = 0.0) -> float:
    """Return the largest qty whose |entry - stop| × qty <= risk_dollars.
    Rounded DOWN to `lot_size`."""
    if risk_dollars < 0:
        raise ValueError(f'risk_dollars must be >= 0, got {risk_dollars!r}')
    if lot_size <= 0:
        raise ValueError(f'lot_size must be > 0, got {lot_size!r}')
    distance = abs(entry_price - stop_price)
    if distance == 0:
        return 0.0
    raw = risk_dollars / distance
    q = math.floor(raw / lot_size) * lot_size
    if q < min_qty:
        return 0.0
    return q
