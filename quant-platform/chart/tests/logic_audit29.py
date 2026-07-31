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
ok("broken config falls back to a single working source, never zero",
   len(sc.reload_sources()) == 1)
del os.environ['SCREENER_SOURCES']
shipped = json.loads((pathlib.Path(sc.__file__).resolve().parent
                      / 'screener_sources.json').read_text())
ok("the shipped screener_sources.json lists all seven tools", len(shipped) == 7,
   f"{len(shipped)}")
ok("ids are unique (they land in ctx_source on every backtest trade)",
   len({s['id'] for s in shipped}) == 7)
# Each tool runs an APP port and a private SCORER port at app+1 bound to
# 127.0.0.1. The scorer speaks a different API and 404s a warehouse request,
# so pointing a source at one would look like a broken screener forever.
ports = sorted(int(s['url'].rsplit(':', 1)[1]) for s in shipped)
ok("every source points at an APP port (multiple of 10), never a scorer port",
   all(p % 10 == 0 for p in ports), f"{ports}")
ok("the tools are the documented 3000..3060 ladder",
   ports == [3000, 3010, 3020, 3030, 3040, 3050, 3060], f"{ports}")
ok("no source points at a scorer port (app+1)",
   not ({p + 1 for p in ports} & set(ports)))
ok("all reached over localhost — the AWS security group is irrelevant here",
   all('localhost' in s['url'] or '127.0.0.1' in s['url'] for s in shipped))

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
