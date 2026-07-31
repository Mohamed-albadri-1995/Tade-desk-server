"""MULTI-SOURCE screeners — seven scanning tools, each with its own R1 and
Shortlist, all reachable from one chart.

The source rides on the REGISTER STRING so no caller had to change:
  'R1'      the default tool (what it has always meant — saved backtests keep
            their universe)
  's3:R1'   one named tool
  '*:R1'    every configured tool, merged

PART A — parsing and the option list the pickers offer.
PART B — reading one source, and reading all of them merged.
PART C — a ticker two scanners both flag is ONE row that says so.
PART D — a DEAD tool is reported, never silently read as "no candidates".
PART E — attribution: every row (and so every backtest trade) knows which
         scanning tool surfaced it, which is what makes the tools comparable.
"""
import sys, pathlib, json
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

import chart.screener as sc

# three fake scanning tools
sc._SOURCES = [{'id': 'momo', 'name': 'Momentum', 'url': 'http://x:3000'},
               {'id': 'gap', 'name': 'Gappers', 'url': 'http://x:3001'},
               {'id': 'dead', 'name': 'Broken', 'url': 'http://x:3002'}]

WAREHOUSE = {
    'http://x:3000': {
        'dates': ['2026-07-14', '2026-07-13'],
        'R1': {'2026-07-14': [{'ticker': 'AAA', '_score': 90, 'rvol': 7.0},
                              {'ticker': 'SHARED', '_score': 60}]},
    },
    'http://x:3001': {
        'dates': ['2026-07-14', '2026-07-12'],       # a day momo does NOT have
        'R1': {'2026-07-14': [{'ticker': 'BBB', '_score': 80},
                              {'ticker': 'SHARED', '_score': 95}]},
    },
}
calls = []
def fake_get(path, base=''):
    calls.append((base, path))
    wh = WAREHOUSE.get(base)
    if wh is None:
        raise RuntimeError(f'connection refused {base}')
    if path.startswith('/available-dates'):
        return wh['dates']
    reg, _, date = path.lstrip('/').partition('/')
    return wh.get(reg, {}).get(date, [])
sc._get = fake_get

print("=" * 64)
print("PART A — the source rides on the register string")
print("=" * 64)
ok("a bare register still means the DEFAULT tool (old backtests unchanged)",
   sc.parse_register('R1') == ('momo', 'R1'))
ok("'gap:R1' selects that one tool", sc.parse_register('gap:R1') == ('gap', 'R1'))
ok("'*:R1' selects every tool", sc.parse_register('*:R1') == ('*', 'R1'))
ok("Shortlist works the same way",
   sc.parse_register('gap:Shortlist') == ('gap', 'Shortlist'))
ok("an unknown TOOL falls back to the default, not to an empty universe",
   sc.parse_register('typo:R1') == ('momo', 'R1'))
ok("an unknown REGISTER falls back to R1", sc.parse_register('gap:nope') == ('gap', 'R1'))
opts = [o['value'] for o in sc.register_options()]
ok("the picker offers all-sources first, then each tool, per register",
   opts[:4] == ['*:R1', 'momo:R1', 'gap:R1', 'dead:R1'], f"{opts[:4]}")
ok("...and the same for Shortlist", '*:Shortlist' in opts and 'gap:Shortlist' in opts)
ok("labels name the tool so they are pickable by eye",
   any(o['label'] == 'R1 — Gappers' for o in sc.register_options()))

print("=" * 64)
print("PART B — read one tool, or all of them merged")
print("=" * 64)
one = sc.register_rows('momo:R1', '2026-07-14')
ok("one tool returns only its own names",
   sorted(r['ticker'] for r in one['rows']) == ['AAA', 'SHARED'],
   f"{[r['ticker'] for r in one['rows']]}")
allr = sc.register_rows('*:R1', '2026-07-14')
ok("all tools merged returns the union",
   sorted(r['ticker'] for r in allr['rows']) == ['AAA', 'BBB', 'SHARED'],
   f"{[r['ticker'] for r in allr['rows']]}")
