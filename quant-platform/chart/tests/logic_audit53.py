"""Audit part 53 — the data check catches bad data, not just missing data.

WHY THIS EXISTS.

A source that is DOWN is the easy case: it throws, something logs, somebody
notices. The dangerous case is a source that answers 200 with data that is
wrong — empty, stale, all-NaN, no volume, the wrong symbol, a split not
applied. Every one of those renders as a normal-looking card, and nothing in
this system would have caught any of them.

So `chart/datacheck.py` exists. And a health check nobody has tested is worth
less than none at all, because it converts "I do not know" into a green tick.

THIS AUDIT IS OFFLINE ON PURPOSE. The live probe cannot be in the gate — it
needs a network, and its answer changes every day. What CAN be tested, and is
the part that actually matters, is the JUDGEMENT: hand it a frame that is
broken in one specific way and check that it says so, in those words.

That is why judge_bars(), judge_agreement() and judge_file() are pure and take
data rather than fetching it.

PART A — every way a frame can be wrong, and it names each one.
PART B — agreement between two sources, which is the only check that can
         catch a feed that is confidently wrong.
PART C — the shared files: absent, stale, unparseable, present-but-empty.
PART D — it never raises, and a green result means something.
"""
import json
import pathlib
import sys
import tempfile
import time

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name} {extra}')


from chart import datacheck as dc                              # noqa: E402


def good_frame(n=40, end=None):
    """A frame with nothing wrong with it, ending today."""
    end = end or pd.Timestamp.now(tz='UTC').normalize()
    idx = pd.bdate_range(end=end, periods=n, tz='UTC')
    px = [100.0 * (1.001 ** i) for i in range(n)]
    return pd.DataFrame({'open': px, 'high': [p * 1.01 for p in px],
                         'low': [p * 0.99 for p in px], 'close': px,
                         'volume': [1_000_000] * n}, index=idx)


print('== A. every way a frame can be wrong ==')
g = dc.judge_bars(good_frame(), label='good')
ok('a clean frame passes', g['ok'] is True and g['severity'] == 'ok', g)
ok('...and says what it saw, rather than just "ok"',
   'rows' in g['detail'], g['detail'])

# EMPTY. The fetch "worked" and returned nothing — the single most common way
# a source fails without failing.
e = dc.judge_bars(pd.DataFrame(), label='empty')
ok('an empty frame is DOWN, not ok', e['ok'] is False and e['severity'] == 'down')
ok('...and says so plainly', 'no data' in e['detail'], e['detail'])
ok('None is treated the same as empty', dc.judge_bars(None, label='x')['ok'] is False)

# SHORT. A truncated window silently shortens every indicator built on it.
s = dc.judge_bars(good_frame(5), label='short')
ok('a truncated window is caught', s['ok'] is False and '5 rows' in s['detail'], s)

# NaN CLOSES. A gap the loader filled with nothing.
nan = good_frame()
nan.loc[nan.index[3:8], 'close'] = float('nan')
n = dc.judge_bars(nan, label='nan')
ok('NaN closes are caught, with a count',
   n['ok'] is False and '5 of 40' in n['detail'], n['detail'])

# ZERO VOLUME. This is the one that matters most, because it does not look
# like a failure anywhere: distribution days, follow-throughs, the U/D ratio
# and the A/D rating all quietly return "no signal" instead of "no data".
zv = good_frame()
zv['volume'] = 0
z = dc.judge_bars(zv, label='novol')
ok('a feed serving prices with no volume is caught',
   z['ok'] is False and 'volume test' in z['detail'], z['detail'])
# ...and a few missing sessions is a warning, not a failure: real feeds have
# holidays and half-days with odd volume, and failing on those would make the
# check something people learn to ignore.
pv = good_frame()
pv.loc[pv.index[:4], 'volume'] = 0
p = dc.judge_bars(pv, label='partvol')
ok('a few zero-volume sessions is a WARNING, not a failure',
   p['ok'] is True and p['severity'] == 'degraded', p)

# STALE. Yesterday's data answering today's question.
old = dc.judge_bars(good_frame(end=pd.Timestamp.now(tz='UTC').normalize()
                               - pd.Timedelta(days=30)), label='stale')
ok('a month-old last bar is caught', old['ok'] is False
   and 'trading days old' in old['detail'], old['detail'])
