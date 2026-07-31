"""
Screener client — Phase 2 bridge, MULTI-SOURCE.

The trader runs SEVERAL scanning tools, each its own service with its own
scanners, and each freezing its own daily **R1 register** (every candidate at
9:36 AM) and **Shortlist register** (the ones actually flagged), keyed by
trading date, in its own SQLite warehouse. This module reads all of them so
the chart can:

  * list every (register, date) that exists, on any source or all of them,
  * for a chosen date, list the tickers on that register **with the metadata
    the screener captured** (score, regime, sector bias, sector, gap %, rvol,
    price) — the "cards" the navigation dropdown shows, and
  * say WHICH scanner found each name, so the scanners can be compared
    against each other on the same days.

Selecting a ticker then loads its chart with `asof=<that date>`, replaying the
stock exactly as it stood when the screener captured it.

SOURCE SELECTION rides on the register STRING, so every existing caller
(backtest universes, print sheets, alerts, the navigator) works unchanged:

    'R1'         the DEFAULT source's R1 — exactly what it has always meant,
                 so saved backtests keep their universe
    'momo:R1'    that one source's R1
    '*:R1'       EVERY configured source's R1, merged

In a merged read a ticker found by more than one scanner appears ONCE, with
`sources` listing every scanner that flagged it and `source_count` how many —
agreement between independent scanners is a signal, and duplicating the chart
would only hide it. The highest-scoring row supplies the rest of the card.

Configuration, first match wins:
  1. env SCREENER_SOURCES — JSON [{"id","name","url"}, ...]
  2. chart/screener_sources.json — same shape, committed so it survives deploys
  3. env SCREENER_URL (or localhost:3000) as a single source called 'default'

PORTS. Each tool runs two: an APP port (the page you open) and a private
SCORER port, app+1, bound to 127.0.0.1. Point this module at the APP port —
the scorer speaks a different API and answers 404 to a warehouse request.
Tools are numbered in tens (3000/3001, 3010/3011, … 3060/3061), so an eighth
tool is 3070 and one more line here.

This service runs ON the same box, so it reaches every tool over localhost.
Whether a tool's app port is open in the AWS security group only affects
browsing it from outside — it has no bearing on what the chart can read.

Endpoints used (each screener, mounted under /api/warehouse):
  GET /available-dates?register=R1        -> ["2026-07-10", ...]
  GET /R1/:date            (or Shortlist) -> [ {ticker, _score, regime, ...} ]
  GET /R1/latest                          -> latest date's rows

No third-party HTTP dep: stdlib urllib, proxy bypassed (same-box localhost).
"""

from __future__ import annotations

import json
import os
import pathlib
import urllib.error
import urllib.parse
import urllib.request

# Same-box screener by default; override with SCREENER_URL for a remote host.
SCREENER_URL = os.environ.get('SCREENER_URL', 'http://localhost:3000').rstrip('/')
_TIMEOUT = float(os.environ.get('SCREENER_TIMEOUT', '6'))

# Registers the chart navigator exposes. The warehouse understands more
# (R0/R2/R3/R4) but those aren't per-stock chartable registers.
REGISTERS = ['R1', 'Shortlist']

_SOURCES_FILE = pathlib.Path(__file__).resolve().parent / 'screener_sources.json'
ALL = '*'                      # source id meaning "every configured source"


def _load_sources() -> list:
    """[{id, name, url}, ...] — see the module docstring for precedence."""
    raw = os.environ.get('SCREENER_SOURCES')
    if not raw and _SOURCES_FILE.is_file():
        try:
            raw = _SOURCES_FILE.read_text()
        except OSError:
            raw = None
    if raw:
        try:
            docs = json.loads(raw)
            out = []
            for i, d in enumerate(docs if isinstance(docs, list) else []):
                url = str(d.get('url') or '').rstrip('/')
                if not url:
                    continue
                sid = str(d.get('id') or f's{i + 1}').strip()
                out.append({'id': sid, 'name': str(d.get('name') or sid),
                            'url': url})
            if out:
                return out
        except (ValueError, TypeError):
            pass          # fall through to the single-source default
    return [{'id': 'default', 'name': 'screener', 'url': SCREENER_URL}]