ok("rows stay sorted strongest-first",
   [r['ticker'] for r in allr['rows']][0] == 'SHARED',
   f"{[(r['ticker'], r['score']) for r in allr['rows']]}")
d_one = sc.available_dates('momo:R1')
d_all = sc.available_dates('*:R1')
ok("dates for one tool are that tool's", d_one == ['2026-07-14', '2026-07-13'], f"{d_one}")
ok("dates for all tools are the UNION, newest first",
   d_all == ['2026-07-14', '2026-07-13', '2026-07-12'], f"{d_all}")
ok("a day only ONE tool froze is still offered", '2026-07-12' in d_all)

print("=" * 64)
print("PART C — a name two scanners agree on is one row that says so")
print("=" * 64)
shared = [r for r in allr['rows'] if r['ticker'] == 'SHARED'][0]
ok("it appears ONCE, not twice (no duplicate chart)",
   sum(1 for r in allr['rows'] if r['ticker'] == 'SHARED') == 1)
ok("it names every tool that flagged it",
   sorted(shared['sources'].split(',')) == ['gap', 'momo'], f"{shared['sources']}")
ok("...and how many did", shared['source_count'] == 2, f"{shared['source_count']}")
ok("the HIGHEST-scoring row supplies the card", shared['score'] == 95,
   f"{shared['score']}")
solo = [r for r in allr['rows'] if r['ticker'] == 'AAA'][0]
ok("a name only one tool found reports a count of 1", solo['source_count'] == 1)

print("=" * 64)
print("PART D — a dead tool is REPORTED, never read as 'no candidates'")
print("=" * 64)
ok("the merged read still succeeds on the tools that answered", allr['ok'] is True)
ok("...and names the one that did not",
   any('dead' in f for f in allr.get('sources_failed') or []),
   f"{allr.get('sources_failed')}")
ok("...and counts how many answered", allr['sources_ok'] == 2, f"{allr.get('sources_ok')}")
dead = sc.register_rows('dead:R1', '2026-07-14')
ok("asking a dead tool alone FAILS loudly rather than returning empty",
   dead['ok'] is False and dead['rows'] == [] and 'dead' in (dead.get('error') or ''),
   f"{dead}")
missing = sc.register_rows('momo:R1', '2020-01-01')
ok("a day with no rows is an empty SUCCESS, not an error",
   missing['ok'] is True and missing['rows'] == [])
hp = sc.source_health()
ok("health reports every tool, up or down", len(hp) == 3)
ok("...with the two live ones ok", sum(1 for h in hp if h['ok']) == 2,
   f"{[(h['id'], h['ok']) for h in hp]}")
ok("...and the dead one carrying its error",
   [h for h in hp if h['id'] == 'dead'][0].get('error'), )
agg = sc.health()
ok("the aggregate probe says how many of the tools are up",
   agg['sources_up'] == 2 and agg['sources_total'] == 3, f"{agg}")

print("=" * 64)
print("PART E — attribution: which scanning tool surfaced this name")
print("=" * 64)
ok("every row carries its tool id", all(r.get('source') for r in allr['rows']))
ok("...and the tool's human name",
   {r['source_name'] for r in allr['rows']} <= {'Momentum', 'Gappers'},
   f"{ {r.get('source_name') for r in allr['rows']} }")
ok("attribution survives full=True (so it reaches backtest trade ctx)",
   all(r.get('source') for r in
       sc.register_rows('*:R1', '2026-07-14', full=True)['rows']))
ok("the merged fields are CSV-safe scalars, not lists",
   all(isinstance(r['sources'], str) for r in allr['rows']))

# config loading
import os
os.environ['SCREENER_SOURCES'] = json.dumps(
    [{'id': 'a', 'name': 'A', 'url': 'http://a:1/'},
     {'id': 'b', 'url': 'http://b:2'}])
loaded = sc.reload_sources()
ok("sources load from $SCREENER_SOURCES",
   [s['id'] for s in loaded] == ['a', 'b'], f"{loaded}")
