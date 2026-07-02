"""
STAGE 4 — Price Foundation.

Standard price representations. Every one is a pure function of the OHLC
columns; none of them look at time, session, or anything else. They exist
so downstream indicators can request `HLC3` without every module
re-implementing the mean-of-three.
"""

from qp.price.representations import (
    hl2, hlc3, ohlc4, typical_price, median_price, weighted_close,
)

__all__ = ['hl2', 'hlc3', 'ohlc4', 'typical_price', 'median_price', 'weighted_close']
