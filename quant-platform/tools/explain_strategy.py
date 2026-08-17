import json, sys, glob
import argparse#!/usr/bin/env python3
"""Print a strategy in words: entry, stop, target, and every scale-out leg.

The builder shows a strategy as forty dropdowns and the seed file shows it as
an expression tree. Neither answers "what does this actually do", which is the
question asked before trusting one with money — and answering it by reading
JSON is how a rule gets misremembered.

Reads the BUNDLED SEEDS by default, because those are the copies in git and so
the ones that are the same on every box. `--db` reads the live database
instead, which is what to use when checking that the box agrees with the repo.

Usage
    python3 tools/explain_strategy.py                  # the five important ones
    python3 tools/explain_strategy.py --all
    python3 tools/explain_strategy.py "Test" "PML breakout"
    python3 tools/explain_strategy.py --db --all       # from platform.db
"""

sys.path.insert(0,'.')
from chart import exit_protocol as xp

DEFAULT = ['Test', 'OR + VWAP 09:35 (Long)', 'OR + VWAP 09:35 (Short)',
        'T2 10:00 VWAP Extension (Long)', 'T2 10:00 VWAP Extension (Short)']

docs = {}
for f in sorted(glob.glob('chart/seeds/*.json')):
    d = json.loads(open(f).read())
    for o in (d if isinstance(d, list) else [d]):
        if o.get('name'): docs[o['name']] = (o, f)

def hhmm(v):
    if v in (None,''): return '—'
    v = int(v); return f'{v//100:02d}:{v%100:02d}'

def sub(x):
    """One operand, in words."""
    if x is None: return '—'
    if not isinstance(x, dict): return str(x)
    k = x.get('kind')
    if k == 'price':  return f"{x.get('field')}"
    if k == 'const':  return f"{x.get('value')}"
    if k == 'time':   return f"time.{x.get('field')}"
    if k == 'trade':  return f"trade.{x.get('field')}"
    if k == 'primitive':
        p = x.get('params') or {}
        bits = ','.join(f'{a}={b}' for a,b in p.items() if b is not None)
        s = x.get('key')
        if bits: s += f'({bits})'
        if x.get('sub'): s += f'.{x["sub"]}'
        if x.get('source') and x['source'] != 'close': s += f'[{x["source"]}]'
        # `offset` is a LOOKBACK in bars, and dropping it turned
        # "vwap.session > vwap.session 3 bars ago" — a rising check — into
        # "vwap.session > vwap.session", which reads as a rule that can never
        # be true. A renderer that silently loses an operand is worse than no
        # renderer: it makes a working strategy look broken.
        if x.get('offset'): s += f' {x["offset"]} bars ago'
        if x.get('hold'): s += ' (held)'
        return s
    if k == 'expr':
        op = {'add':'+','sub':'−','mul':'×','div':'÷'}.get(x.get('op'), x.get('op'))
        return f"({sub(x.get('a'))} {op} {sub(x.get('b'))})"
    return json.dumps(x)[:90]

OPS = {'gt':'>', 'lt':'<', 'gte':'>=', 'lte':'<=', 'eq':'=', 'neq':'≠',
       'cross_above':'crosses ABOVE', 'cross_below':'crosses BELOW',
       'pct_gt':'% above', 'pct_lt':'% below', 'rising':'is rising',
       'falling':'is falling'}

def rules(block, label):
    if not block: return [f'{label}: —']
    out = [f"{label} — {block.get('logic','AND')} match"
           + (f" (window {block['window']}, k={block.get('k')})" if block.get('window') else '')]
    def walk(rs, depth=1):
        for i, r in enumerate(rs or [], 1):
            pad = '  ' * depth
            if r.get('rules') is not None:
                out.append(f"{pad}group ({r.get('logic','AND')}):")
                walk(r['rules'], depth+1); continue
            line = f"{pad}{i}. {sub(r.get('left'))}  {OPS.get(r.get('op'), r.get('op'))}  {sub(r.get('right'))}"
            if r.get('ago'):  line += f"   [{r['ago']} bars ago]"
            if r.get('hold'): line += f"   [holds {r['hold']} bars]"
            out.append(line)
    walk(block.get('rules'))
    return out

