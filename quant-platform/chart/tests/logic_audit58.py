"""Audit 58 — the cache is filled from the UNIVERSE, not from what was scanned.

THE BUG THIS EXISTS TO PIN DOWN.

C and A were served from a per-ticker cache that only two things ever filled:
the popup (one symbol, a deliberate tap) and, later, a background warmer fed
with the names a scan had just returned. Both fill the cache for names that
have ALREADY been looked at. Reported from live use:

    "what will I do with it after the market close — tomorrow new scan and new
     stock, I don't have any stocks that stay in the screener 2 days"

Which is exactly right, and it makes the warmer worthless on its own: it
prepares the second sighting of a name, and a screener that returns the same
names two mornings running has stopped working. Every card was a first
sighting with empty tables, and the cards said "EDGAR is walked nightly" about
a nightly walk that did not exist — run_daily.py refreshed prices, the market
model, the SIC map, 13F and the group ranks, and never touched fundamentals.

So the cache has to be filled from what COULD be screened, ahead of time.
"""

import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import edgar                                    # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}' + (f'  {extra}' if extra is not None else ''))


print('=' * 64)
print('audit 58 — C and A are waiting before the name is screened')
print('=' * 64)

ROOT = pathlib.Path(__file__).resolve().parents[2]
DAILY = (ROOT / 'deploy' / 'run_daily.py').read_text()
EDG = (ROOT / 'chart' / 'edgar.py').read_text()

# ── the step exists at all ──────────────────────────────────────────────
ok('the nightly job walks EDGAR for the earnings tables',
   'edgar.walk(' in DAILY)
ok('...over the RS universe, not over anything a screener returned',
   'relstrength.rs_rating()' in DAILY.split('def _fundamentals')[1]
   if 'def _fundamentals' in DAILY else False)
ok('...and it is the SAME universe the industry map classifies, or a stock '
   'would have a group and no tables',
   'rs_rating()' in DAILY and DAILY.count('rs_rating()') >= 2)
# LAST, not first. It is the longest step by a wide margin and nothing reads
# its output, so a night that runs out of time must still have published the
# market model and the group ranks.
ok('the walk runs after everything that publishes a file',
   DAILY.index('edgar.walk(') > DAILY.index('groups.write_shared'), DAILY.index('edgar.walk('))
ok('the reason the screener universe is not enough is written down',
   'stay in the screener' in DAILY
   or "tomorrow's screener returns names" in DAILY)

# ── ordering: resumable, and coverage only grows ────────────────────────
AGES = {'NEW': None, 'STALE': 30.0, 'OLDISH': 9.0, 'FRESH': 1.0}
edgar_age = edgar._cache_age_days
try:
    edgar._cache_age_days = lambda t: AGES.get(str(t).upper(), None)
    seen = []
    real_build = edgar.build
    try:
        edgar.build = lambda t: (seen.append(t) or {'ticker': t, 'ok': False,
                                                    'error': 'stubbed'})
        out = edgar.walk(['FRESH', 'STALE', 'NEW', 'OLDISH'], refresh_days=5,
                         budget_s=0, log=lambda *_: None)
    finally:
        edgar.build = real_build
finally:
    edgar._cache_age_days = edgar_age

ok('a name with nothing on disk is fetched FIRST, so a universe that grew '
   'today is covered tonight rather than behind a queue of refreshes',
   seen and seen[0] == 'NEW', seen)
ok('...then the stalest, so an interrupted run did the most valuable part',
   seen == ['NEW', 'STALE', 'OLDISH'], seen)
ok('a record still inside the refresh age is not re-fetched',
   'FRESH' not in seen, seen)
ok('the count of what is left is reported, not just what was done',
   'remaining' in out and out['universe'] == 4, out)

# ── the refresh age is SHORTER than the age a card will accept ──────────
ok('the walk refreshes sooner than the reader expires',
   edgar.REFRESH_DAYS < 7.0, edgar.REFRESH_DAYS)
ok('...and the reason is stated: a record refreshed at 6.9 days would be '
   'fresh to the walk tonight and expired for the cards tomorrow',
   'Two days of margin' in EDG and 'lose its tables on a day nothing was '
   'wrong' in EDG.replace('\n# ', ' ').replace('\n', ' '))
