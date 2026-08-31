"""
Yahoo bar loader for the chart/compare tools.

Same contract as tools/data/alpaca.py and tools/data/polygon.py —
`load(symbol, timeframe, start, end)` returns a tz-aware UTC DataFrame with
columns [open, high, low, close, volume] indexed by bar timestamp, cached to
parquet under ~/.qp-cache/.

WHY A THIRD LOADER. The other two cannot serve a decision taken during the
session, and one setup needs exactly that:

  polygon  the feed the reference numbers were derived on, and a day behind on
           the free plan — at 10:00 on Monday it holds Friday. It also costs one
           request per symbol against a five-a-minute cap, so a forty-name card
           list is impossible on it even for a past date.
  alpaca   fast and multi-symbol, but the free tier is the IEX feed: measured on
           one morning it carried 0.17M shares of AAPL where the consolidated
           tape carried 4.2M.

Yahoo answers immediately, returns a whole session per request, and reports the
consolidated tape. Measured against Polygon on the same morning the two agree
on VWAP to within 0.06% — which matters because the setup this exists for
places its stop AT the VWAP.

It is not a replacement for polygon in backtests. Polygon reaches back years;
this reaches back about a month at 1-minute resolution, which is the range
Yahoo serves. Use it for live and recent-session work, and polygon for history.

Not a qp primitive. Lives under tools/ because it is a data adapter, not maths.
"""

from __future__ import annotations

import json
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlencode

import pandas as pd


from tools.data import cache as _cache      # noqa: E402  the shared bar cache

# ONE DIRECTORY, DEFINED ONCE. Three loaders each declared this path, so a
# sweeper pointed at one of them would have missed the other two — and the
# whole point of a limit is that nothing escapes it.
_CACHE_DIR = _cache.DIR
_HOSTS = ('query1.finance.yahoo.com', 'query2.finance.yahoo.com')
_HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
    'Accept': 'application/json',
}

# Yahoo's own interval names. It has no 2-minute bar, and its intraday history
# shortens as the interval does — 1m reaches back about a month, and asking for
# more silently returns less rather than erroring.
_TF_MAP = {'1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
           '1h': '60m', '1d': '1d'}

# How far back each interval is actually served. Requesting beyond it returns a
# short frame, so the range is chosen to match rather than to hope.
_MAX_DAYS = {'1m': 30, '5m': 60, '15m': 60, '30m': 60, '1h': 730, '1d': 3650}


def _cache_path(symbol: str, tf: str, start: pd.Timestamp, end: pd.Timestamp,
                prepost: bool = False) -> Path:
    # Both endpoints bucketed to the minute, so a re-fetch during the session
    # busts the cache and picks up bars that have appeared since. Without this
    # a 10:00 decision could be served the frame fetched at 09:55.
    #
    # PREPOST IS PART OF THE KEY. It changes which BARS come back, not how they
    # are formatted, so a regular-hours frame served from cache to a caller
    # that asked for extended hours is silently the wrong window — and the
    # caller cannot tell, because a session with no premarket looks exactly
    # like a stock that did not trade before the open.
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    s = start.floor('min').strftime('%Y%m%dT%H%M')
    e = end.floor('min').strftime('%Y%m%dT%H%M')
    tag = '_ext' if prepost else ''
    return _CACHE_DIR / f'yahoo_{symbol.upper()}_{tf}{tag}_{s}_{e}.parquet'


