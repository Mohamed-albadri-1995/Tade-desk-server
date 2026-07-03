"""
Alpaca Market Data adapter — historical bars via the v2 REST endpoint.

    https://data.alpaca.markets/v2/stocks/{symbol}/bars

Auth: two headers, `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`, read
from constructor args or the standard Alpaca env vars.

Feeds:
    - 'iex'   → free IEX-only feed (15-min delayed real-time, but
                historical is available in full and matches TradingView
                closely for periods where IEX and consolidated agree).
    - 'sip'   → paid consolidated tape ($99/mo). Bar-for-bar match to
                what TradingView and most broker charts show.
    - 'otc'   → OTC-only. Rarely used for validation.

Adjustments (`adjustment` param):
    - 'raw'   → nothing applied — matches TradingView's default for
                intraday charts.
    - 'split' → applied for splits only. Matches most equity charts.
    - 'all'   → splits + dividends. Common for daily bars but changes
                intraday prices from what TV shows.

Intraday history caps:
    Alpaca IEX intraday goes back to ~2016; SIP goes further. Unlike
    Yahoo, there is no 7-day / 60-day cap. This adapter paginates as
    needed to cover any window you ask for.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import pandas as pd
import requests

from qp.data.sources.base import Bars, Source


BARS_URL = 'https://data.alpaca.markets/v2/stocks/{symbol}/bars'

# Map canonical qp timeframe → Alpaca's format.
_TF_TO_ALPACA = {
    '1m':  '1Min',   '2m':  '2Min',  '5m':  '5Min',
    '15m': '15Min',  '30m': '30Min', '60m': '1Hour', '1h': '1Hour',
    '1d':  '1Day',   'D':   '1Day',  '1w':  '1Week', 'W':  '1Week',
    '1mo': '1Month', 'M':   '1Month',
}

_BACKOFF = (2, 5, 10)


class AlpacaSource(Source):
    name = 'alpaca'

    def __init__(self,
                 api_key: Optional[str] = None,
                 api_secret: Optional[str] = None,
                 feed: str = 'iex',
                 adjustment: str = 'raw',
                 timeout: float = 20.0):
        self.api_key = api_key or os.environ.get('APCA_API_KEY_ID')
        self.api_secret = api_secret or os.environ.get('APCA_API_SECRET_KEY')
        if not self.api_key or not self.api_secret:
            raise RuntimeError(
                'Alpaca creds missing. Set APCA_API_KEY_ID and '
                'APCA_API_SECRET_KEY env vars, or pass them to AlpacaSource().'
            )
        self.feed = feed
        self.adjustment = adjustment
        self.timeout = timeout
        self._session: Optional[requests.Session] = None

    def _get_session(self) -> requests.Session:
        if self._session is not None:
            return self._session
        s = requests.Session()
        s.headers.update({
            'APCA-API-KEY-ID':     self.api_key,
            'APCA-API-SECRET-KEY': self.api_secret,
            'Accept': 'application/json',
        })
        self._session = s
        return s

    def fetch(self, symbol, timeframe, start, end) -> Bars:
        interval = _TF_TO_ALPACA.get(timeframe)
        if interval is None:
            raise ValueError(f'unsupported timeframe {timeframe!r}')

        start_iso = _to_iso(start)
        end_iso   = _to_iso(end)

        session = self._get_session()
        rows: list[dict] = []
        page_token: Optional[str] = None
        while True:
            params = {
                'timeframe':  interval,
                'start':      start_iso,
                'end':        end_iso,
                'feed':       self.feed,
                'adjustment': self.adjustment,
                'limit':      10000,
                'sort':       'asc',
            }
            if page_token:
                params['page_token'] = page_token

            payload = self._get_with_retries(
                session, BARS_URL.format(symbol=symbol), params,
            )
            rows.extend(payload.get('bars') or [])
            page_token = payload.get('next_page_token')
            if not page_token:
                break

        if not rows:
            return Bars(df=_empty_df(), symbol=symbol, timeframe=timeframe,
                        adjusted=self.adjustment != 'raw', source=self.name)

        df = pd.DataFrame(rows)
        df.index = pd.to_datetime(df['t'], utc=True)
        df.index.name = 'ts'
        df = df.rename(columns={
            'o': 'open', 'h': 'high', 'l': 'low', 'c': 'close', 'v': 'volume',
        })[['open', 'high', 'low', 'close', 'volume']]
        df = df.dropna(subset=['open', 'high', 'low', 'close'])
        df['volume'] = df['volume'].fillna(0).astype('int64')
        df = df.sort_index()

        return Bars(df=df, symbol=symbol, timeframe=timeframe,
                    adjusted=self.adjustment != 'raw', source=self.name)

    def _get_with_retries(self, session, url, params) -> dict:
        last_exc: Optional[Exception] = None
        for attempt, delay in enumerate((0,) + _BACKOFF):
            if delay:
                time.sleep(delay)
            try:
                r = session.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                last_exc = e
                continue
            if r.status_code == 429:
                last_exc = RuntimeError(
                    f'Alpaca 429 rate-limited (attempt {attempt + 1})')
                continue
            if 500 <= r.status_code < 600:
                last_exc = RuntimeError(
                    f'Alpaca {r.status_code} server error (attempt {attempt + 1})')
                continue
            if r.status_code == 403:
                raise RuntimeError(
                    'Alpaca 403 forbidden — check APCA_API_KEY_ID / '
                    'APCA_API_SECRET_KEY, and that the feed you requested '
                    f'({self.feed!r}) is available on your plan.'
                )
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f'Alpaca fetch exhausted retries: {last_exc}')


def _to_iso(ts) -> str:
    t = pd.Timestamp(ts)
    if t.tz is None:
        t = t.tz_localize('UTC')
    return t.tz_convert('UTC').strftime('%Y-%m-%dT%H:%M:%SZ')


def _empty_df() -> pd.DataFrame:
    return pd.DataFrame(
        {'open': [], 'high': [], 'low': [], 'close': [], 'volume': []},
        index=pd.DatetimeIndex([], tz='UTC', name='ts'),
    )
