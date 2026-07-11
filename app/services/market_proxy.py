"""The ``market_data`` object injected into sandboxed scripts (spec section 8).

Provides:
* ``get_ohlcv(stock, lookback) -> List[dict]``
* ``get_current_price(stock) -> float``
* Dynamic methods for every APPROVED primitive in the verified qp
  library, e.g. ``market_data.sma(stock, length=9)`` — these route to
  ``qp.REGISTRY[key].fn`` (INTEGRATION.md §2/§3).

Calls follow the library contract: bars are converted once per cache
generation via ``bars_from_dicts`` and shared across every primitive
call in the tick, source-input primitives get ``bars.<source>``
(default close), bars-input primitives get the Bars object, and results
are reduced to the latest non-NaN value (dict outputs -> dict of
floats). Only approved primitives are reachable; requesting anything
else raises. All data comes from the in-memory caches, so evaluation
makes no network calls (zero-latency guarantee).
"""

from typing import List

from app import qp_loader  # noqa: F401 — ensures the verified library is loaded

import numpy as np
import pandas as pd
import qp


def _bars_from_dicts(rows):
    """INTEGRATION.md §1 — bar dicts (UTC ISO timestamps) -> qp.Bars."""
    df = pd.DataFrame(rows)
    ts = pd.to_datetime(df["timestamp"], utc=True, format="ISO8601")
    df = (
        df.drop(columns=["timestamp"])
        .set_index(ts)
        .sort_index()[["open", "high", "low", "close", "volume"]]
        .astype(float)
    )
    df = df[~df.index.duplicated(keep="last")]
    return qp.Bars.from_frame(df)


def _latest(arr):
    """INTEGRATION.md §2 — last non-NaN value, or None if none exists."""
    a = np.asarray(arr, dtype=float)
    idx = np.where(~np.isnan(a))[0]
    return float(a[idx[-1]]) if len(idx) else None


def _approved_by_name() -> dict:
    return {meta.name: meta for meta in qp.approved_primitives().values()}


class MarketDataProxy:
    def __init__(self, market_cache: dict, default_lookback: int = 5000):
        # Double-underscore names so sandboxed scripts can't easily poke at them.
        self.__cache = market_cache
        self.__default_lookback = default_lookback
        # Per-stock memo, valid for one bar-cache generation: bars only
        # change when the fetch loop updates the cache timestamp, so every
        # setup/condition in the same tick shares one Bars build and one
        # computation of e.g. ema(length=9).
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
        """Route to an APPROVED verified primitive. Unapproved primitives
        exist in the registry but are NOT reachable from user scripts."""
        meta = _approved_by_name().get(name)
        if meta is None:
            raise AttributeError(
                f"market_data has no approved primitive '{name}' "
                "(unapproved primitives are not exposed to scripts)"
            )
        cache = self.__cache
        memo = self.__memo
        default_lookback = self.__default_lookback
        proxy = self

        def call(stock: str, lookback: int = 0, source: str = "close", **params):
            entry = cache.get(stock)
            generation = entry.get("timestamp") if entry else None
            try:
                key = (name, lookback, source, tuple(sorted(params.items())))
            except TypeError:  # unhashable param -> compute without memo
                key = None
            stock_memo = memo.get(stock)
            if key is not None and stock_memo and stock_memo["generation"] == generation:
                if key in stock_memo["values"]:
                    hit = stock_memo["values"][key]
                    return dict(hit) if isinstance(hit, dict) else hit
            if stock_memo is None or stock_memo["generation"] != generation:
                stock_memo = {"generation": generation, "values": {}, "bars": None}
                memo[stock] = stock_memo

            # One Bars object per (stock, cache generation), shared by every
            # primitive call in the tick (INTEGRATION.md §1 performance note).
            if stock_memo.get("bars") is None or lookback:
                rows = proxy.get_ohlcv(stock, lookback or default_lookback)
                bars = _bars_from_dicts(rows)
                if not lookback:
                    stock_memo["bars"] = bars
            else:
                bars = stock_memo["bars"]

            # Defaults live in meta.params (the fns take params positionally);
            # fill them in and drop unknown script-supplied keys.
            declared = {p.name: p.default for p in meta.params}
            call_params = {**declared, **{k: v for k, v in params.items() if k in declared}}

            if meta.inputs == ("bars",):
                out = meta.fn(bars, **call_params)
            else:  # ('source',)
                out = meta.fn(getattr(bars, source), **call_params)

            value = (
                {k: _latest(v) for k, v in out.items()}
                if isinstance(out, dict)
                else _latest(out)
            )
            if key is not None:
                stock_memo["values"][key] = dict(value) if isinstance(value, dict) else value
            return value

        call.__name__ = name
        call.__doc__ = meta.description
        return call
