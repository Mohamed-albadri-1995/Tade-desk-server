"""Source adapters — one file per vendor. Register a new source by
subclassing `Source`, wiring it into `qp.data.loader._resolve_source`."""

from qp.data.sources.base import Bars, Source
from qp.data.sources.csv import CsvSource
from qp.data.sources.yahoo import YahooSource
from qp.data.sources.alpaca import AlpacaSource

__all__ = ['Bars', 'Source', 'YahooSource', 'CsvSource', 'AlpacaSource']
