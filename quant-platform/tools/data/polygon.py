"""
Polygon.io bar loader for the compare tool.

Same contract as tools/data/alpaca.py — `load(symbol, timeframe, start,
end)` returns a tz-aware UTC DataFrame with columns [open, high, low,
close, volume] indexed by bar timestamp, parquet-cached under
~/.qp-cache/. Reads POLYGON_API_KEY from the env.

Why offer it alongside Alpaca: Polygon aggregates include full
extended-hours (premarket/afterhours) bars and go back years even on the
free tier, so the multi-day / premarket / overnight / monthly primitives
that the Alpaca IEX feed can't reach become verifiable. Raw (unadjusted)
prices, matching alpaca.py's adjustment='raw'.

Not a qp primitive — a compare-tool data adapter.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
from pathlib import Path

import pandas as pd


from tools.data import cache as _cache      # noqa: E402  the shared bar cache

# ONE DIRECTORY, DEFINED ONCE. Three loaders each declared this path, so a
# sweeper pointed at one of them would have missed the other two — and the
# whole point of a limit is that nothing escapes it.
_CACHE_DIR = _cache.DIR
_BASE = 'https://api.polygon.io'

# timeframe -> (multiplier, timespan)
_TF_MAP = {
    '1m':  (1, 'minute'),
    '2m':  (2, 'minute'),
    '5m':  (5, 'minute'),
    '15m': (15, 'minute'),
    '30m': (30, 'minute'),
    '1h':  (1, 'hour'),
    '1d':  (1, 'day'),
}


def _api_key() -> str:
    key = os.environ.get('POLYGON_API_KEY')
    if not key:
        raise RuntimeError('POLYGON_API_KEY must be set to load bars from Polygon')
    return key


def _cache_path(symbol: str, tf: str, start: pd.Timestamp, end: pd.Timestamp) -> Path:
    # 'poly_' prefix so it never collides with the Alpaca cache for the
    # same symbol/tf/window. Minute-bucketed like alpaca.py so an
    # intra-session re-fetch picks up new bars.
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = (f'poly_{symbol.upper()}_{tf}'
           f'_{start.strftime("%Y%m%dT%H%M")}'
           f'_{end.strftime("%Y%m%dT%H%M")}')
    return _CACHE_DIR / f'{key}.parquet'


def _get(url: str, tries: int = 4) -> dict:
    """GET with a small backoff for the free tier's 5 req/min rate limit
    (Polygon returns HTTP 429 when throttled)."""
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < tries - 1:
                time.sleep(2 ** attempt * 5)   # 5s, 10s, 20s
                continue
            raise RuntimeError(f'Polygon {e.code}: {e.read().decode()[:200]}') from e
    raise RuntimeError('Polygon: exhausted retries')


def load(symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp,
         feed: str = 'polygon') -> pd.DataFrame:
    """Return a tz-aware UTC DataFrame [open, high, low, close, volume]
    indexed by bar timestamp. Includes extended-hours bars."""
    if timeframe not in _TF_MAP:
        raise ValueError(f'unsupported timeframe {timeframe!r}')
    start = pd.Timestamp(start).tz_convert('UTC') if pd.Timestamp(start).tz else pd.Timestamp(start, tz='UTC')
    end   = pd.Timestamp(end).tz_convert('UTC')   if pd.Timestamp(end).tz   else pd.Timestamp(end,   tz='UTC')

    cache = _cache_path(symbol, timeframe, start, end)
    if cache.exists():
        return pd.read_parquet(cache)

    mult, span = _TF_MAP[timeframe]
    start_ms = int(start.value // 1_000_000)   # ns -> ms epoch
    end_ms   = int(end.value // 1_000_000)
    key = _api_key()
    url = (f'{_BASE}/v2/aggs/ticker/{symbol.upper()}/range/{mult}/{span}/'
           f'{start_ms}/{end_ms}?adjusted=false&sort=asc&limit=50000&apiKey={key}')

    rows: list[dict] = []
    while True:
        payload = _get(url)
        rows.extend(payload.get('results', []) or [])
        nxt = payload.get('next_url')
        if not nxt:
            break
        # next_url carries the cursor but not the key; re-append it.
        url = nxt + (f'&apiKey={key}' if 'apiKey=' not in nxt else '')

    if not rows:
        raise RuntimeError(
            f'no bars for {symbol} {timeframe} {start.date()}..{end.date()} '
            f'(Polygon free tier is end-of-day delayed — very recent bars '
            f'may be missing)')

    df = pd.DataFrame(rows)
    df['time'] = pd.to_datetime(df['t'], unit='ms', utc=True)
    df = (df.rename(columns={'o': 'open', 'h': 'high', 'l': 'low',
                             'c': 'close', 'v': 'volume'})
             .set_index('time').sort_index())
    df = df[~df.index.duplicated(keep='last')]
    df = df[['open', 'high', 'low', 'close', 'volume']].astype(float)
    try:
        df.to_parquet(cache)
    except Exception:
        pass                     # a cache that cannot be written is not an error
    # THE CACHE IS CHECKED WHERE IT GROWS. Nothing else deletes these files,
    # so the one call that creates one is the one place a limit can be
    # enforced without a cron job or a person remembering. Throttled inside;
    # never raises. See tools/data/cache.py.
    _cache.after_write()
    return df
