"""
Yahoo Finance chart-API adapter.

Endpoint:
    https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
        ?interval={interval}&period1={unix}&period2={unix}&includePrePost=true

Free, no auth token. Yahoo aggressively rate-limits datacenter IPs
(AWS/GCP/etc.) unless the request looks like a real browser: cookies
from finance.yahoo.com in the session, a Chrome User-Agent, and the
usual Accept-* / Referer / Origin headers. This adapter does that
bootstrap once per Source instance, retries on 429 with exponential
backoff, then falls through with a clear error.

Intraday history caps: 1m/2m ≈ 30 days, 5m/15m/30m ≈ 60 days, 60m ≈ 730 days.
"""

from __future__ import annotations

import time

import pandas as pd
import requests

from qp.data.sources.base import Bars, Source


CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'
COOKIE_BOOTSTRAP_URL = 'https://finance.yahoo.com/'

_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')

_BROWSER_HEADERS = {
    'User-Agent': _UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
}

_TF_TO_YAHOO = {
    '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m',
    '60m': '60m', '1h': '60m', '90m': '90m',
    '1d': '1d', 'D': '1d', '1wk': '1wk', 'W': '1wk', '1mo': '1mo', 'M': '1mo',
}

# Retry schedule (seconds) applied on 429 / transient network errors.
_BACKOFF = (2, 5, 10)


class YahooSource(Source):
    name = 'yahoo'

    def __init__(self, include_pre_post: bool = True, timeout: float = 15.0):
        self.include_pre_post = include_pre_post
        self.timeout = timeout
        self._session: requests.Session | None = None

    def _get_session(self) -> requests.Session:
        if self._session is not None:
            return self._session
        s = requests.Session()
        s.headers.update(_BROWSER_HEADERS)
        try:
            # Warm up cookies (A1/A3/GUC). Yahoo's EU edge often 302s
            # into a consent page; we don't follow past the drop.
            s.get(COOKIE_BOOTSTRAP_URL, timeout=self.timeout, allow_redirects=True)
        except requests.RequestException:
            pass  # Best-effort; chart call may still succeed.
        self._session = s
        return s

    def fetch(self, symbol, timeframe, start, end) -> Bars:
        interval = _TF_TO_YAHOO.get(timeframe)
        if interval is None:
            raise ValueError(f'unsupported timeframe {timeframe!r}')

        params = {
            'interval': interval,
            'includePrePost': 'true' if self.include_pre_post else 'false',
            'period1': str(int(pd.Timestamp(start).timestamp())),
            'period2': str(int(pd.Timestamp(end).timestamp())),
            'events': 'div,split',
        }
        payload = self._get_with_retries(
            self._get_session(),
            CHART_URL.format(symbol=symbol),
            params,
        )

        err = payload.get('chart', {}).get('error')
        if err:
            raise RuntimeError(f'Yahoo error for {symbol}: {err}')

        result = payload.get('chart', {}).get('result') or []
        if not result:
            return Bars(df=_empty_df(), symbol=symbol, timeframe=timeframe,
                        adjusted=True, source=self.name)

        res = result[0]
        ts = res.get('timestamp') or []
        if not ts:
            return Bars(df=_empty_df(), symbol=symbol, timeframe=timeframe,
                        adjusted=True, source=self.name)

        quote = (res.get('indicators', {}).get('quote') or [{}])[0]
        df = pd.DataFrame({
            'open':   quote.get('open',   []),
            'high':   quote.get('high',   []),
            'low':    quote.get('low',    []),
            'close':  quote.get('close',  []),
            'volume': quote.get('volume', []),
        }, index=pd.to_datetime(ts, unit='s', utc=True))
        df.index.name = 'ts'

        df = df.dropna(subset=['open', 'high', 'low', 'close'])
        df['volume'] = df['volume'].fillna(0).astype('int64')
        df = df.sort_index()

        return Bars(df=df, symbol=symbol, timeframe=timeframe,
                    adjusted=True, source=self.name)

    def _get_with_retries(self, session, url, params) -> dict:
        last_exc: Exception | None = None
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
                    f'Yahoo 429 Too Many Requests (attempt {attempt + 1})')
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(
            'Yahoo rate-limited this IP repeatedly. AWS/GCP/other datacenter '
            'IPs are often blocked — wait a few minutes and retry, or switch '
            f'qp.data.load(source=...) to a non-Yahoo adapter. Last: {last_exc}'
        )


def _empty_df() -> pd.DataFrame:
    return pd.DataFrame(
        {'open': [], 'high': [], 'low': [], 'close': [], 'volume': []},
        index=pd.DatetimeIndex([], tz='UTC', name='ts'),
    )
