"""Cross-tool integration: the two failures that reached the LIVE box.

Both bugs came from the same place — two sessions editing this repo, each one
correct against the code it could see, neither exercised against the other's.
Neither tool's own tests could catch them, so they are pinned here.

PART A — run() must actually reach _pairs().
         The setups-per-tool work added a second argument, `_pairs(spec,
         strategy)`, written against a run() that had ONE strategy. By then
         run() held a LIST (`strategies`) so a long book and a short book
         could be ranked against each other, and the name `strategy` no longer
         existed at that point. Every backtest — every universe kind, not just
         'tools' — died with "local variable 'strategy' referenced before
         assignment" before a single bar was fetched. The tools tests call
         _pairs() directly, so they stayed green while nothing ran.

PART B — the tool assignment must survive a restart.
         Storing a setup's tools made every stored row report `tools` (default
         []) while the bundled seed files carry no such key. seed_strategies()
         compares stored-vs-bundle to decide whether to refresh, so every seed
         differed on every startup: a perpetual rewrite that ALSO reset the
         assignment made on the alerts page. Assign a setup to T2, deploy, and
         its tools-universe backtest then fails with "not assigned to any tool
         yet" — with nothing in between to explain why.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

import json, tempfile, os
import chart.backtest as bt
import chart.store as store

STRAT = {'name': 'X', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': []},
         'risk': {'sl': {'type': 'pct', 'value': 1}, 'targets': []}}

print("=" * 64)
print("PART A — run() reaches _pairs (the UnboundLocalError that killed every run)")
print("=" * 64)

seen = {}
_saved = bt._pairs, bt._resolve_strategies, bt.strat.evaluate


def _spy(spec, strategy=None):
    """Record what run() hands _pairs, and give back one real pair so the rest
    of run() executes for real rather than short-circuiting on an empty list."""
    seen['spec'] = spec
    seen['strategy'] = strategy
    return [('2026-08-03', 'AAA', {})]


bt._pairs = _spy
bt.strat.evaluate = lambda *a, **k: {'ok': True, 'bars': 10, 'entries': [],
                                     'trades': [], 'open_trade': None}
try:
    # a plain register run: nothing to do with tools, and it crashed too
    bt._resolve_strategies = lambda spec: [dict(STRAT)]
    out = bt.run({'strategy': STRAT, 'tf': '1m', 'feed': 'polygon',
                  'universe': {'kind': 'register', 'register': 'R1'},
                  'start': '2026-08-03', 'end': '2026-08-03'})
    ok('a register run reaches _pairs instead of raising', 'spec' in seen)
    ok('...and returns a summary', isinstance(out, dict) and 'summary' in out,
       str(sorted(out))[:80])

    # the run's universe is the union of the books' tools, in order. Both books
    # are evaluated on EVERY pair, so taking only the first book's assignment
    # would silently deny the second one its own stocks.
    seen.clear()
    bt._resolve_strategies = lambda spec: [{**STRAT, 'tools': ['T2', 'T7']},
                                           {**STRAT, 'side': 'short',
                                            'tools': ['T7', 'T3']}]
    bt.run({'strategies': [1, 2], 'tf': '1m', 'feed': 'polygon',
            'universe': {'kind': 'tools'},
            'start': '2026-08-03', 'end': '2026-08-03'})
    ok('_pairs is handed the UNION of both books, order kept',
       (seen.get('strategy') or {}).get('tools') == ['T2', 'T7', 'T3'],
       str(seen.get('strategy')))

    # a book with no assignment must not erase the other's
    seen.clear()
    bt._resolve_strategies = lambda spec: [{**STRAT, 'tools': []},
                                           {**STRAT, 'tools': ['T2']}]
    bt.run({'strategies': [1, 2], 'tf': '1m', 'feed': 'polygon',
            'universe': {'kind': 'tools'},
            'start': '2026-08-03', 'end': '2026-08-03'})
    ok('an unassigned book does not blank the assigned one',
       (seen.get('strategy') or {}).get('tools') == ['T2'],
       str(seen.get('strategy')))

    # and spec.universe.tools still overrides: "how would T2's setup have done
    # on T7's picks" must not require editing the setup
    seen.clear()
    bt._resolve_strategies = lambda spec: [{**STRAT, 'tools': ['T2']}]
    bt.run({'strategies': [1], 'tf': '1m', 'feed': 'polygon',
            'universe': {'kind': 'tools', 'tools': ['T7']},
            'start': '2026-08-03', 'end': '2026-08-03'})
    ok('the spec override still reaches _pairs untouched',
       (seen['spec'].get('universe') or {}).get('tools') == ['T7'])
finally:
    bt._pairs, bt._resolve_strategies, bt.strat.evaluate = _saved

print()
print("=" * 64)
print("PART B — a tool assignment survives the startup re-seed")
print("=" * 64)

tmp = tempfile.mkdtemp()
_db_saved = store._DB
store._DB = pathlib.Path(tmp) / 'platform.db'   # never touch the real store
store._conn = None

# a bundle whose seed file carries NO tools key — which is every real seed
SEED = [{'name': 'Seed T', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': []},
         'risk': {'sl': {'type': 'pct', 'value': 1}, 'targets': []}}]


class _Seeds:
    def is_dir(self): return True
    def glob(self, pat): return [self]
    def read_text(self): return json.dumps(SEED)


_path_saved = store.Path
store.Path = lambda *a, **k: type('P', (), {'resolve': lambda s: type(
    'Q', (), {'parent': type('R', (), {'__truediv__': lambda s2, o: _Seeds()})()})()})()
try:
    ok('first startup inserts the seed', store.seed_strategies() == 1)
    ok('a fresh seed starts unassigned',
       [s for s in store.list_strategies() if s['name'] == 'Seed T'][0]['tools'] == [])
    ok('the SECOND startup changes nothing', store.seed_strategies() == 0)

    # the user assigns it on the alerts page
    sid = [s for s in store.list_strategies() if s['name'] == 'Seed T'][0]['id']
    _norm_saved = store.normalise_tools
    store.normalise_tools = lambda raw: list(raw or [])   # no screener needed
    try:
        store.set_tools(sid, ['T2'])
        ok('the assignment is stored',
           store.get_strategy(sid)['tools'] == ['T2'])
        # ...and the box restarts
        n = store.seed_strategies()
        ok('the re-seed does not rewrite the row', n == 0, f'changed={n}')
        ok('THE ASSIGNMENT SURVIVES THE RESTART',
           store.get_strategy(sid)['tools'] == ['T2'],
           str(store.get_strategy(sid)['tools']))

        # a genuine bundle change must still reach the row — and still not
        # cost the user their assignment
        SEED[0]['risk']['targets'] = [{'fraction': 0.5, 'r_multiple': 2.0}]
        ok('a real bundle change still refreshes', store.seed_strategies() == 1)
        got = store.get_strategy(sid)
        ok('...the new definition landed',
           got['risk']['targets'][0]['r_multiple'] == 2.0)
        ok('...the id was kept', got['id'] == sid)
        ok('...and the assignment is still there', got['tools'] == ['T2'])
        ok('...and it is idempotent again', store.seed_strategies() == 0)

        # THE STRUCTURAL GUARD. This bug has now landed twice, from two
        # different fields (`tools`, then `exit_protocol`), and both times the
        # cause was the same: a read DERIVES a key, seed_strategies COMPARES
        # it, and every seed differs forever. Rather than wait for the third,
        # assert that store.DERIVED_KEYS actually covers what a read injects —
        # so the next derived field fails here instead of on the box.
        authored = {'name': 'Shape Probe', 'side': 'long',
                    'entry': {'logic': 'AND', 'rules': []},
                    'risk': {'sl': {'type': 'pct', 'value': 1}, 'targets': []}}
        saved = store.save_strategy(dict(authored))
        read_back = store.get_strategy(saved['id'])
        injected = set(read_back) - set(authored) - {'tools'}
        ok('every key a READ adds is declared in store.DERIVED_KEYS',
           injected <= set(store.DERIVED_KEYS),
           f'undeclared: {sorted(injected - set(store.DERIVED_KEYS))}')
        ok('...and DERIVED_KEYS is what save_strategy strips, not a second list',
           set(store.DERIVED_KEYS) == {'id', 'created_at', 'updated_at',
                                       'exit_protocol'})
    finally:
        store.normalise_tools = _norm_saved
finally:
    store.Path = _path_saved
    store._conn = None
    store._DB = _db_saved

print()
print("=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
