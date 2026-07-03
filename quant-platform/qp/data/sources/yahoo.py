"""
Yahoo Finance chart-API adapter.

Endpoint:
    https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
        ?interval={interval}&period1={unix}&period2={unix}&includePrePost=true

Free, no auth. Yahoo blocks the default python-requests User-Agent, so
we send a browser UA. Intraday history is capped by Yahoo:
    1m/2m ≈ 30 days   5m/15m/30m ≈ 60 days   60m ≈ 730 days
"""

from __future__ import annotations

import pandas as pd
import requests

from qp.data.sources.base import Bars, Source


CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}'

_UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')

_TF_TO_YAHOO = {
    '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m',
    '60m': '60m', '1h': '60m', '90m': '90m',
    '1d': '1d', 'D': '1d', '1wk': '1wk', 'W': '1wk', '1mo': '1mo', 'M': '1mo',
}


class YahooSource(Source):
    name = 'yahoo'

    def __init__(self, include_pre_post: bool = True, timeout: float = 15.0):
        self.include_pre_post = include_pre_post
        self.timeout = timeout

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
        r = requests.get(
            CHART_URL.format(symbol=symbol),
            params=params,
            headers={'User-Agent': _UA, 'Accept': 'application/json'},
            timeout=self.timeout,
        )
        r.raise_for_status()
        payload = r.json()

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


def _empty_df() -> pd.DataFrame:
    return pd.DataFrame(
        {'open': [], 'high': [], 'low': [], 'close': [], 'volume': []},
        index=pd.DatetimeIndex([], tz='UTC', name='ts'),
    )