ok('both are overridable, because five days is a judgement not a law',
   'QP_EDGAR_REFRESH_DAYS' in EDG and 'QP_EDGAR_WALK_SECONDS' in EDG)

# ── the budget bounds the night, not the job ────────────────────────────
seen2 = []
real_build = edgar.build
edgar_age = edgar._cache_age_days
try:
    edgar._cache_age_days = lambda t: None
    def _slow(t):
        seen2.append(t)
        time.sleep(0.02)
        return {'ticker': t, 'ok': False, 'error': 'stubbed'}
    edgar.build = _slow
    out2 = edgar.walk([f'S{i}' for i in range(50)], budget_s=0.05,
                      log=lambda *_: None)
finally:
    edgar.build = real_build
    edgar._cache_age_days = edgar_age

ok('a run out of time STOPS rather than running until morning',
   len(seen2) < 50 and out2['remaining'] > 0, (len(seen2), out2))
ok('...and says how many are first in line tomorrow',
   out2['remaining'] == out2['todo'] - (out2['built'] + out2['failed']
                                        + out2['no_filings']), out2)
ok('the first pass has a runner with NO ceiling, so it finishes',
   'budget_s=0' in (ROOT / 'deploy' / 'run_edgar.py').read_text())
_UNIT = (ROOT / 'deploy' / 'qp-edgar.service').read_text()
ok('...and a unit, because a run tied to a phone dies when the screen locks',
   'phone' in _UNIT.lower() and 'Type=simple' in _UNIT)
ok('...which is simple, not oneshot — oneshot killed the backfill mid-run',
   'TimeoutStartSec=infinity' in _UNIT)

# ── a permanent miss is an ANSWER; a bad night is not ───────────────────
ok('a company EDGAR has no filer for is permanent',
   edgar._permanent("X: not in EDGAR's ticker list"))
ok('...and so is a 404', edgar._permanent('EDGAR https://…: HTTP Error 404'))
ok('a timeout is NOT, because nothing was learned from it',
   not edgar._permanent('EDGAR https://…: timed out'))
ok('...nor is a 503', not edgar._permanent('EDGAR https://…: HTTP Error 503'))
ok('the reason both halves matter is written down: a fifth of a price '
   'universe has no filings, and one bad minute must not blank a real one',
   'never will' in EDG and 'one bad minute' in EDG)

wrote = []
real_wc = edgar.write_cached
real_build = edgar.build
edgar_age = edgar._cache_age_days
try:
    edgar._cache_age_days = lambda t: None
    edgar.write_cached = lambda d: wrote.append(d['ticker'])
    edgar.build = lambda t: (
        {'ticker': t, 'ok': True} if t == 'GOOD' else
        {'ticker': t, 'ok': False, 'error': "not in EDGAR's ticker list"}
        if t == 'DEAD' else
        {'ticker': t, 'ok': False, 'error': 'EDGAR …: timed out'})
    out3 = edgar.walk(['GOOD', 'DEAD', 'FLAKY'], budget_s=0,
                      log=lambda *_: None)
finally:
    edgar.write_cached = real_wc
    edgar.build = real_build
    edgar._cache_age_days = edgar_age

ok('a real answer is cached', 'GOOD' in wrote)
ok('"no filings" is cached too — it IS the answer, and tomorrow\'s walk '
   'spends its requests elsewhere', 'DEAD' in wrote)
ok('a transient failure is NOT cached, so it is retried tomorrow',
   'FLAKY' not in wrote, wrote)
ok('the three are counted separately, because they mean different things',
   (out3['built'], out3['no_filings'], out3['failed']) == (1, 1, 1), out3)

# ── the card says WHICH silence it is ───────────────────────────────────
UI = (ROOT.parent / 'public' / 'index.html').read_text()
ok('the card distinguishes "not reached yet" from "there is nothing"',
   'function _fundNote' in UI and 'no SEC filings' in UI)
ok('...and the annual table uses it too, instead of always saying '
   '"not fetched yet"', UI.count('_fundNote(f)') >= 2)
ok('the three silences are named where the helper is defined',
   'look identical on a card and mean opposite things' in UI)

JS = (ROOT.parent / 'src' / 'sideD' / 'oneil.js').read_text()
ok('the warmer treats a cached "no filings" as answered, not as a miss',
   "rec.cached !== true" in JS)

