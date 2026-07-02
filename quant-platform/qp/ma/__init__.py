"""
STAGE 5 — Moving Average Library.

One implementation per MA. Every downstream indicator that needs a
moving average calls into here — nothing re-implements. The library
grows one function at a time; each new MA must pass validation against
TradingView before it becomes trusted.

Currently implemented:
    - sma  (verified against TradingView)
    - ema  (verified against TradingView)

Planned (add each in a follow-up commit, one at a time, with
validation): rma, wma, vwma, hma.
"""

from qp.ma.sma import sma
from qp.ma.ema import ema

__all__ = ['sma', 'ema']
