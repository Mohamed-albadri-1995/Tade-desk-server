"""A key in a file is not a feed that answers.

deploy-tools.sh printed, on every deploy, as the last word on whether the
morning was safe to trade:

    feeds: alpaca ok · polygon ok · yahoo ok

It read /api/health, whose `feeds` block is `_feed_status()` — an inventory of
CREDENTIALS. That function's own docstring already says why that is not
enough:

    "A key being PRESENT is not evidence that the plan behind it includes the
     data being asked for."

It was written after Polygon 403'd every 1-minute request while the inventory
called polygon the best feed available. The lesson was recorded and the deploy
line went on reporting the inventory anyway.

So it said "alpaca ok" every day while the desk's Alpaca key was refused
outright:

    Alpaca asset MMED 401: {"message": "unauthorized."}

A 401 is not a plan limit — the credential was not accepted at all. And the
deploy minutes earlier had called it ok. A FIELD THAT SAYS THE SAME THING
WHATEVER HAPPENED, in the one line anybody reads before the open. It is also
why the short-borrow check never ran once, which is how MMED reached the wire
on 2026-09-15 as an order the broker could not fill.

/api/feedcheck FETCHES. It reuses datacheck's own check_feed rather than
growing a second opinion about what a working feed looks like — two definitions
of "ok" is how this started — and it can never raise, because the caller is a
shell script inside a deploy and an exception there reads as "the feed is
down", which is a different and much worse answer than "the check could not
run".
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.datacheck as dc                                        # noqa: E402
import chart.server as S                                            # noqa: E402

PASS = 0
FAIL = 0


def ok(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {label}')
    else:
        FAIL += 1
        print(f'  FAIL {label} {detail}')


def field(d, name, missing=None):
    """A field, or `missing` on a file that has no such key.

    READ SOFTLY so the BEHAVIOUR fails on the previous file rather than the
    lookup. A KeyError proves a name is absent; the point here is that a feed
    which was refused must not report the same as one that answered.
    """
    return (d or {}).get(name, missing)


def run(answers, symbol='SPY'):
    """Call the endpoint with check_feed stubbed to whatever the case needs."""
    real_check = dc.check_feed
    asked = []

    def stub(feed, sym='SPY', days=40):
        asked.append((feed, sym))
        a = answers.get(feed)
        if isinstance(a, Exception):
            raise a
        return a or {'name': f'{feed}:{sym}', 'ok': False, 'severity': 'down',
                     'detail': 'no answer', 'ms': 1}

    dc.check_feed = stub
    try:
        return S.feedcheck(symbol), asked
    finally:
        dc.check_feed = real_check


GOOD = {'ok': True, 'severity': 'ok', 'ms': 120, 'detail': '40 bars'}
# The 09-16 morning, from the desk's own log.
REFUSED = {'ok': False, 'severity': 'down', 'ms': 90,
           'detail': 'alpaca:SPY 401: {"message": "unauthorized."}',
           'fix': 'check APCA_API_KEY_ID in quant-platform/.env'}


def by_feed(res):
    return {f['feed']: f for f in (res.get('feeds') or [])}


print('\n── it FETCHES, rather than reading the inventory ──────────────────')

res, asked = run({'yahoo': GOOD, 'alpaca': GOOD, 'polygon': GOOD})
# THE ASSERTION THE OLD FILE FAILED — there was no endpoint at all, and the
# deploy asked /api/health, which fetches nothing.
ok('every configured loader is actually asked', len(asked) >= 2, str(asked))
ok('and asked about a real symbol', all(s for _, s in asked), str(asked))
ok('the symbol asked about is reported back', field(res, 'symbol') == 'SPY',
   str(field(res, 'symbol')))
ok('it uses datacheck check_feed, not its own idea of a good feed',
   len(asked) == len(res.get('feeds') or []), str(asked))

print('\n── a refused key is NOT ok ────────────────────────────────────────')

res, _ = run({'yahoo': GOOD, 'alpaca': REFUSED, 'polygon': GOOD})
f = by_feed(res)
# THE WHOLE POINT. Under the old line this printed "alpaca ok".
ok('the refused feed reports ok:false', f['alpaca']['ok'] is False)
ok('and the working ones still report true',
   f['yahoo']['ok'] is True and f['polygon']['ok'] is True)
ok('the 401 itself is carried, not summarised away',
   '401' in (f['alpaca'].get('detail') or ''), str(f['alpaca'].get('detail')))
ok('with the fix beside it', 'APCA_API_KEY_ID' in (f['alpaca'].get('fix') or ''),
   str(f['alpaca'].get('fix')))
# THE TOTAL IS EVERY LOADER, not the three named above: data_manager carries
# hybrid and hybrid_yahoo too, and a check that quietly skipped them would
# report a clean morning for a feed nobody asked about. The two left unstubbed
# fall through to "no answer", which is correctly NOT a pass.
from chart import data_manager as _dm                               # noqa: E402
ok('the total is every loader the platform has, not a chosen few',
   field(res, 'total') == len(_dm.LOADERS),
   f"{field(res, 'total')} vs {len(_dm.LOADERS)}")
ok('and only the feeds that answered are counted as answering',
   field(res, 'answered') == sum(1 for x in res['feeds'] if x['ok']),
   f"{field(res, 'answered')} counted, "
   f"{sum(1 for x in res['feeds'] if x['ok'])} ok")
ok('alpaca is not among them', field(res, 'answered') == 2,
   str(field(res, 'answered')))

# A READER CAN TELL THE TWO RUNS APART, which is the property the old line
# lacked: it printed the same string for both.
all_good, _ = run({'yahoo': GOOD, 'alpaca': GOOD, 'polygon': GOOD})
ok('a refused run does not look like a clean one',
   field(all_good, 'answered') != field(res, 'answered'),
   f"{field(all_good, 'answered')} vs {field(res, 'answered')}")

print('\n── every feed is named, including the ones that worked ────────────')

ok('yahoo is listed even though it needs no key', 'yahoo' in f)
ok('each entry names its feed', all(x.get('feed') for x in res['feeds']))
ok('and how long it took, so a slow feed is visible',
   all(x.get('ms') is not None for x in res['feeds']))

print('\n── the check can never be the thing that fails ────────────────────')

# A CHECK THAT CAN THROW IS NOT A CHECK. The caller is a shell script inside a
# deploy running under `set -e`.
boom, _ = run({'yahoo': GOOD, 'alpaca': RuntimeError('socket exploded'),
               'polygon': GOOD})
ok('a loader that throws does not take the endpoint with it',
   field(boom, 'ok') is True)
fb = by_feed(boom)
ok('the throwing feed is reported as not ok', fb['alpaca']['ok'] is False)
# AN ERROR IS NEVER A ZERO, and it is never a pass either.
ok('and the exception text is what it says, not silence',
   'socket exploded' in (fb['alpaca'].get('detail') or ''),
   str(fb['alpaca'].get('detail')))
ok('the feeds either side of it are unaffected',
   fb['yahoo']['ok'] is True and fb['polygon']['ok'] is True)

print('\n── every feed failing is an answer, not an error ──────────────────')

dead, _ = run({'yahoo': REFUSED, 'alpaca': REFUSED, 'polygon': REFUSED})
ok('the endpoint still answers', field(dead, 'ok') is True)
ok('with zero answered', field(dead, 'answered') == 0, str(field(dead, 'answered')))
ok('and every feed named as failed',
   all(x['ok'] is False for x in dead['feeds']))

print('\n── it is a different question from the credential inventory ───────')

# BOTH STILL EXIST, and they must not be confused again: _feed_status answers
# "is a key configured", this answers "did it work". The bug was one standing
# in for the other.
import tools.compare_server as cs                                   # noqa: E402
inv = cs._feed_status()
ok('the inventory is still there and still about keys', 'feeds' in inv or inv,
   str(list(inv)[:4]))
ok('but this endpoint reports per-feed outcomes, not booleans',
   isinstance(res['feeds'], list)
   and all(isinstance(x, dict) for x in res['feeds']))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