# ── THE CARD MUST NOT CONTRADICT ITSELF, OR NAME A WINDOW IT DID NOT HAVE ──
#
# From a live card, all on one screen:
#
#   L — LEADER OR LAGGARD        group not ranked yet
#   I — INSTITUTIONAL SPONSORSHIP  ...from SEC Form 13F — phase 6.
#                                  Not estimated here.
#   Sources and dates — ... groups 2026-08-31 ...
#
# The footer said the ranks were built that day while L said they were not,
# and the I block still announced a phase that had shipped, directly under a
# summary row printing holder counts. Neither was a data problem.

ok('L says WHICH silence it is, not "not ranked yet" for all three',
   'group ranks not built yet' in UI and 'not in the industry map' in UI)
ok('...and names the map it is missing from, so "built" and "contains this '
   'stock" cannot be confused again',
   'mapped_symbols' in UI and 'an ETF, or a filer with no SIC code' in UI)

# The placeholder SENTENCE, not the words "phase 6" — the comment recording
# why this was wrong necessarily quotes it.
ok('the I block reads the real 13F model instead of announcing a phase',
   'phase 6. Not estimated here.</span>' not in UI
   and 'F13_MODEL' in UI)
ok('...and keeps the three answers apart: not built, not matched, matched',
   '13F not built yet' in UI and 'not matched in 13F' in UI)
ok('...and still refuses to score it, at both ends',
   'nobody left to buy it' in UI)
ok('the footer dates 13F too, since it is the block most often absent',
   "13F pending" in UI and '45 days late' in UI)

# A rating is NAMED for its window. A stock six weeks off its IPO showed
# "U/D 0.49 50d · A/D E 13wk" built from about thirty sessions.
ok('a short window is labelled short rather than by the name of the full one',
   'function _wins' in UI and 'short of the' in UI)
ok('...on the summary row as well as in the full table',
   'short of ${want}' in UI and '_wins(x.ud.sessions' in UI)
ok('the reason is written where the helper is',
   'the one thing a reading must never do' in UI)

# The window sizes on the card have to be the ones the code actually uses.
from chart import ratings                                  # noqa: E402
ok('the card\'s "50" is ratings.UD_SESSIONS', ratings.UD_SESSIONS == 50)
ok('...and its "65" is AD_SESSIONS, which is what 13 weeks means here',
   ratings.AD_SESSIONS == 65)
ok('both functions report the sessions they used, which is what makes the '
   'label checkable at all',
   'sessions' in ratings.up_down_volume_ratio.__doc__ + str(
       ratings.up_down_volume_ratio.__code__.co_consts))

# ── A GROUP OF THREE IS NOT AN INDUSTRY ────────────────────────────────
#
# From the live group table, ranked over the whole market:
#
#     1 of 229  Computer Storage Devices                  5 members
#     3 of 229  Services-Skilled Nursing Care Facilities  3 members
#     5 of 229  Wholesale-Electronic Parts & Equipment    5 members
#
# The median of three IS the middle stock, so "the #1 industry group in the
# market" was one company's twelve-month move wearing an industry's name —
# and O'Neil's instruction, buy the leader of a top group, was pointed at it.
# Thin groups have the widest spread too, so they crowd BOTH ends of the
# ranking and push real industries into the middle.
import pandas as _pd                                       # noqa: E402
from chart import groups as _g                             # noqa: E402

ok('the floor is high enough that no single stock IS the median',
   _g.MIN_MEMBERS >= 6, _g.MIN_MEMBERS)
ok('...and the reason is the live table, quoted where the constant is',
   'Computer Storage Devices' in _g.__doc__ + open(
       ROOT / 'chart' / 'groups.py').read())
ok('it stays overridable', 'QP_GROUP_MIN_MEMBERS' in
   (ROOT / 'chart' / 'groups.py').read_text())

# Raising the floor ALONE would delete the L letter for every stock in a small
# industry. SIC is a hierarchy, so there is a real level above to use.
_MAP = {}
for _s in ('A1', 'A2', 'A3'):
    _MAP[_s] = {'industry': 'Tiny Storage', 'sector': 'Industrial Machinery'}
