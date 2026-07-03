"""
`load(...)` — public entry to the data layer.

Signature is intentionally forgiving:
    - `source` may be a Source **instance** (for tests / custom vendors)
      OR a **string** name like 'yahoo' (dispatched to a built-in class).
    - `cache_dir` is optional; when set, requests are memoised to
      parquet keyed by (source, symbol, timeframe, start, end).
    - `session` may be 'regular' | 'premarket' | 'afterhours' |
      'extended' | 'all' | None; anything but None/all is filtered via
      `qp.session`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Union

import pandas as pd

from qp.data import cache as _cache
from qp.data.sources.base import Bars, Source
from qp.data.sources.yahoo import YahooSource


def load(
    symbol: str,
    timeframe: str = '5m',
    start: Optional[Union[str, pd.Timestamp]] = None,
    end: Optional[Union[str, pd.Timestamp]] = None,
    source: Union[str, Source] = 'yahoo',
    cache_dir: Optional[Union[str, Path]] = None,
    session: Optional[str] = None,
) -> Bars:
    src = _resolve_source(source)

    if start is None or end is None:
        end   = pd.Timestamp.now(tz='UTC') if end   is None else pd.Timestamp(end)
        start = end - pd.Timedelta(days=5)  if start is None else pd.Timestamp(start)
    else:
        start = pd.Timestamp(start)
        end   = pd.Timestamp(end)
    if start.tz is None: start = start.tz_localize('UTC')
    if end.tz   is None: end   = end.tz_localize('UTC')

    bars = None
    if cache_dir is not None:
        bars = _cache.read(Path(cache_dir), src.name, symbol, timeframe, start, end)

    if bars is None:
        bars = src.fetch(symbol, timeframe, start, end)
        if cache_dir is not None:
            _cache.write(Path(cache_dir), bars, start, end)

    if session and session != 'all':
        bars = _apply_session_filter(bars, session)

    return bars


def _resolve_source(source: Union[str, Source]) -> Source:
    if isinstance(source, Source):
        return source
    if source == 'yahoo':
        return YahooSource()
    raise ValueError(f'unknown source {source!r}')


def _apply_session_filter(bars: Bars, session: str) -> Bars:
    from qp.session import US_EQUITIES, session_for_bars
    if len(bars.df) == 0:
        return bars
    labels = session_for_bars(bars.df, US_EQUITIES)
    if session == 'regular':
        mask = labels == 'regular'
    elif session == 'premarket':
        mask = labels == 'premarket'
    elif session == 'afterhours':
        mask = labels == 'after_hours'
    elif session == 'extended':
        mask = labels.isin(['premarket', 'after_hours'])
    else:
        raise ValueError(f'unknown session {session!r}')
    filtered_df = bars.df.loc[mask]
    return Bars(df=filtered_df, symbol=bars.symbol, timeframe=bars.timeframe,
                adjusted=bars.adjusted, source=bars.source)
