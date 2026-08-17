#!/usr/bin/env python3
"""Turn a strategy you built in the browser into a bundled seed.

WHAT A SEED BUYS YOU

chart/seeds/*.json is the only copy of a strategy that lives in the git
repository. Everything else — the database, the JSON copies beside it — lives
on one box and dies with it. A strategy that exists only in platform.db is one
disk away from gone; a strategy in seeds/ is on GitHub, on every clone, and is
put back automatically on any box that does not have it.

`_keep_user_edits: true` is written into every seed this produces. That makes
it RESTORE-ONLY: inserted when missing, and never overwritten afterwards, so
editing it in the builder later still wins. It is the setting the five
canonical strategies already carry; this is how a strategy of yours joins them.

Usage
    python3 tools/seed_from_db.py --list
    python3 tools/seed_from_db.py "Test"
    python3 tools/seed_from_db.py "Test" "OR + VWAP 09:35 (Long)"
    python3 tools/seed_from_db.py --all-mine        # everything you have saved
                                                    # that is not already a seed

Then, from the repository root:
    git add quant-platform/chart/seeds
    git commit -m "seed: my strategies"
    git push
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chart import store                                       # noqa: E402

SEEDS = Path(__file__).resolve().parents[1] / 'chart' / 'seeds'

# Written by a read, never authored. A seed carrying these would be comparing
# itself against fields the bundle cannot have — see store.DERIVED_KEYS.
STRIP = ('id', 'created_at', 'updated_at', 'exit_protocol', '_seed',
         '_user_edited')


def _safe(name: str) -> str:
    s = ''.join(c if (c.isalnum() or c in ' -_') else '_' for c in name).strip()
    return (s or 'untitled')[:80]


def _bundled_names() -> set:
    out = set()
    if not SEEDS.is_dir():
        return out
    for f in SEEDS.glob('*.json'):
        try:
            docs = json.loads(f.read_text())
        except ValueError:
            continue
        for o in (docs if isinstance(docs, list) else [docs]):
            if o.get('name'):
                out.add(o['name'])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*', help='strategy names, exactly as saved')
    ap.add_argument('--list', action='store_true',
                    help='show what is in the database and whether it is bundled')
    ap.add_argument('--all-mine', action='store_true',
                    help='every strategy that is not already a bundled seed')
    ap.add_argument('--out', default=None,
                    help='seed file to write (default: one file per strategy '
                         'in chart/seeds)')
    args = ap.parse_args()

    rows = store.list_strategies()
    bundled = _bundled_names()

    if args.list or not (args.names or args.all_mine):
        print(f'{len(rows)} strategies in {store._DB}\n')
        for s in sorted(rows, key=lambda x: x['name'].lower()):
            r = s.get('risk') or {}
            mark = 'bundled' if s['name'] in bundled else 'NOT BUNDLED'
            print(f"  {mark:12s} {s['name']:34s} {s.get('side','?'):5s} "
                  f"window {r.get('window_start')}–{r.get('window_end')} "
                  f"tools {s.get('tools') or []}")
        if not args.list:
            print('\nName one to bundle it, or --all-mine for everything above '
                  'marked NOT BUNDLED.')
        return 0

    by_name = {s['name']: s for s in rows}
    if args.all_mine:
        want = [n for n in by_name if n not in bundled]
    else:
        want = []
        for n in args.names:
            if n in by_name:
                want.append(n)
            else:
                # Exact names matter: a near miss would bundle the wrong thing.
                near = [x for x in by_name if x.lower() == n.lower().strip()]
                if near:
                    want.append(near[0])
                else:
                    print(f'! no strategy named {n!r}. Names are:')
                    for x in sorted(by_name):
                        print(f'    {x}')
                    return 1
    if not want:
        print('Nothing to bundle — everything saved is already a seed.')
        return 0

    SEEDS.mkdir(parents=True, exist_ok=True)
    written = []
    for n in want:
        doc = {k: v for k, v in by_name[n].items() if k not in STRIP}
        # RESTORE-ONLY. The startup sync inserts this when it is missing and
        # never touches it again, so an edit made in the builder afterwards is
        # not undone by a deploy.
        doc['_keep_user_edits'] = True
        path = Path(args.out) if args.out else SEEDS / f'{_safe(n)}.json'
        # A LIST, even for one strategy. The loader takes either, but every
        # bundled seed file is a list and anything reading the directory tends
        # to assume that — iterating a bare dict yields its keys, silently.
        # One shape for the whole directory is cheaper than every reader
        # remembering there are two.
        path.write_text(json.dumps([doc], indent=2, sort_keys=True) + '\n')
        written.append(path)
        print(f'  wrote {path}   ({n})')

    print('\nNow, from the repository root:')
    print('  git add quant-platform/chart/seeds')
    print(f'  git commit -m "seed: {", ".join(want)}"')
    print('  git push')
    print('\nOnce that is pushed, these exist on GitHub and on every clone, '
          'and any box without them puts them back on the next start.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