for _s in ('B1', 'B2', 'B3', 'B4'):
    _MAP[_s] = {'industry': 'Tiny Nursing', 'sector': 'Industrial Machinery'}
for _i in range(8):
    _MAP[f'C{_i}'] = {'industry': 'Real Software', 'sector': 'Business Services'}
_RS = _pd.Series({'A1': 99, 'A2': 98, 'A3': 97, 'B1': 96, 'B2': 95, 'B3': 94,
                  'B4': 93, **{f'C{_i}': 60 + _i for _i in range(8)}})
_ROWS = _g.build_groups(_RS, _MAP)
_NAMES = [r['group'] for r in _ROWS]
_SR = _g.stock_rows(_ROWS)

ok('a three-name industry is no longer ranked as an industry',
   'Tiny Storage' not in _NAMES, _NAMES)
ok('...and its stocks are NOT dropped — they roll up to their major group',
   'A1' in _SR and _SR['A1']['members'] == 7, _SR.get('A1'))
ok('two small industries in one sector land in the SAME bucket',
   _SR['A1']['group'] == _SR['B1']['group'], (_SR['A1'], _SR['B1']))
ok('a real industry keeps its own name and is ranked at industry level',
   'Real Software' in _NAMES
   and [r for r in _ROWS if r['group'] == 'Real Software'][0]['level']
   == 'industry')
ok('the rolled-up bucket is marked as a COARSER claim, never as an industry',
   _SR['A1']['group_level'] == 'sector'
   and 'small industries' in _SR['A1']['group'], _SR['A1'])
ok('...and the rank inside it is over the merged membership, not the old three',
   _SR['A1']['rs_in_group'] == 1 and _SR['B4']['rs_in_group'] == 7, _SR['B4'])
ok('the divisor still travels with every rank',
   all(r['of'] == len(_ROWS) for r in _ROWS))

# A whole major group with too few ranked names has no level above it.
_TINY = _g.build_groups(_pd.Series({'Z1': 90, 'Z2': 80}),
                        {'Z1': {'industry': 'Q', 'sector': 'S'},
                         'Z2': {'industry': 'Q', 'sector': 'S'}})
ok('a sector that is itself too small is dropped, not ranked on two names',
   _TINY == [], _TINY)

ok('the card marks a rolled-up group so it is not read as an industry',
   'rolled up' in UI and 'group_level' in UI)
ok('...in the group table as well as on the card',
   UI.count('rolled up') >= 2)
ok('the table says what the floor is and why it exists',
   'wearing an industry' in UI or 'one company\'s year' in UI)

# ── THE STATUS CHECK NAMES ONLY COMMANDS THAT EXIST ────────────────────
#
# The whole value of this script is that a person who does not read code can
# run one command and be told the next one. A fix line pointing at a unit that
# was never written is worse than no fix line — the first draft said
# "systemctl start qp-sic", and there is no qp-sic.
import re as _re                                           # noqa: E402
STAT = (ROOT / 'deploy' / 'run_status.py').read_text()
_UNITS = {p.stem for p in (ROOT / 'deploy').glob('qp-*.service')}
_named = set(_re.findall(r'systemctl start (qp-[a-z]+)', STAT))
ok('every unit the status check tells you to start actually exists',
   _named <= _UNITS, sorted(_named - _UNITS))
ok('...and it names the three that do', _named == {'qp-backfill', 'qp-daily',
                                                   'qp-edgar'}, _named)
_scripts = set(_re.findall(r'deploy/(run_[a-z_]+\.py)', STAT))
ok('every runner it points at exists too',
   all((ROOT / 'deploy' / f).exists() for f in _scripts), _scripts)

ok('it reports coverage against the universe, not just "the file is there"',
   'def coverage' in STAT and '% of universe' in STAT)
ok('...and says so rather than printing 0% when the universe is unknown',
   'coverage n/a' in STAT and 'a fact about\n    # this check' in STAT)
ok('it reads and never builds, so it is safe to run mid-job',
   'READ-ONLY' in STAT and '.build(' not in STAT and 'walk(' not in STAT)
ok('a file being rewritten underneath it is not reported as a failure',
   'mid-rewrite' in STAT)
ok('N and S are listed as having no file, since a blank one looks identical '
   'to a missing job', 'no file to build' in STAT and 'under 7 weeks' in STAT)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
