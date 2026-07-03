"""
STAGE 3 — Data Layer.

Source-agnostic loader with an on-disk parquet cache.

    from qp.data import load
    bars = load('SPY', timeframe='5m',
                start='2026-06-01', end='2026-06-30',
                source='yahoo', cache_dir='~/.qp-cache',
                session='regular')
    bars.df                       # tz-aware UTC DataFrame [O,H,L,C,V]

Vendor adapters live under `qp.data.sources` and implement
`qp.data.sources.base.Source.fetch(symbol, timeframe, start, end)`.
The built-in `YahooSource` needs no API key.
"""

from qp.data.cache import list_cached, clear_cache
from qp.data.loader import load
from qp.data.sources.base import Bars, Source

__all__ = ['load', 'list_cached', 'clear_cache', 'Bars', 'Source']