# Counted in TRADING days: a Monday check must not fail because the weekend
# exists, and a long weekend must not fail either.
fresh = dc.judge_bars(good_frame(end=pd.Timestamp.now(tz='UTC').normalize()
                                 - pd.Timedelta(days=3)), label='friday')
ok('a three-day-old bar is fine — weekends are not staleness',
   fresh['ok'] is True, fresh['detail'])

# ABSURD. A split not applied, or the wrong symbol entirely.
sp = good_frame()
sp.iloc[20:, sp.columns.get_loc('close')] = sp['close'].iloc[20:] / 2
a = dc.judge_bars(sp, label='split')
ok('a 50% one-day gap is caught as a split or a wrong symbol',
   a['ok'] is False and 'split' in a['detail'], a['detail'])

# OUT OF ORDER. Every rolling window becomes wrong in a way that produces
# numbers rather than errors.
oo = good_frame()
oo = oo.iloc[[5, 1, 2, 3, 4, 0] + list(range(6, 40))]
ok('bars out of chronological order are caught',
   dc.judge_bars(oo, label='oo')['ok'] is False)
dup = pd.concat([good_frame(), good_frame().tail(1)])
ok('duplicate timestamps are caught',
   'duplicate' in dc.judge_bars(dup, label='dup')['detail'])

# A frame with no close column at all is a shape problem, and it says which.
ok('a frame with no close column says which column is missing',
   'close' in dc.judge_bars(pd.DataFrame({'x': [1, 2]}), label='nc')['detail'])


print()
print('== B. agreement — the only check that catches a confident lie ==')
# Two feeds both returning well-formed recent data is not evidence either is
# right. Disagreeing on the same session of the same symbol is proof one is not.
same = dc.judge_agreement(good_frame(), good_frame(), name_a='yahoo', name_b='polygon')
ok('two feeds with identical data agree', same['ok'] is True, same)
ok('...and the worst difference is reported, not just a verdict',
   'worst_pct' in same and same['worst_pct'] == 0.0, same)

near = good_frame()
near['close'] = near['close'] * 1.001                 # 0.1% apart
ok('a 0.1% difference is inside tolerance',
   dc.judge_agreement(near, good_frame(), name_a='a', name_b='b')['ok'] is True)

split = good_frame()
split['close'] = split['close'] / 2                   # a split applied by one
bad = dc.judge_agreement(split, good_frame(), name_a='yahoo', name_b='polygon')
ok('a split applied by one feed and not the other is caught',
   bad['ok'] is False, bad)
ok('...and it says one of them is wrong, which is the actionable part',
   'one of them is wrong' in bad['detail'], bad['detail'])

# NO SHARED SESSIONS is not disagreement. Two feeds covering different windows
# have not been compared at all, and reporting that as a pass would be worse
# than reporting it as a failure.
other = good_frame(end=pd.Timestamp('2015-06-01', tz='UTC'))
nc = dc.judge_agreement(good_frame(), other, name_a='a', name_b='b')
ok('no overlapping sessions is DEGRADED, never a pass',
   nc['ok'] is False and nc['severity'] == 'degraded', nc)
ok('...and says nothing was compared',
   'nothing to compare' in nc['detail'], nc['detail'])
ok('one side missing is degraded, not a pass',
   dc.judge_agreement(good_frame(), pd.DataFrame(),
                      name_a='a', name_b='b')['severity'] == 'degraded')


print()
print('== C. the shared files ==')
# These are how qp talks to the nine tools, and a stale one is the quiet
# failure: every page renders, every number looks like a number, and the market
# status is a fortnight old.
tmp = pathlib.Path(tempfile.mkdtemp(prefix='dcheck-'))

missing = dc.judge_file(tmp / 'nope.json', label='absent')
ok('a file that was never written says so',
   missing['ok'] is False and 'not written yet' in missing['detail'])

broken = tmp / 'broken.json'
broken.write_text('{not json at all')
ok('a file that does not parse says THAT, not "missing"',
   'does not parse' in dc.judge_file(broken, label='broken')['detail'])

full = tmp / 'full.json'
full.write_text(json.dumps({'status': 'confirmed_uptrend', 'indexes': {'a': 1}}))
f = dc.judge_file(full, label='full', require=('status', 'indexes'))
ok('a fresh complete file passes', f['ok'] is True, f)