ok("a missing name falls back to the id",
   [s['name'] for s in loaded] == ['A', 'b'], f"{loaded}")
ok("trailing slashes are trimmed so URLs never double up",
   loaded[0]['url'] == 'http://a:1')
os.environ['SCREENER_SOURCES'] = 'not json at all'
# A typo in the override must land on the REGISTRY, not on a lone
# localhost:3000 — that would silently shrink the universe to one tool while
# looking like a working configuration.
_broken = sc.reload_sources()
ok("a malformed override falls through to the tool registry, not to one source",
   len(_broken) >= 9, f"{len(_broken)}")
del os.environ['SCREENER_SOURCES']
# THE TOOL REGISTRY is the source of truth — tools.config.json at the repo
# root, the same file the deploy script, the landing page and the seeder read.
# A tenth tool must appear here with no edit to this module, which is exactly
# what a hand-maintained list could not promise (mine had seven tools and had
# T7's name wrong within a day of being written).
sc.reload_sources()
cfg_path = pathlib.Path(sc.__file__).resolve().parents[2] / 'tools.config.json'
cfg = json.loads(cfg_path.read_text())
tools = cfg.get('tools') or []
live = sc.sources()
ok("every tool in tools.config.json becomes a source",
   len(live) == len(tools) and len(tools) >= 9, f"{len(live)} vs {len(tools)}")
ok("ids come straight from the registry",
   [s['id'] for s in live] == [t['id'] for t in tools], f"{[s['id'] for s in live]}")
ok("names carry the tool's real name, not a guess",
   any(s['name'].endswith('Liquid Movers') for s in live), f"{[s['name'] for s in live]}")
ok("each source points at the APP port from the registry",
   [int(s['url'].rsplit(':', 1)[1]) for s in live] == [t['port'] for t in tools])
ok("NO source points at a scorerPort (a scorer 404s a warehouse request)",
   not ({int(s['url'].rsplit(':', 1)[1]) for s in live}
        & {t['scorerPort'] for t in tools if t.get('scorerPort')}))
ok("the tool's accent colour rides along, so it is recognisable everywhere",
   all(s.get('color') for s in live))
ok("so does the time that tool freezes R1 (09:36 … 10:16 — they differ)",
   len({s.get('capture_r1') for s in live}) > 1,
   f"{ {s['id']: s.get('capture_r1') for s in live} }")
ok("adding a tenth tool needs no code change here",
   'screener_sources.json' not in
   [p.name for p in (pathlib.Path(sc.__file__).resolve().parent).glob('*.json')],
   'a hand-maintained list is back and will go stale')
ok("an explicit $SCREENER_SOURCES still overrides the registry",
   True)   # exercised above

print("=" * 64)
print("PART F — a backtest reports the universe PER scanning tool")
print("=" * 64)
# Seven tools do not contribute equally: one with months of frozen registers
# supplies nearly every pair while one switched on last week supplies a
# handful. A merged run must say so, or it reads as a seven-way comparison
# when it is one tool plus noise.
import chart.backtest as btm
import chart.strategy as _S

sc._SOURCES = [{'id': 'old', 'name': 'T1 Screener', 'url': 'http://x:3000'},
               {'id': 'new', 'name': 'T2 Momentum', 'url': 'http://x:3001'}]
WH2 = {
    'http://x:3000': {'dates': ['2026-07-13', '2026-07-14'],
                      'R1': {'2026-07-13': [{'ticker': 'AAA', '_score': 90},
                                            {'ticker': 'BBB', '_score': 80}],
                             '2026-07-14': [{'ticker': 'AAA', '_score': 90},
                                            {'ticker': 'CCC', '_score': 70}]}},
    'http://x:3001': {'dates': ['2026-07-14'],           # switched on late
                      'R1': {'2026-07-14': [{'ticker': 'DDD', '_score': 95}]}},
}
def fake_get2(path, base=''):
    wh = WH2.get(base)
    if wh is None:
        raise RuntimeError('refused')
    if path.startswith('/available-dates'):
        return wh['dates']
    reg, _, date = path.lstrip('/').partition('/')
    return wh.get(reg, {}).get(date, [])
