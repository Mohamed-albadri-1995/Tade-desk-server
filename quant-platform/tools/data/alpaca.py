"""
Bar loader for the compare tool.

Reads Alpaca env creds (APCA_API_KEY_ID + APCA_API_SECRET_KEY), fetches
1-min bars via the v2 REST API, caches to parquet under ~/.qp-cache/.
Only source the compare tool uses — deliberately single-source so
verification numbers don't drift by which adapter was picked.

Not a qp primitive. Lives under tools/ because it's the compare
tool's job, not a math one.
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlencode

import pandas as pd


_CACHE_DIR = Path.home() / '.qp-cache'
_BASE = 'https://data.alpaca.markets/v2/stocks'

_TF_MAP = {'1m': '1Min', '2m': '2Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
           '1h': '1Hour', '1d': '1Day'}


def _headers() -> dict:
    key = os.environ.get('APCA_API_KEY_ID')
    sec = os.environ.get('APCA_API_SECRET_KEY')
    if not key or not sec:
        raise RuntimeError(
            'APCA_API_KEY_ID + APCA_API_SECRET_KEY must be set to load bars')
    return {'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': sec}


def _cache_path(symbol: str, tf: str, start: pd.Timestamp, end: pd.Timestamp) -> Path:
    # Minute-bucket both endpoints so an intra-session re-fetch (end moves
    # forward every 5min because compare_server floors to 5min) busts the
    # cache and picks up newer bars.
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = (f'{symbol.upper()}_{tf}'
           f'_{start.strftime("%Y%m%dT%H%M")}'
           f'_{end.strftime("%Y%m%dT%H%M")}')
    return _CACHE_DIR / f'{key}.parquet'


def load(symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp,
         feed: str = 'iex') -> pd.DataFrame:
    """Return a tz-aware UTC DataFrame with columns
    [open, high, low, close, volume] indexed by bar timestamp."""
    if timeframe not in _TF_MAP:
        raise ValueError(f'unsupported timeframe {timeframe!r}')
    start = pd.Timestamp(start).tz_convert('UTC') if pd.Timestamp(start).tz else pd.Timestamp(start, tz='UTC')
    end   = pd.Timestamp(end).tz_convert('UTC')   if pd.Timestamp(end).tz   else pd.Timestamp(end,   tz='UTC')

    cache = _cache_path(symbol, timeframe, start, end)
    if cache.exists():
        return pd.read_parquet(cache)

    rows: list[dict] = []
    page = None
    while True:
        params = {
            'symbols':   symbol.upper(),
            'timeframe': _TF_MAP[timeframe],
            'start':     start.isoformat(),
            'end':       end.isoformat(),
            'limit':     '10000',
            'adjustment': 'raw',
            'feed':      feed,
        }
        if page: params['page_token'] = page
        # urlencode handles the '+' and ':' in ISO timestamps — bare
        # concatenation would send raw '+' which Alpaca decodes as space.
        url = f'{_BASE}/bars?' + urlencode(params)
        req = urllib.request.Request(url, headers=_headers())
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f'Alpaca {e.code}: {e.read().decode()[:200]}') from e
        bars = payload.get('bars', {}).get(symbol.upper(), []) or []
        rows.extend(bars)
        page = payload.get('next_page_token')
        if not page:
            break

    if not rows:
        raise RuntimeError(f'no bars for {symbol} {timeframe} {start.date()}..{end.date()}')

    df = pd.DataFrame(rows)
    df['t'] = pd.to_datetime(df['t'], utc=True)
    df = (df.rename(columns={'t': 'time', 'o': 'open', 'h': 'high',
                             'l': 'low', 'c': 'close', 'v': 'volume'})
             .set_index('time').sort_index())
    df = df[['open', 'high', 'low', 'close', 'volume']].astype(float)
    df.to_parquet(cache)
    return df