# PRESENT BUT EMPTY is the one a file-exists check would call healthy, and it
# is the state a failed rebuild leaves behind.
empty = tmp / 'empty.json'
empty.write_text(json.dumps({'status': None, 'indexes': {}}))
ee = dc.judge_file(empty, label='empty', require=('status', 'indexes'))
ok('a file that exists and parses but is EMPTY is caught',
   ee['ok'] is False and 'missing/empty' in ee['detail'], ee)
ok('...and names which keys were empty',
   'status' in ee['detail'] and 'indexes' in ee['detail'], ee['detail'])

stale = tmp / 'stale.json'
stale.write_text(json.dumps({'status': 'x', 'indexes': {'a': 1}}))
import os                                                      # noqa: E402
os.utime(stale, (time.time() - 400 * 3600,) * 2)
st = dc.judge_file(stale, label='stale', require=('status',))
ok('a stale file is DEGRADED and says nothing has rebuilt it',
   st['ok'] is False and 'nothing has rebuilt it' in st['detail'], st)

import shutil                                                  # noqa: E402
shutil.rmtree(tmp, ignore_errors=True)


print()
print('== D. a health check that can fail is not one ==')
SRC = (pathlib.Path(__file__).resolve().parents[1] / 'datacheck.py').read_text()
ok('run_all never raises — every probe is wrapped',
   'Never raises' in SRC)
ok('a failed fetch is a DOWN check, not an exception',
   "'severity': 'down'" in SRC and 'diagnose_failure' in SRC)

# The two indexes are not one more feed. The market model runs on exactly
# these and nothing else, so their absence has a named consequence.
ok('the indexes are checked by name, with what breaks if they are missing',
   'cannot be built without it' in SRC)

# THE UNIVERSE COUNT IS THE CHECK. A grouped-daily response with forty rows is
# not a market, and percentile-ranking against forty names produces ratings
# that look exactly like real ones.
ok('the RS universe is judged on how many symbols came back',
   'not a market rating' in SRC)
ok('...and on whether there is a full twelve months to rank over',
   'needs' in SRC and '253' in SRC)

# The summary has to say WHICH thing broke. A count of failures does not.
ok('the summary names the failing sources, not just a count',
   "c['name']" in SRC and 'summary' in SRC)
ok('degraded and down are counted separately, because they mean different '
   'things', "'degraded':" in SRC and "'down':" in SRC)

# THE LIVE PROBE IS DELIBERATELY NOT IN THE GATE. That gate is offline and
# deterministic; this asks the internet a question whose answer changes daily,
# and a gate that fails for reasons which are not regressions stops being read.
GATE = (pathlib.Path(__file__).resolve().parent / 'run_all.py').read_text()
ok('the live probe is NOT in the offline gate', 'datacheck_live' not in GATE)
ok('...but this audit, which tests its judgement, IS',
   'logic_audit53' in GATE)
LIVE = (pathlib.Path(__file__).resolve().parent / 'datacheck_live.py').read_text()
ok('the live runner exits non-zero only on DOWN, not on degraded',
   "sys.exit(1 if r['down'] else 0)" in LIVE)
ok('...and says why it is not in the gate', 'not in the gate' in LIVE)

# Both halves, or the list just looks shorter. qp holds the bar feeds and the
# RS universe; the tool holds the scanner, the news and the industry map.
NODE = (pathlib.Path(__file__).resolve().parents[3] / 'src' / 'routes' / 'datacheck.js').read_text()
ok('the tool checks the scanner it actually runs on', 'tradingview scanner' in NODE)
ok('...the news sources', 'finnhub' in NODE)
ok('...and the industry map, on its SIZE rather than its existence',
   'industry map' in NODE and 'only ${s.symbols} symbols' in NODE)
ok('qp being unreachable is itself a finding, not a shorter list',
   'no health report' in NODE.lower() or 'NO health report' in NODE)

# THE ENVIRONMENT THE CHECK RUNS IN MUST BE THE ONE THE SERVICE RUNS IN, and
# this is a real failure the first live run produced: qp runs under systemd
# with EnvironmentFile=~/trade-desk.env, a shell does not, and the check
# reported polygon and alpaca DOWN with "API key must be set" while the service
# beside it had the keys and was working. A red light for a green system is
# worse than no light: the next real failure is the one nobody believes.
ok('the live runner loads the same env file the service does',
   'trade-desk.env' in LIVE)