_SOURCES: list = _load_sources()


def sources() -> list:
    return list(_SOURCES)


def reload_sources() -> list:
    """Re-read the config without a restart (the settings UI calls this)."""
    global _SOURCES
    _SOURCES = _load_sources()
    return sources()


def default_source() -> str:
    return _SOURCES[0]['id'] if _SOURCES else 'default'


def _by_id(sid: str):
    for s in _SOURCES:
        if s['id'] == sid:
            return s
    return None


def parse_register(register: str):
    """'sc2:R1' -> ('sc2', 'R1');  'R1' -> (default source, 'R1');
    '*:R1' -> ('*', 'R1'). An unknown register name falls back to R1, and an
    unknown SOURCE id falls back to the default source — a typo must not
    silently return an empty universe."""
    reg = str(register or 'R1')
    sid = None
    if ':' in reg:
        sid, reg = reg.split(':', 1)
        sid = sid.strip() or None
    reg = reg.strip() if reg.strip() in REGISTERS else 'R1'
    if sid == ALL:
        return ALL, reg
    if sid is None:
        return default_source(), reg
    return (sid if _by_id(sid) else default_source()), reg


def _targets(sid: str) -> list:
    return list(_SOURCES) if sid == ALL else [s for s in _SOURCES if s['id'] == sid]


def register_options() -> list:
    """Everything the register picker can offer: each source × each register,
    plus an 'all sources' entry per register when more than one is configured."""
    out = []
    multi = len(_SOURCES) > 1
    for reg in REGISTERS:
        if multi:
            out.append({'value': f'{ALL}:{reg}', 'label': f'{reg} — all sources'})
        for s in _SOURCES:
            out.append({'value': f'{s["id"]}:{reg}',
                        'label': (f'{reg} — {s["name"]}' if multi else reg)})
    return out


# Never let the screener's proxy env (if any) hijack a localhost call.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get(path: str, base: str = ''):
    url = f'{(base or SCREENER_URL).rstrip("/")}/api/warehouse{path}'
    with _OPENER.open(url, timeout=_TIMEOUT) as r:
        return json.loads(r.read().decode('utf-8'))


def source_health() -> list:
    """One row per configured source — which scanners are actually up. A dead
    source is REPORTED, never quietly treated as "no candidates that day"."""
    out = []
    for s in _SOURCES:
        try:
            dates = _get('/available-dates?register=R1', s['url'])
            out.append({**s, 'ok': True, 'r1_dates': len(dates or []),
                        'latest': (sorted(dates or [])[-1] if dates else None)})
        except Exception as e:  # noqa: BLE001 — surface any failure as not-ok
            out.append({**s, 'ok': False, 'error': str(e)})
    return out


def health() -> dict:
    """Aggregate probe, kept for the existing /api/screener/health shape."""
    rows = source_health()
    up = [r for r in rows if r.get('ok')]
    first = rows[0] if rows else {}
    return {'ok': bool(up), 'url': first.get('url', SCREENER_URL),
            'sources': rows, 'sources_up': len(up), 'sources_total': len(rows),
            'r1_dates': max([r.get('r1_dates', 0) for r in up] or [0]),
            **({} if up else {'error': first.get('error', 'no source reachable')})}


def available_dates(register: str = 'R1') -> list:
    """Trading dates (newest first) that have a frozen register.

    With '*:R1' this is the UNION over every source: a day any scanner froze
    is a day worth charting, even if the others were down or found nothing."""
    sid, reg = parse_register(register)
    seen: set = set()
    for s in _targets(sid):
        try:
            for d in (_get(f'/available-dates?register={reg}', s['url']) or []):
                seen.add(d)
        except Exception:      # noqa: BLE001 — one dead source must not blank the list
            continue
    return sorted(seen, reverse=True)


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


