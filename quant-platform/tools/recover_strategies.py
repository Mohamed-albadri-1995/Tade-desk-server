#!/usr/bin/env python3
"""Find strategies that are no longer in the strategies table.

WHY THIS CAN WORK AT ALL

SQLite does not scrub. When a row is deleted its page goes on a free list and
when a row is UPDATED in place — which is exactly what the startup seed sync
did to an edited strategy — the old cell is abandoned rather than erased. The
bytes stay in the file until something else needs that page. A strategy
document is TEXT, so what is sitting there is readable JSON.

Four places are searched, in order of how trustworthy they are:

  1. the strategies table              — what the app can see today
  2. the JSON copies (~/.qp/strategies) — written on every save
  3. backtest run specs                — a run stores the FULL strategy
     document it was given, so anything ever backtested has a dated snapshot
  4. the raw bytes of the .db, .db-wal and .db-shm files — deleted and
     overwritten cells, carved out and parsed

Nothing is written back into any database. Recovered documents are written as
JSON files into an output directory, newest first, and you choose what to
restore — by dropping them into ~/.qp/strategies and restarting qp, which
reads that directory when the database has no strategies, or by loading one in
the builder and pressing Save.

Usage
    python3 tools/recover_strategies.py                 # search, report
    python3 tools/recover_strategies.py --out ~/recovered
    python3 tools/recover_strategies.py --db /path/to/platform.db
    python3 tools/recover_strategies.py --install       # copy straight into
                                                        # ~/.qp/strategies
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

# A document is a strategy if it has a name and an entry block. Both are
# required to build one, so this does not match a fragment of something else.
REQUIRED = ('name', 'entry')

# How far back from an `"entry"` hit to look for the opening brace. A strategy
# document with a deep expression tree runs to a few tens of kilobytes; beyond
# that the candidate is something else that happens to contain the word.
LOOKBACK = 80_000


def _default_dbs() -> list:
    """Every place a platform.db has lived, plus its journal files."""
    here = Path(__file__).resolve().parents[1] / 'chart'
    out = []
    for p in [Path.home() / '.qp' / 'platform.db', here / 'platform.db']:
        for suffix in ('', '-wal', '-shm'):
            f = Path(str(p) + suffix)
            if f.is_file():
                out.append(f)
    # Anything that looks like a hand-made copy next to either of them.
    for d in {(Path.home() / '.qp'), here}:
        if d.is_dir():
            for f in sorted(d.glob('*.db*')):
                if f.is_file() and f not in out and 'platform.db' not in f.name:
                    out.append(f)
    return out


def _looks_like_strategy(obj) -> bool:
    return (isinstance(obj, dict)
            and all(k in obj for k in REQUIRED)
            and isinstance(obj.get('name'), str)
            and obj['name'].strip())


def _balanced(buf: bytes, start: int) -> str | None:
    """Parse one JSON object starting at `buf[start]`, or None.

    Brace counting has to respect strings and escapes: a strategy full of
    `"label": "a { b"` would otherwise close early and produce nothing.
    """
    depth = 0
    in_str = False
    esc = False
    for i in range(start, min(len(buf), start + LOOKBACK * 3)):
        c = buf[i]
        if in_str:
            if esc:
                esc = False
            elif c == 0x5C:              # backslash
                esc = True
            elif c == 0x22:              # quote
                in_str = False
            continue
        if c == 0x22:
            in_str = True
        elif c == 0x7B:                  # {
            depth += 1
        elif c == 0x7D:                  # }
            depth -= 1
            if depth == 0:
                try:
                    return buf[start:i + 1].decode('utf-8')
                except UnicodeDecodeError:
                    return None
    return None


def carve(path: Path) -> list:
    """Every strategy-shaped JSON object in a file's raw bytes."""
    try:
        buf = path.read_bytes()
    except OSError as e:
        print(f'  ! could not read {path}: {e}')
        return []
    found = []
    seen_spans = set()
    needle = b'"entry"'
    at = buf.find(needle)
    while at != -1:
        # Walk back through the opening braces before this hit, outermost
        # first: the outermost one that parses is the whole document, and an
        # inner one would recover a sub-expression instead.
        starts = []
        i = max(0, at - LOOKBACK)
        while True:
            j = buf.find(b'{', i, at)
            if j == -1:
                break
            starts.append(j)
            i = j + 1
        for s in starts:
            if s in seen_spans:
                continue
            txt = _balanced(buf, s)
            if not txt:
                continue
            try:
                obj = json.loads(txt)
            except (ValueError, UnicodeDecodeError):
                continue
            if _looks_like_strategy(obj):
                seen_spans.add(s)
                found.append(obj)
                break
        at = buf.find(needle, at + 1)
    return found


def from_tables(path: Path) -> tuple:
    """(live strategies, strategies embedded in backtest specs)."""
    live, specs = [], []
    try:
        con = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        con.row_factory = sqlite3.Row
    except sqlite3.Error as e:
        print(f'  ! could not open {path}: {e}')
        return live, specs
    try:
        for r in con.execute('SELECT name, data, updated_at FROM strategies'):
            try:
                obj = json.loads(r['data'])
            except ValueError:
                continue
            obj.setdefault('name', r['name'])
            obj['_recovered_at'] = r['updated_at']
            live.append(obj)
    except sqlite3.Error:
        pass                                     # no such table — fine
    try:
        for r in con.execute('SELECT id, spec, created_at FROM backtests'):
            try:
                spec = json.loads(r['spec'] or '{}')
            except ValueError:
                continue
            # `_strategy_docs` is the frozen copy the run keeps of exactly
            # what it evaluated. The other two are older shapes: a spec that
            # carried the strategy inline instead of by id.
            cands = list(spec.get('_strategy_docs') or [])
            cands += list(spec.get('strategies') or [])
            if isinstance(spec.get('strategy'), dict):
                cands.append(spec['strategy'])
            for obj in cands:
                if _looks_like_strategy(obj):
                    obj = dict(obj)
                    obj['_recovered_from'] = f'backtest #{r["id"]}'
                    obj['_recovered_at'] = r['created_at']
                    specs.append(obj)
    except sqlite3.Error:
        pass
    con.close()
    return live, specs


