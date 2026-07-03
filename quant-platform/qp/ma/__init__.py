"""
STAGE 5 — Moving Average Library.

One implementation per MA. Every downstream indicator that needs a
moving average calls into here — nothing re-implements.

Currently:
    - sma   (rolling mean façade)
    - ema   (TradingView ta.ema recursion, seeded at x[0])
    - rma   (Wilder's smoothing, seeded at SMA of first `length`)
    - wma   (linear weights, oldest→newest)
    - vwma  (volume-weighted)
    - hma   (Hull — 2·WMA(half) − WMA(len), re-smoothed by WMA(√len))

All expose the same signature `fn(x, length)` except VWMA which needs
`vwma(price, volume, length)`. Every MA seeds the same way TradingView
does so downstream chart comparisons match.
"""

from qp.ma.sma import sma
from qp.ma.ema import ema
from qp.ma.rma import rma
from qp.ma.wma import wma
from qp.ma.vwma import vwma
from qp.ma.hma import hma
from qp.ma.n_session_ma import n_session_sma
from qp.ma.anchored_sma import (
    session_sma, weekly_sma, monthly_sma, quarterly_sma, yearly_sma,
)
from qp.ma.pine_5day import pine_5day_sma

__all__ = [
    'sma', 'ema', 'rma', 'wma', 'vwma', 'hma',
    'n_session_sma', 'pine_5day_sma',
    'session_sma', 'weekly_sma', 'monthly_sma', 'quarterly_sma', 'yearly_sma',
]
