"""The ``market_data`` object injected into sandboxed scripts (spec section 8).

Provides:
* ``get_ohlcv(stock, lookback) -> List[dict]``
* ``get_current_price(stock) -> float``
* Dynamic methods for every approved primitive in the qp library,
  e.g. ``market_data.sma(stock, length=9)`` — these route internally to
  ``qp.REGISTRY[key].fn``.

All data comes from the in-memory caches, so script evaluation makes no
network calls (zero-latency guarantee).
"""

from typing import List

import qp


class MarketDataProxy:
    def __init__(self, market_cache: dict, default_lookback: int = 5000):
        # Double-underscore names so sandboxed scripts can't easily poke at them.
        self.__cache = market_cache
        self.__default_lookback = default_lookback

    def get_ohlcv(self, stock: str, lookback: int) -> List[dict]:
        entry = self.__cache.get(stock)
        if not entry or not entry.get("bars"):
            raise KeyError(f"no market data cached for {stock}")
        return list(entry["bars"][-lookback:])

    def get_current_price(self, stock: str) -> float:
        entry = self.__cache.get(stock)
        if not entry or entry.get("price") is None:
            raise KeyError(f"no current price cached for {stock}")
        return float(entry["price"])

    def __getattr__(self, name: str):
        primitive = qp.REGISTRY.get(name)
        if primitive is None:
            raise AttributeError(f"market_data has no attribute or primitive '{name}'")

        def call(stock: str, lookback: int = 0, **params):
            bars = self.get_ohlcv(stock, lookback or self.__default_lookback)
            return primitive.fn(bars, **params)

        call.__name__ = name
        call.__doc__ = primitive.description
        return call
