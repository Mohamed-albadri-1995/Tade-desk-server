"""
STAGE 7 — Volatility Library.

Every volatility measure trading platforms expose to end users, expressed
once in pure math:

- True Range (`true_range`) — bar-by-bar TR.
- Average True Range (`atr`) — smoothed TR, three smoothings supported.
- Rolling standard deviation (`stdev`) — thin wrapper over
  `qp.math_foundation.rolling_std` so downstream volatility code can
  live inside this module.
- Bollinger Bands (`bollinger`) — SMA ± mult × stdev.
- Keltner Channels (`keltner`) — EMA ± mult × ATR.

Every function has TradingView parity built into its docstring, and a
matching test in `tests/test_volatility.py`.
"""

from qp.volatility.true_range import true_range
from qp.volatility.atr import atr
from qp.volatility.stdev import stdev
from qp.volatility.bollinger import bollinger, BollingerBands
from qp.volatility.keltner import keltner, KeltnerChannels

__all__ = [
    'true_range',
    'atr',
    'stdev',
    'bollinger', 'BollingerBands',
    'keltner', 'KeltnerChannels',
]
