"""
CSV adapter — loads bars from a file on disk.

Expected header (case-insensitive, extras allowed and ignored):
    time, open, high, low, close, volume

`time` is Unix epoch **seconds** (this is what TradingView exports
by default). If your CSV uses ISO strings, we detect that and parse
them accordingly.

If a `volume` column is absent, volume is zero-filled — every
non-volume-based indicator (SMA/EMA/RMA/WMA/RSI/ATR/…) still works,
but VWAP and other volume-based flavours will be flat / meaningless.
"""

from __future__ import annotations

from pathlib import Path
from typing import Union

import pandas as pd

from qp.data.sources.base import Bars, Source


REQUIRED = ('time', 'open', 'high', 'low', 'close')


class CsvSource(Source):
    name = 'csv'

    def __init__(self, path: Union[str, Path]):
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f'CSV not found: {self.path}')

    def fetch(self, symbol, timeframe, start, end) -> Bars:
        df = _read_csv(self.path)

        if start is not None:
            start = pd.Timestamp(start)
            if start.tz is None:
                start = start.tz_localize('UTC')
            df = df.loc[df.index >= start]
        if end is not None:
            end = pd.Timestamp(end)
            if end.tz is None:
                end = end.tz_localize('UTC')
            df = df.loc[df.index <= end]

        return Bars(
            df=df,
            symbol=symbol or self.path.stem,
            timeframe=timeframe,
            adjusted=True,
            source=self.name,
        )


def _read_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    # Normalise column names.
    df.columns = [str(c).strip().lower() for c in df.columns]
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f'{path.name}: CSV missing required columns {missing}')

    # Parse time. Unix seconds if int/float-like; otherwise assume ISO string.
    ts = df['time']
    if pd.api.types.is_numeric_dtype(ts):
        idx = pd.to_datetime(ts, unit='s', utc=True)
    else:
        idx = pd.to_datetime(ts, utc=True)

    cols = list(REQUIRED[1:])                    # open/high/low/close
    if 'volume' in df.columns:
        cols.append('volume')

    out = df[cols].copy()
    if 'volume' not in out.columns:
        out['volume'] = 0
    out['volume'] = out['volume'].fillna(0).astype('int64')
    out.index = idx
    out.index.name = 'ts'
    return out.sort_index()