def _fetch_one(src: dict, reg: str, date: str | None, full: bool):
    """(rows, error) from ONE source. A 404 is an empty day, not a failure."""
    path = f'/{reg}/{urllib.parse.quote(str(date))}' if date else f'/{reg}/latest'
    try:
        raw = _get(path, src['url'])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return [], None
        return [], f'{src["id"]}: {e}'
    except Exception as e:  # noqa: BLE001
        return [], f'{src["id"]}: {e}'

    def _one(r: dict) -> dict:
        c = _card(r)
        if full:
            extra = {k: v for k, v in r.items()
                     if isinstance(v, (int, float, str, bool)) and k not in c}
            c = {**extra, **c}
        # WHICH scanner found this name — carried on every row so a backtest
        # trade can be attributed to the tool that surfaced it, and the
        # scanners compared against each other on the same days.
        c['source'] = src['id']
        c['source_name'] = src['name']
        return c
    return [_one(r) for r in (raw or []) if r.get('ticker')], None


def register_rows(register: str = 'R1', date: str | None = None,
                  full: bool = False) -> dict:
    """Compact cards for a register on a date (default: latest).

    `register` selects the SOURCE as well as the register — 'R1' (default
    source), 'momo:R1' (one scanner), '*:R1' (all of them). See the module
    docstring.

    Returns {ok, register, source, date, rows[], sources_ok, sources_failed}.
    Rows are sorted by score desc so the strongest candidates surface first.
    `date` None → the latest frozen day. `full=True` additionally carries
    EVERY scalar field of the raw register row (normalized card names win on
    collision) — the backtester stores this per trade so results can be
    filtered by ANY register column.

    MERGING across sources: a ticker two scanners both flagged is ONE row,
    with `sources` naming every scanner that found it and `source_count` how
    many. Agreement between independent scanners is signal; a duplicate chart
    would bury it. The highest-scoring row supplies the rest of the card.

    A source that fails is named in `sources_failed` and `error` — never
    silently folded into "that day had no candidates".
    """
    sid, reg = parse_register(register)
    targets = _targets(sid)
    if not targets:
        return {'ok': False, 'register': reg, 'source': sid, 'date': date,
                'rows': [], 'error': f'no screener source {sid!r} configured'}

    rows, failed = [], []
    for s in targets:
        got, err = _fetch_one(s, reg, date, full)
        rows.extend(got)
        if err:
            failed.append(err)
    # every source down = a real failure; some down = a partial answer that
    # says so, because a thinner universe would otherwise look like a quiet day
    if failed and len(failed) == len(targets):
        return {'ok': False, 'register': reg, 'source': sid, 'date': date,
                'rows': [], 'error': '; '.join(failed),
                'sources_ok': 0, 'sources_failed': failed}

    # strongest first, so the row that wins a merge is the best-scoring one
    rows.sort(key=lambda c: (c['score'] if isinstance(c.get('score'), (int, float)) else -1),
              reverse=True)
    uniq: dict = {}
    for c in rows:
        t = c['ticker']
        if t in uniq:                       # same name from another scanner
            u = uniq[t]
            if c.get('source') not in u['sources']:
                u['sources'].append(c.get('source'))
                u['source_count'] = len(u['sources'])
            continue
        c = dict(c)
        c['sources'] = [c.get('source')]
        c['source_count'] = 1
        uniq[t] = c
    out = list(uniq.values())
    for c in out:                           # a list would break the CSV/card cells
        c['sources'] = ','.join([x for x in c['sources'] if x])
    out_date = date or (out[0].get('date') if out else None)
    res = {'ok': True, 'register': reg, 'source': sid, 'date': out_date,
           'rows': out, 'sources_ok': len(targets) - len(failed)}
    if failed:
        res['sources_failed'] = failed
        res['error'] = '; '.join(failed)    # partial: shown, not raised
    return res
