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

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