def _range_for(tf: str, start: pd.Timestamp, end: pd.Timestamp) -> str:
    """Yahoo takes a `range` rather than two timestamps for intraday.

    Asking for a range and filtering locally avoids period1/period2, whose
    timezone handling is the usual source of an off-by-one-session bug.

    THE RANGE MUST BE ONE YAHOO ALLOWS FOR THE INTERVAL, and that is narrower
    than it looks. `interval=1m&range=3mo` is not "more than it has" — it is a
    422, no data at all. The first version of this computed the range from the
    span qp asked for, which for a strategy referencing session VWAP and window
    levels is a 40-day floor, so every 1-minute request became 3mo and every one
    of them failed.

    Yahoo serves roughly a month of 1-minute history and at most a week per
    request, so 5d is the ceiling there whatever was asked for. That is enough
    for this loader's job: it exists for the live decision and recent sessions,
    and anything needing real history uses polygon.
    """
    span = max(1, int((end - start).total_seconds() // 86400) + 1)
    days = min(span + 2, _MAX_DAYS.get(tf, 30))   # +2 so a weekend cannot eat it
    tokens = _RANGE_TOKENS.get(tf, _RANGE_TOKENS['1d'])
    for limit, token in tokens:
        if days <= limit:
            return token
    return tokens[-1][1]


# What each interval may actually be asked for. Ordered smallest first; the
# last entry is the ceiling, and asking beyond it is a 422 rather than a
# truncated answer.
# MEASURED against the service, not read from documentation — see
# chart/tests/tools_yahoo_limits.py, which is what produced these. The first
# version of this table was guessed and had 5m and 15m reaching 3mo; both
# answer 422 there, so every 5- and 15-minute request beyond a month returned
# nothing at all.
#
# Measured 2026-08-09:
#   1m   5d      1mo and beyond → 422
#   5m   1mo     3mo and beyond → 422
#   15m  1mo     3mo and beyond → 422
#   1h   1y      not probed past 1y
#   1d   1y      not probed past 1y
#
# The last two are capped at what was actually seen to work rather than at what
# is probably allowed. Being conservative costs some history and nothing else;
# being wrong costs every bar, because the failure mode here is 422 rather than
# a short answer. Re-run the probe with the longer ranges to raise them.
_RANGE_TOKENS = {
    '1m':  [(1, '1d'), (5, '5d')],
    '5m':  [(1, '1d'), (5, '5d'), (30, '1mo')],
    '15m': [(1, '1d'), (5, '5d'), (30, '1mo')],
    '30m': [(1, '1d'), (5, '5d'), (30, '1mo')],
    '1h':  [(5, '5d'), (30, '1mo'), (90, '3mo'), (365, '1y')],
    '1d':  [(5, '5d'), (30, '1mo'), (90, '3mo'), (365, '1y')],
}


def _fetch(symbol: str, params: dict) -> dict:
    last = None
    for host in _HOSTS:
        url = f'https://{host}/v8/finance/chart/{symbol.upper()}?' + urlencode(params)
        req = urllib.request.Request(url, headers=_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = json.loads(r.read().decode())
            result = ((body.get('chart') or {}).get('result') or [None])[0]
            if result:
                return result
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError) as e:
            last = e
    # The parameters are in the message on purpose. This failed once as a bare
    # "HTTP Error 422", which says nothing about WHICH combination Yahoo
    # refused — and the answer was interval=1m with range=3mo, forty lines away
    # in a history floor. An error that names what was asked for is the
    # difference between a minute and an afternoon.
    asked = f"interval={params.get('interval')} range={params.get('range')}"
    raise RuntimeError(f'Yahoo returned no chart for {symbol} ({asked}): {last}')


def load(symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp,
         feed: str = 'yahoo', prepost: bool = False) -> pd.DataFrame:
    """Return a tz-aware UTC DataFrame with columns
    [open, high, low, close, volume] indexed by bar timestamp.

    `prepost` asks Yahoo for the extended session (04:00-20:00 ET) as well as
    the regular one. OFF by default, which is what every existing caller has
    always got: the session anchoring in every VWAP primitive is built on the
    regular session, and turning this on underneath them would move every VWAP
    on the platform. The hybrid feed passes True, because the history it is
    joining to — Polygon — carries premarket, and a seam where the premarket
    stops existing is worse than one where the volume merely changes."""
    if timeframe not in _TF_MAP:
        raise ValueError(f'unsupported timeframe {timeframe!r}')
    start = pd.Timestamp(start)
    end = pd.Timestamp(end)
    start = start.tz_convert('UTC') if start.tz else start.tz_localize('UTC')
    end = end.tz_convert('UTC') if end.tz else end.tz_localize('UTC')

    cache = _cache_path(symbol, timeframe, start, end, prepost)
    if cache.exists():
        return pd.read_parquet(cache)

    result = _fetch(symbol, {
        'interval': _TF_MAP[timeframe],
        'range': _range_for(timeframe, start, end),
        # Regular session only by default, matching the other loaders' default
        # view and the session anchoring every VWAP primitive relies on.
        'includePrePost': 'true' if prepost else 'false',
    })

    stamps = result.get('timestamp') or []
    quote = ((result.get('indicators') or {}).get('quote') or [{}])[0]
    rows = []
    for i, ts in enumerate(stamps):
        o = (quote.get('open') or [None] * len(stamps))[i]
        h = (quote.get('high') or [None] * len(stamps))[i]
        low = (quote.get('low') or [None] * len(stamps))[i]
        c = (quote.get('close') or [None] * len(stamps))[i]
        v = (quote.get('volume') or [None] * len(stamps))[i]
        # A bar with a missing price is a bar Yahoo could not fill. Dropped
        # rather than forward-filled: an invented bar carries invented volume,
        # and volume is what the VWAP — and therefore the stop — is built from.
        if o is None or h is None or low is None or c is None:
            continue
        rows.append({'t': pd.Timestamp(int(ts), unit='s', tz='UTC'),
                     'open': float(o), 'high': float(h), 'low': float(low),
                     'close': float(c), 'volume': float(v or 0)})

    df = pd.DataFrame(rows)
    if df.empty:
        df = pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])
        df.index = pd.DatetimeIndex([], tz='UTC', name='t')
    else:
        df = df.set_index('t').sort_index()
        df = df[(df.index >= start) & (df.index <= end)]

    try:
        df.to_parquet(cache)
    except Exception:
        pass                            # a cache that cannot be written is not an error
    # THE CACHE IS CHECKED WHERE IT GROWS. Nothing else deletes these files,
    # so the one call that creates one is the one place a limit can be
    # enforced without a cron job or a person remembering. Throttled inside;
    # never raises. See tools/data/cache.py.
    _cache.after_write()
    return df