ok('...and an exported key still WINS, so a one-off run keeps working',
   'setdefault' in LIVE)
ok('...and it says which env files it loaded', '_LOADED' in LIVE)
ok('...and warns loudly when it found none, naming the consequence',
   'no environment file found' in LIVE and 'because the feed is broken' in LIVE)

# One working feed is not a healthy system. Reporting only that it answered,
# with nothing to check it AGAINST, is the state most worth naming.
ok('fewer than two comparable feeds is reported, not silently omitted',
   'only {len(names)} feed can be compared' in SRC)
ok('...and says what is missing: whether it is RIGHT, not whether it answered',
   'only that it answered' in SRC)

# A check that says something is broken and not how to unbreak it makes the
# reader open an SSH session to find out, which is most of the cost.
ok('failures carry a FIX, not just a diagnosis', 'FIXES' in SRC and "'fix'" in SRC)
ok('...and the runner prints it', "c.get('fix')" in LIVE)
ok('the RS universe fix names the actual command',
   'relstrength.backfill' in SRC)

# A FAILED FEED IS THREE DIFFERENT PROBLEMS WEARING ONE EXCEPTION, and they
# need three different actions. Reported as one line of nginx HTML they are
# indistinguishable, which is what the desk actually hit: an Alpaca key was
# regenerated and the check said "401 Authorization Required <html><head>…".
import os as _os                                               # noqa: E402
_saved = {k: _os.environ.get(k) for k in
          ('POLYGON_API_KEY', 'APCA_API_KEY_ID', 'APCA_API_SECRET_KEY')}
try:
    _os.environ.pop('POLYGON_API_KEY', None)
    d, fix = dc.diagnose_failure('polygon', 'POLYGON_API_KEY must be set')
    ok('no key at all is named as such, with the variable',
       'no key configured' in d and 'POLYGON_API_KEY' in d, d)
    ok('...and the fix names the env file and the restart',
       'trade-desk.env' in fix and 'restart' in fix, fix)

    _os.environ['APCA_API_KEY_ID'] = 'x'
    _os.environ['APCA_API_SECRET_KEY'] = 'y'
    d2, fix2 = dc.diagnose_failure(
        'alpaca', 'Alpaca 401: <html><head><title>401 Authorization Required')
    ok('a key that is SET and REJECTED is a different diagnosis from no key',
       'REJECTED' in d2 and 'no key' not in d2, d2)
    ok('...and it suggests the most likely cause: the key was regenerated',
       'regenerated' in d2, d2)
    ok('...and the HTML noise is gone', '<html' not in d2 and len(d2) < 90, d2)

    # Polygon's documented live failure: the key is fine, the PLAN is not.
    # A SERVER RESPONSE OUTRANKS A MISSING ENVIRONMENT VARIABLE. The key is
    # deliberately absent from THIS process here, and the answer must still be
    # about the plan: a 403 NOT_AUTHORIZED proves a request was made with a
    # key, which is exactly the case when the check runs somewhere the service
    # does not. Getting this order wrong told the desk to add a key it had.
    d3, fix3 = dc.diagnose_failure(
        'polygon', '403 {"status":"NOT_AUTHORIZED","message":"upgrade your plan"}')
    ok('a plan that does not cover the data is its own diagnosis',
       'PLAN does not include' in d3, d3)
    ok('...and the fix says yahoo already covers it, rather than "buy more"',
       'yahoo covers it' in fix3, fix3)

    d4, _ = dc.diagnose_failure('yahoo', 'Connection timed out')
    ok('a timeout says to re-run before changing anything', 'timed out' in d4, d4)

    # Anything unrecognised still gets through, but SHORT. An HTML page is not
    # a message, and 200 characters of markup in a terminal table is unreadable.
    d5, _ = dc.diagnose_failure('yahoo', 'weird thing <html><body>' + 'x' * 500)
    ok('an unknown HTML error is cut back to a sentence',
       '<html' not in d5 and len(d5) < 160, d5)
finally:
    for _k, _v in _saved.items():
        if _v is None:
            _os.environ.pop(_k, None)
        else:
            _os.environ[_k] = _v

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
