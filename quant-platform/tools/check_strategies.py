#!/usr/bin/env python3
"""Is every strategy written the standard way?

A strategy is a document with a lot of optional fields, and over months of
edits the same idea gets expressed two ways: a bare object where every other
file is a list, an anchored stop that trails where its neighbours freeze, a
`hold` that does nothing on the line it was put on. None of that is a syntax
error and none of it shows up in the builder — it shows up as a live order that
does not match the backtest.

So this states the standard and checks it. Nothing is rewritten: a difference
here is a decision about a trade, and it belongs to whoever built the strategy.

    python3 tools/check_strategies.py            # the bundled seeds
    python3 tools/check_strategies.py --db       # the live database
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chart import exit_protocol as xp                        # noqa: E402

# Written by a READ, never authored. A seed carrying one of these is comparing
# itself against a field the bundle cannot have — see store.DERIVED_KEYS.
DERIVED = ('id', 'created_at', 'updated_at', 'exit_protocol')

# Primitives that print a value on EVERY bar. `hold` forward-fills a sparse
# line into a continuous one, so on these it is a no-op — and a no-op that
# looks like it froze the level is how a stop ends up trailing unnoticed.
DENSE = ('vwap.session', 'vwap.stdev_bands', 'ma.sma', 'ma.ema', 'ma.wma',
         'ma.vwma', 'volatility.atr', 'price')


def problems(doc: dict) -> list:
    out = []
    name = (doc.get('name') or '').strip()
    if not name:
        out.append('has no name — it cannot be referred to or restored')
    if not (doc.get('side') in ('long', 'short')):
        out.append(f"side is {doc.get('side')!r}, not 'long' or 'short'")
    for k in DERIVED:
        if k in doc:
            out.append(f"carries {k!r}, which a read adds — strip it before bundling")

    risk = doc.get('risk') or {}
    ws, we = risk.get('window_start'), risk.get('window_end')
    if ws in (None, ''):
        out.append('has no risk.window_start — nothing can schedule it')
    if we in (None, ''):
        out.append('has no risk.window_end — a clock setup should set it equal '
                   'to window_start rather than leave it out')
    elif ws not in (None, '') and int(we) < int(ws):
        out.append(f'window_end {we} is before window_start {ws}')

    sl = risk.get('sl') or {}
    if sl.get('type') == 'prim':
        if not sl.get('freeze'):
            out.append('anchored stop with no `freeze` — the backtest re-reads '
                       'the line every bar while the order goes out at one fixed '
                       'price. Tick "fix at entry" unless it is meant to trail')
        anchor = sl.get('anchor') or {}
        key = str(anchor.get('key') or '')
        if anchor.get('hold') and any(key.startswith(d) for d in DENSE):
            out.append(f'`hold` on {key}, which prints every bar — it does '
                       'nothing there. `freeze` is what fixes the level')
    elif not sl.get('type'):
        out.append('has no stop — it cannot be sized or ranked')

    tgts = risk.get('targets') or []
    frac = sum(float(t.get('fraction') or 0) for t in tgts)
    if frac > 1.0 + 1e-9:
        out.append(f'scale-out fractions add to {frac:.2f} — more than the position')
    for i, t in enumerate(tgts, 1):
        if not (float(t.get('fraction') or 0) > 0):
            out.append(f'scale-out leg {i} has no fraction')
        if t.get('r_multiple') in (None, '') and not (t.get('tp') or {}).get('type'):
            out.append(f'scale-out leg {i} has no target — say R×, %, ATR× or points')

    proto = xp.normalise(doc)
    for e in proto.get('errors') or []:
        out.append(f'exit protocol: {e}')
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--db', action='store_true', help='check the live database')
    args = ap.parse_args()

    docs = []
    if args.db:
        from chart import store
        for s in store.list_strategies():
            docs.append((s['name'], str(store._DB),
                         {k: v for k, v in s.items() if k not in DERIVED}))
    else:
        for f in sorted(glob.glob(str(Path(__file__).resolve().parents[1]
                                      / 'chart' / 'seeds' / '*.json'))):
            raw = json.loads(Path(f).read_text())
            if not isinstance(raw, list):
                print(f'! {Path(f).name} is a bare object; every seed file is a '
                      f'LIST, and iterating a dict yields its keys')
            for o in (raw if isinstance(raw, list) else [raw]):
                docs.append((o.get('name'), Path(f).name, o))

    bad = 0
    for name, src, doc in sorted(docs, key=lambda x: (x[0] or '').lower()):
        errs = problems(doc)
        if not errs:
            print(f'  ok   {name}   [{src}]')
            continue
        bad += 1
        print(f'  ▲    {name}   [{src}]')
        for e in errs:
            print(f'         - {e}')
    print(f'\n{len(docs) - bad} standard, {bad} with something to look at.')
    # Not a failure exit: these are decisions about trades, not broken code.
    return 0


if __name__ == '__main__':
    sys.exit(main())