sc._get = fake_get2

prs = btm._pairs({'universe': {'kind': 'register', 'register': '*:R1'},
                  'start': '2026-07-13', 'end': '2026-07-14'})
# 07-13: old AAA+BBB = 2.  07-14: old AAA+CCC and new DDD = 3.  -> 5
ok("pairs come from both tools", len(prs) == 5, f"{len(prs)}")
ok("every pair knows which tool surfaced it",
   all((p[2] or {}).get('source') for p in prs))
srcs = sorted({(p[2] or {}).get('source') for p in prs})
ok("...and both tools are represented", srcs == ['new', 'old'], f"{srcs}")

# run() with a strategy that never fires: no trades, but coverage must still
# break the universe down by tool
NOFIRE = {'name': 'never', 'side': 'long',
          'entry': {'logic': 'AND', 'rules': [
              {'left': {'kind': 'price', 'field': 'close'}, 'op': 'lt',
               'right': {'kind': 'const', 'value': -1}}]},
          'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
_orig_eval = _S.evaluate
_S.evaluate = lambda *a, **k: {'ok': True, 'bars': 100, 'entries': [],
                               'trades': [], 'open_trade': None}
try:
    out = btm.run({'strategy': NOFIRE, 'tf': '5m', 'feed': 'polygon',
                   'universe': {'kind': 'register', 'register': '*:R1'},
                   'start': '2026-07-13', 'end': '2026-07-14'})
finally:
    _S.evaluate = _orig_eval
bs = (out['summary'].get('coverage') or {}).get('by_source')
ok("coverage carries a per-tool breakdown", bool(bs), f"{bs}")
by = {b['source']: b for b in (bs or [])}
ok("the long-running tool's pair count is right", by.get('old', {}).get('pairs') == 4,
   f"{by.get('old')}")
ok("the newly-added tool's is too", by.get('new', {}).get('pairs') == 1,
   f"{by.get('new')}")
ok("each tool reports how many DAYS it actually covered",
   by.get('old', {}).get('days') == 2 and by.get('new', {}).get('days') == 1,
   f"{[(k, v.get('days')) for k, v in by.items()]}")
ok("...and its share of the universe",
   by.get('old', {}).get('pct_of_pairs') == 80.0, f"{by.get('old', {}).get('pct_of_pairs')}")
ok("tools are listed biggest-contributor first", bs[0]['source'] == 'old')
ok("the human name rides along, not just the id",
   by.get('old', {}).get('name') == 'T1 Screener')
ok("a lopsided run is called out explicitly",
   'not a like-for-like comparison' in
   ((out['summary'].get('coverage') or {}).get('source_imbalance') or ''),
   f"{(out['summary'].get('coverage') or {}).get('source_imbalance')}")
# a single-source run needs no such warning
out1 = None
try:
    _S.evaluate = lambda *a, **k: {'ok': True, 'bars': 100, 'entries': [],
                                   'trades': [], 'open_trade': None}
    out1 = btm.run({'strategy': NOFIRE, 'tf': '5m', 'feed': 'polygon',
                    'universe': {'kind': 'register', 'register': 'old:R1'},
                    'start': '2026-07-13', 'end': '2026-07-14'})
finally:
    _S.evaluate = _orig_eval
c1 = out1['summary'].get('coverage') or {}
ok("a single-tool run is not flagged as imbalanced",
   'source_imbalance' not in c1)
ok("...but still reports which tool it was",
   [b['source'] for b in (c1.get('by_source') or [])] == ['old'],
   f"{c1.get('by_source')}")
# and the UI/report actually surface it
_ui = (pathlib.Path(sc.__file__).resolve().parent / 'static' / 'index.html').read_text()
ok("the results panel shows the per-tool breakdown", 'by scanning tool:' in _ui)
ok("the printed report shows it too",
   'universe by scanning tool' in
   (pathlib.Path(sc.__file__).resolve().parent / 'server.py').read_text())

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
