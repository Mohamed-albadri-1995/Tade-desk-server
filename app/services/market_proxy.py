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
        # Per-stock memo of computed primitives, valid for one bar-cache
        # generation: bars only change when the fetch loop updates the
        # cache timestamp, so every setup/condition evaluated in the same
        # tick shares one computation of e.g. ema(length=9).
        self.__memo: dict = {}

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
        cache = self.__cache
        memo = self.__memo
        default_lookback = self.__default_lookback

        def call(stock: str, lookback: int = 0, **params):
            entry = cache.get(stock)
            generation = entry.get("timestamp") if entry else None
            try:
                key = (name, lookback, tuple(sorted(params.items())))
            except TypeError:  # unhashable param -> compute without memo
                key = None
            if key is not None:
                stock_memo = memo.get(stock)
                if stock_memo and stock_memo["generation"] == generation and key in stock_memo["values"]:
                    hit = stock_memo["values"][key]
                    # Copy containers so one script can't mutate another's view.
                    if isinstance(hit, dict):
                        return dict(hit)
                    if isinstance(hit, list):
                        return list(hit)
                    return hit
            bars = self.get_ohlcv(stock, lookback or default_lookback)
            value = primitive.fn(bars, **params)
            if key is not None:
                stock_memo = memo.get(stock)
                if stock_memo is None or stock_memo["generation"] != generation:
                    stock_memo = {"generation": generation, "values": {}}
                    memo[stock] = stock_memo
                # Store a private copy — the caller may mutate its result.
                if isinstance(value, dict):
                    stock_memo["values"][key] = dict(value)
                elif isinstance(value, list):
                    stock_memo["values"][key] = list(value)
                else:
                    stock_memo["values"][key] = value
            return value

        call.__name__ = name
        call.__doc__ = primitive.description
        return call
