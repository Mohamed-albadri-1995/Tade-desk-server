"""
Bars container + Source abstract base.

Every vendor adapter returns a `Bars` instance so downstream code never
knows or cares which vendor produced the data. The Bars constructor
validates the contract; if a source can't meet it, the source itself
must normalise before wrapping.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd


REQUIRED_COLS = ('open', 'high', 'low', 'close', 'volume')


@dataclass
class Bars:
    df: pd.DataFrame
    symbol: str
    timeframe: str
    adjusted: bool = True
    source: Optional[str] = None

    def __post_init__(self):
        if not isinstance(self.df.index, pd.DatetimeIndex):
            raise ValueError('Bars.df must have a DatetimeIndex')
        if self.df.index.tz is None:
            raise ValueError('Bars.df index must be tz-aware')
        missing = [c for c in REQUIRED_COLS if c not in self.df.columns]
        if missing:
            raise ValueError(f'Bars.df missing required columns: {missing}')
        if len(self.df) > 1 and not self.df.index.is_monotonic_increasing:
            raise ValueError('Bars.df index must be monotonic increasing')

    def __len__(self) -> int:
        return len(self.df)

    def __repr__(self) -> str:
        n = len(self.df)
        if n == 0:
            return f'<Bars {self.symbol} {self.timeframe} empty>'
        return (f'<Bars {self.symbol} {self.timeframe} '
                f'{n} bars {self.df.index[0]}→{self.df.index[-1]}>')


class Source(ABC):
    """Abstract vendor adapter. Subclass and implement `fetch`."""

    name: str = 'unknown'

    @abstractmethod
    def fetch(self, symbol: str, timeframe: str,
              start: pd.Timestamp, end: pd.Timestamp) -> Bars:
        """Return validated Bars for [start, end]. Must be idempotent."""