def stopline(sl):
    if not sl or not sl.get('type'): return 'none'
    t = sl['type']; v = sl.get('value')
    if t == 'prim':
        # FIXED or MOVING, said out loud. `freeze` reads the line once at the
        # entry bar; without it the level is re-read every bar and the stop
        # trails. The anchor's own `hold` is NOT this — it forward-fills a
        # sparse line and does nothing to one that prints every bar — and
        # confusing the two is how a stop ends up moving when it was meant to
        # be frozen.
        how = 'FIXED at entry' if sl.get('freeze') else 'MOVES with the line, bar by bar'
        return (f"at the line {sub(sl.get('anchor'))}"
                + (f", {v}% beyond it" if v else "") + f"  [{how}]")
    return {'pct': f'{v}% from entry', 'atr': f'{v} × ATR', 'points': f'{v} points'}.get(t, f'{t} {v}')

_ap = argparse.ArgumentParser(description=__doc__,
                              formatter_class=argparse.RawDescriptionHelpFormatter)
_ap.add_argument('names', nargs='*')
_ap.add_argument('--all', action='store_true', help='every strategy')
_ap.add_argument('--db', action='store_true',
                 help='read the live platform.db instead of the bundled seeds')
_args = _ap.parse_args()

if _args.db:
    from chart import store
    docs = {s['name']: (s, str(store._DB)) for s in store.list_strategies()}

WANT = _args.names or (sorted(docs) if _args.all else DEFAULT)

for name in WANT:
    if name not in docs:
        print(f'### {name} — NOT FOUND in seeds\n'); continue
    d, src = docs[name]
    r = d.get('risk') or {}
    p = xp.normalise(d)
    print('=' * 74)
    print(f'{name}      [{src}]')
    print('=' * 74)
    print(f"side {d.get('side')}   window {hhmm(r.get('window_start'))} → {hhmm(r.get('window_end'))}"
          f"   tools {d.get('tools') or '(none)'}")
    print(f"exit shape: {p.get('shape')}   alertable={p.get('ok')} orderable={p.get('order_ok')}")
    disc = {k: d.get(k) for k in ('attempts_per_day','cooldown','min_hold','max_stop_pct','min_target_usd') if d.get(k) not in (None,'',0)}
    if disc: print(f"discipline: {disc}")
    print()
    for l in rules(d.get('entry'), 'ENTRY'): print(l)
    print()
    for l in rules(d.get('exit'), 'EXIT RULE'): print(l)
    print()
    print(f"STOP: {stopline(r.get('sl'))}")
    tp = r.get('tp') or {}
    print(f"TARGET (single): {stopline(tp) if tp.get('type') else 'off — the scale-out legs below carry the targets'}")
    tg = r.get('targets') or []
    if tg:
        print('SCALE-OUT:')
        tot = 0
        for i, t in enumerate(tg, 1):
            frac = t.get('fraction') or 0; tot += frac
            what = (f"{t['r_multiple']}R" if t.get('r_multiple') is not None
                    else stopline(t))
            print(f"  leg {i}: {frac*100:g}% of the position, out at {what}")
        if tot < 1:
            print(f"  runner: {round((1-tot)*100):g}% — no target, rides the stop to the 15:50 close")
    print('\nLEGS as the order layer sees them:')
    for i, l in enumerate(p.get('legs') or [], 1):
        print(f"  {i}. {l.get('fraction')*100:g}%  stop={l.get('sl_kind')}  "
              f"target={l.get('tp_kind')}"
              + (f" {l['r_multiple']}R" if l.get('r_multiple') is not None else '')
              + (f" @ {sub(l['tp'])}" if l.get('tp') else ''))
    if p.get('runner'): print(f"  runner: {p['runner'].get('fraction')*100:g}% managed {p['runner'].get('manage')}")
    # The mismatch worth shouting about: the backtest trails this stop and the
    # broker cannot, so the two are testing different trades.
    _sl = r.get('sl') or {}
    if _sl.get('type') == 'prim' and not _sl.get('freeze'):
        print('\n  ⚠⚠ THE STOP MOVES. The backtest re-reads the line every bar; a')
        print('      broker gets one fixed price. Tick "fix at entry" in the builder')
        print('      to make the two agree.')
    if p.get('warnings'):
        print('\nWARNINGS:')
        for w in p['warnings']: print(f"  ⚠ {w}")
    if p.get('order_errors'):
        print('\nCANNOT BE ORDERED:')
        for w in p['order_errors']: print(f"  ⛔ {w}")
    print()
