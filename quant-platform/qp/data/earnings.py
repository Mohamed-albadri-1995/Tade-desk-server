"""
Earnings-date fetcher (free tier).

Wraps Yahoo Finance's `quoteSummary` module to pull the last (and next)
earnings announcement date for a ticker. Cached locally in a small
sqlite file at ~/.qp-cache/earnings.db so we don't hammer Yahoo on
every setup pick. Cache TTL is one calendar day — earnings dates
change rarely and the recent-past date only shifts when a new report
lands.

Yahoo throttles hard from AWS IPs; if the fetch fails, `None` is
returned and callers should treat it as "no earnings date known".
This module deliberately has no retries or backoff — the caller can
retry on a schedule (once a day is plenty).

The `qp.vwap.earnings_vwap` function takes an anchor date, so this
module's job ends when it returns the timestamp. Wiring:

    from qp.data.earnings import last_earnings_date
    d = last_earnings_date('AAPL')          # pd.Timestamp or None
    from qp.vwap import earnings_vwap
    series = earnings_vwap(bars, d)
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pandas as pd


_CACHE_DIR  = Path.home() / '.qp-cache'
_CACHE_FILE = _CACHE_DIR / 'earnings.db'
_TTL_SECONDS = 24 * 3600  # 1 day

_YF_HOSTS = ('query1.finance.yahoo.com', 'query2.finance.yahoo.com')
_YF_HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                   'AppleWebKit/537.36 (KHTML, like Gecko) '
                   'Chrome/124.0.0.0 Safari/537.36'),
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
}


def _open_cache() -> sqlite3.Connection:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_CACHE_FILE)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS earnings (
            ticker      TEXT PRIMARY KEY,
            last_iso    TEXT,
            next_iso    TEXT,
            fetched_at  INTEGER NOT NULL
        )
    """)
    return conn


def _read_cache(ticker: str) -> dict | None:
    conn = _open_cache()
    try:
        row = conn.execute(
            'SELECT last_iso, next_iso, fetched_at FROM earnings WHERE ticker = ?',
            (ticker.upper(),),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    if int(time.time()) - int(row[2]) > _TTL_SECONDS:
        return None
    return {'last_iso': row[0], 'next_iso': row[1]}


def _write_cache(ticker: str, last_iso: str | None, next_iso: str | None) -> None:
    conn = _open_cache()
    try:
        conn.execute(
            'INSERT OR REPLACE INTO earnings (ticker, last_iso, next_iso, fetched_at) '
            'VALUES (?, ?, ?, ?)',
            (ticker.upper(), last_iso, next_iso, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()


def _fetch_yahoo(ticker: str) -> dict:
    """Return {'last_iso': str|None, 'next_iso': str|None}. Raises on
    network errors. Returns Nones inside dict if the field is absent."""
    import urllib.request
    import urllib.error

    last_iso = None
    next_iso = None
    last_err: Exception | None = None
    for host in _YF_HOSTS:
        url = (f'https://{host}/v10/finance/quoteSummary/'
               f'{ticker.upper()}?modules=calendarEvents,earningsHistory')
        req = urllib.request.Request(url, headers=_YF_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
        except Exception as e:
            last_err = e
            continue
        try:
            result = (payload.get('quoteSummary', {})
                             .get('result') or [{}])[0]
        except Exception:
            result = {}

        # Next earnings date: calendarEvents.earnings.earningsDate is
        # a list of one or two epoch timestamps (start-end range).
        cal = result.get('calendarEvents', {}).get('earnings', {})
        ed_list = cal.get('earningsDate') or []
        for entry in ed_list:
            raw = entry.get('raw') if isinstance(entry, dict) else entry
            if isinstance(raw, (int, float)):
                next_iso = pd.Timestamp(int(raw), unit='s', tz='UTC').isoformat()
                break

        # Last earnings date: earningsHistory.history is a list of past
        # reports; the latest (max quarter) has quarter=<epoch>.
        hist = result.get('earningsHistory', {}).get('history') or []
        latest_epoch = 0
        for item in hist:
            q = item.get('quarter', {})
            raw = q.get('raw') if isinstance(q, dict) else q
            if isinstance(raw, (int, float)) and int(raw) > latest_epoch:
                latest_epoch = int(raw)
        if latest_epoch:
            last_iso = pd.Timestamp(latest_epoch, unit='s', tz='UTC').isoformat()

        return {'last_iso': last_iso, 'next_iso': next_iso}
    if last_err is not None:
        raise last_err
    return {'last_iso': None, 'next_iso': None}


def last_earnings_date(ticker: str,
                       use_cache: bool = True) -> pd.Timestamp | None:
    """The most recent past earnings-announcement date for `ticker`, or
    None. Values are cached ~1 day. Set use_cache=False to force refresh."""
    if use_cache:
        cached = _read_cache(ticker)
        if cached and cached.get('last_iso'):
            return pd.Timestamp(cached['last_iso'])
    try:
        info = _fetch_yahoo(ticker)
    except Exception:
        return None
    _write_cache(ticker, info.get('last_iso'), info.get('next_iso'))
    return pd.Timestamp(info['last_iso']) if info.get('last_iso') else None


def next_earnings_date(ticker: str,
                       use_cache: bool = True) -> pd.Timestamp | None:
    """The next upcoming earnings-announcement date for `ticker`, or None."""
    if use_cache:
        cached = _read_cache(ticker)
        if cached and cached.get('next_iso'):
            return pd.Timestamp(cached['next_iso'])
    try:
        info = _fetch_yahoo(ticker)
    except Exception:
        return None
    _write_cache(ticker, info.get('last_iso'), info.get('next_iso'))
    return pd.Timestamp(info['next_iso']) if info.get('next_iso') else None
