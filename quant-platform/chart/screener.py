"""
Screener client — Phase 2 bridge.

The charting platform lives next to the Node screener (port 3000) on the same
box. The screener freezes a daily **R1 register** (every scanner candidate at
9:36 AM) and a **Shortlist register** (the stocks the trader actually flagged),
each keyed by trading date, in its SQLite warehouse. This module reads those
registers over the screener's HTTP API so the chart can:

  * list every (register, date) that exists, and
  * for a chosen date, list the tickers that were on that register **with the
    metadata the screener captured** (score, regime, sector bias, sector,
    gap %, rvol, price) — the "cards" the navigation dropdown shows.

Selecting a ticker then loads its chart with `asof=<that date>`, replaying the
stock exactly as it stood when the screener captured it.

Endpoints used (screener, mounted under /api/warehouse):
  GET /available-dates?register=R1        -> ["2026-07-10", ...]
  GET /R1/:date            (or Shortlist) -> [ {ticker, _score, regime, ...} ]
  GET /R1/latest                          -> latest date's rows

No third-party HTTP dep: stdlib urllib, proxy bypassed (same-box localhost).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

# Same-box screener by default; override with SCREENER_URL for a remote host.
SCREENER_URL = os.environ.get('SCREENER_URL', 'http://localhost:3000').rstrip('/')
_TIMEOUT = float(os.environ.get('SCREENER_TIMEOUT', '6'))

# Registers the chart navigator exposes. The warehouse understands more
# (R0/R2/R3/R4) but those aren't per-stock chartable registers.
REGISTERS = ['R1', 'Shortlist']

# Never let the screener's proxy env (if any) hijack a localhost call.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get(path: str):
    url = f'{SCREENER_URL}/api/warehouse{path}'
    with _OPENER.open(url, timeout=_TIMEOUT) as r:
        return json.loads(r.read().decode('utf-8'))


def health() -> dict:
    """Is the screener reachable? Cheap probe on R1 dates."""
    try:
        dates = _get('/available-dates?register=R1')
        return {'ok': True, 'url': SCREENER_URL, 'r1_dates': len(dates or [])}
    except Exception as e:  # noqa: BLE001 — surface any failure as not-ok
        return {'ok': False, 'url': SCREENER_URL, 'error': str(e)}


def available_dates(register: str = 'R1') -> list:
    """Trading dates (newest first) that have a frozen register."""
    reg = register if register in REGISTERS else 'R1'
    try:
        return _get(f'/available-dates?register={reg}') or []
    except Exception:
        return []


# The register rows carry many fields; the navigator only needs a compact card.
# Map both R1's `_score`/`gapPct` shape and Shortlist's `score` shape.
def _card(row: dict) -> dict:
    return {
        'ticker':  row.get('ticker'),
        'date':    row.get('date'),
        'score':   row.get('_score', row.get('score')),
        'price':   row.get('price'),
        'change':  row.get('change'),
        'gapPct':  row.get('gapPct'),
        'rvol':    row.get('rvol'),
        'atr':     row.get('atr'),
        'regime':  row.get('regimeLabel') or row.get('regime'),
        'secBias': row.get('secBias'),
        'sector':  row.get('sector'),
        'bias':    row.get('bias'),
        'catalyst': row.get('catalyst'),
        'inShortlist': row.get('inShortlist'),
        'method':  row.get('method'),           # Shortlist-only (auto/manual)
    }


def register_rows(register: str = 'R1', date: str | None = None,
                  full: bool = False) -> dict:
    """Compact cards for a register on a date (default: latest).

    Returns {ok, register, date, rows[]}. Rows are sorted by score desc so the
    strongest candidates surface first. `date` None → the screener's latest.
    `full=True` additionally carries EVERY scalar field of the raw register
    row (normalized card names win on collision) — the backtester stores this
    per trade so results can be filtered by ANY R1 column."""
    reg = register if register in REGISTERS else 'R1'
    try:
        raw = _get(f'/{reg}/{date}') if date else _get(f'/{reg}/latest')
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {'ok': True, 'register': reg, 'date': date, 'rows': []}
        return {'ok': False, 'register': reg, 'date': date, 'rows': [], 'error': str(e)}
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'register': reg, 'date': date, 'rows': [], 'error': str(e)}

    def _one(r: dict) -> dict:
        c = _card(r)
        if full:
            extra = {k: v for k, v in r.items()
                     if isinstance(v, (int, float, str, bool)) and k not in c}
            c = {**extra, **c}
        return c
    rows = [_one(r) for r in (raw or []) if r.get('ticker')]
    # Shortlist can repeat a ticker across method rows; keep the first (newest).
    seen, uniq = set(), []
    for c in rows:
        t = c['ticker']
        if t in seen:
            continue
        seen.add(t)
        uniq.append(c)
    uniq.sort(key=lambda c: (c['score'] if isinstance(c.get('score'), (int, float)) else -1),
              reverse=True)
    out_date = date or (uniq[0]['date'] if uniq else None)
    return {'ok': True, 'register': reg, 'date': out_date, 'rows': uniq}