def _key(obj: dict) -> str:
    """Identity of a VERSION: the authored document, ignoring our own notes."""
    doc = {k: v for k, v in obj.items()
           if k not in ('id', 'created_at', 'updated_at', 'exit_protocol',
                        '_recovered_at', '_recovered_from')}
    return hashlib.sha1(json.dumps(doc, sort_keys=True).encode()).hexdigest()[:12]


def _safe(name: str) -> str:
    s = ''.join(c if (c.isalnum() or c in ' -_') else '_' for c in name).strip()
    return (s or 'untitled')[:80]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', action='append', default=[],
                    help='a platform.db to search (repeatable). Default: every '
                         'known location.')
    ap.add_argument('--out', default=None,
                    help='where to write recovered JSON (default ./recovered-strategies)')
    ap.add_argument('--install', action='store_true',
                    help='also copy into ~/.qp/strategies, which qp reads back '
                         'when the database has no strategies')
    ap.add_argument('--json-dir', default=str(Path.home() / '.qp' / 'strategies'),
                    help='the plain-text copies directory to include in the search')
    args = ap.parse_args()

    files = [Path(p).expanduser() for p in args.db] or _default_dbs()
    if not files:
        print('No platform.db found. Looked in ~/.qp and quant-platform/chart.')
        return 1

    # name -> {version key -> (obj, [where it was found])}
    versions: dict = {}

    def add(obj, where):
        nm = obj['name'].strip()
        k = _key(obj)
        slot = versions.setdefault(nm, {})
        if k in slot:
            if where not in slot[k][1]:
                slot[k][1].append(where)
        else:
            slot[k] = (obj, [where])

    live_names = set()

    jd = Path(args.json_dir).expanduser()
    if jd.is_dir():
        n = 0
        for f in sorted(jd.glob('*.json')):
            try:
                obj = json.loads(f.read_text())
            except ValueError:
                continue
            if _looks_like_strategy(obj):
                add(obj, 'json copy')
                n += 1
        print(f'{jd}: {n} JSON copies')

    for f in files:
        print(f'\n{f}  ({f.stat().st_size:,} bytes)')
        if f.suffix in ('', '.db') and f.name.endswith('.db'):
            live, specs = from_tables(f)
            for o in live:
                live_names.add(o['name'].strip())
                add(o, 'live table')
            for o in specs:
                add(o, o.get('_recovered_from', 'backtest spec'))
            print(f'  strategies table: {len(live)}   '
                  f'inside backtest specs: {len(specs)}')
        carved = carve(f)
        for o in carved:
            add(o, f'carved from {f.name}')
        print(f'  carved from raw bytes: {len(carved)}')

    print('\n' + '=' * 68)
    missing = [n for n in sorted(versions) if n not in live_names]
    print(f'{len(versions)} distinct strategy names found; '
          f'{len(live_names)} are in the live table.')
    if missing:
        print(f'\nNOT IN THE LIVE TABLE — these are the recoveries:')
        for n in missing:
            print(f'  {n}   ({len(versions[n])} version(s): '
                  f'{", ".join(sorted({w for _o, ws in versions[n].values() for w in ws}))})')
    else:
        print('\nEverything found is already in the live table — nothing is missing.')

    multi = [n for n in sorted(versions) if len(versions[n]) > 1]
    if multi:
        print('\nOLDER VERSIONS of strategies that DO still exist '
              '(an overwritten edit looks like this):')
        for n in multi:
            print(f'  {n}   {len(versions[n])} versions')

    out = Path(args.out).expanduser() if args.out else Path('recovered-strategies')
    out.mkdir(parents=True, exist_ok=True)
    written = 0
    for nm, slot in versions.items():
        # Newest first, so `-1` is the freshest version of a name.
        ordered = sorted(slot.items(),
                         key=lambda kv: kv[1][0].get('_recovered_at') or 0,
                         reverse=True)
        for i, (k, (obj, wheres)) in enumerate(ordered):
            doc = {kk: vv for kk, vv in obj.items()
                   if kk not in ('id', 'exit_protocol', 'created_at', 'updated_at')}
            doc['_recovered'] = {'from': wheres,
                                 'at': time.strftime('%Y-%m-%d %H:%M:%S')}
            suffix = '' if i == 0 else f'-v{i + 1}'
            (out / f'{_safe(nm)}{suffix}-{k}.json').write_text(
                json.dumps(doc, indent=2, sort_keys=True))
            written += 1
    print(f'\nWrote {written} file(s) to {out.resolve()}')

    if args.install:
        dest = Path.home() / '.qp' / 'strategies'
        dest.mkdir(parents=True, exist_ok=True)
        n = 0
        for nm, slot in versions.items():
            if nm in live_names:
                continue                        # do not overwrite what works
            newest = sorted(slot.values(),
                            key=lambda v: v[0].get('_recovered_at') or 0)[-1][0]
            doc = {k: v for k, v in newest.items()
                   if k not in ('id', 'exit_protocol', 'created_at', 'updated_at',
                                '_recovered_at', '_recovered_from')}
            (dest / f'{_safe(nm)}.json').write_text(json.dumps(doc, indent=2,
                                                               sort_keys=True))
            n += 1
        print(f'Installed {n} missing strategy(ies) into {dest}. '
              'They are read back when the database has none; to load one now, '
              'open it in the builder and Save.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
