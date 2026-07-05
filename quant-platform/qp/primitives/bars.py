"""
Bars — the single OHLCV input type every primitive that needs bars
takes. Wrapping a tz-aware DataFrame gives the compare tool one place
to enforce invariants (tz-aware index, monotonic timestamps, no NaNs
in OHLC).

Primitives that only need a source series (like sma) take a 1-D
numpy array or pandas Series directly. Primitives that need multiple
OHLCV columns take a Bars.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Bars:
    df: pd.DataFrame

    @staticmethod
    def from_frame(df: pd.DataFrame) -> 'Bars':
        required = {'open', 'high', 'low', 'close', 'volume'}
        missing = required - set(df.columns)
        if missing:
            raise ValueError(f'Bars: missing columns {sorted(missing)}')
        if df.index.tz is None:
            raise ValueError('Bars: index must be tz-aware')
        if not df.index.is_monotonic_increasing:
            raise ValueError('Bars: index must be monotonic increasing')
        return Bars(df=df)

    @property
    def open(self)   -> np.ndarray: return self.df['open'].to_numpy(dtype=float)
    @property
    def high(self)   -> np.ndarray: return self.df['high'].to_numpy(dtype=float)
    @property
    def low(self)    -> np.ndarray: return self.df['low'].to_numpy(dtype=float)
    @property
    def close(self)  -> np.ndarray: return self.df['close'].to_numpy(dtype=float)
    @property
    def volume(self) -> np.ndarray: return self.df['volume'].to_numpy(dtype=float)
    @property
    def timestamps(self) -> pd.DatetimeIndex: return self.df.index

    def __len__(self) -> int:
        return len(self.df)
