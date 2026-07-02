"""
STAGE 11 — Indicator Combinations.

Complete indicators built as compositions of lower-stage primitives.
No new math — every indicator here delegates to `qp.ma`, `qp.volatility`,
`qp.math_foundation`.

  - RSI (`rsi`)           — Wilder RSI over any 1-D source.
  - MACD (`macd`)         — EMA(fast) − EMA(slow) with signal + histogram.
  - Stochastic (`stochastic`) — %K / %D on OHLC.
  - CCI (`cci`)           — TP against mean absolute deviation.

Each returns a numpy array or a frozen dataclass (for indicators with
multiple lines). All match TradingView bar-for-bar.
"""

from qp.indicators.rsi import rsi
from qp.indicators.macd import macd, MACDResult
from qp.indicators.stochastic import stochastic, StochasticResult
from qp.indicators.cci import cci

__all__ = [
    'rsi',
    'macd', 'MACDResult',
    'stochastic', 'StochasticResult',
    'cci',
]
