"""Audit part 50 — O'Neil's market model, against hand-built bars.

WHY THIS EXISTS.

M is the letter O'Neil calls the most important and the one most investors
ignore: he found THREE OUT OF FOUR stocks follow the general market. Every
other number on a card is about one company; this one decides whether to be
buying at all. If it is wrong it is wrong about everything at once.

It is also the only thing in the CANSLIM spec that is a STATE MACHINE, and a
state machine cannot be tested against live data — the answer changes every
day and there is nothing to compare it to. So every case here is bars built by
hand with the answer known in advance.

PART A — a distribution day is a DOWN day on HIGHER volume, and only inside a
         confirmed uptrend.
PART B — stalling: the distribution that is not a down day.
PART C — the two removal rules, and the 5% one is INTRADAY.
PART D — rally attempt, undercut reset, and the follow-through day: day 4+,
         +1.7%, and volume over the PRIOR SESSION — which is the whole of the
         volume test, and getting that wrong cost a wrong answer on the first
         live run. See the note in part D.
PART E — the count becomes the status, and the WORSE index wins.
PART F — what one STOCK did on those exact days (the per-card reflection).
PART G — it can never be the cause of a failure, and the shared file is atomic.
"""
import json
import os
import pathlib
import sys
import tempfile

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


from chart import oneil                                          # noqa: E402


def bars(rows, start='2024-01-02'):
    """rows = list of (close, volume) or (open, high, low, close, volume)."""
    idx = pd.bdate_range(start, periods=len(rows), tz='UTC')
    out = []
    for r in rows:
        if len(r) == 2:
            c, v = r
            out.append({'open': c, 'high': c * 1.004, 'low': c * 0.996,
                        'close': c, 'volume': v})
        else:
            o, h, l, c, v = r
            out.append({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v})
    return pd.DataFrame(out, index=idx)


def uptrend_prefix(n=80, start=100.0, vol=1_000_000):
    """Bars that walk the machine into a CONFIRMED UPTREND.

    The machine seeds in 'correction' on purpose — nothing is confirmed until a
    follow-through day confirms it — so every distribution test needs a real
    follow-through in front of it. That is the model working, and it is why
    this helper exists rather than a flag that skips the state machine.

    Shape: a decline to make a low, then a rally attempt whose day 4 is a
    +2.5% session on heavy volume.
    """
    rows = []
    p = start
    for _ in range(n):                       # drift down: makes the low
        p *= 0.997
        rows.append((p, vol))
    rows.append((p * 1.003, vol))            # day 1 — first up close
    rows.append((p * 1.004, vol))            # day 2
    rows.append((p * 1.005, vol))            # day 3
    p = p * 1.005
    p *= 1.025
    rows.append((p, vol * 3))                # day 4 — the follow-through
    # ...then a real uptrend, which is the point. Distribution happens ABOVE
    # the low the rally started from; without this cushion a handful of test
    # distribution days walks the index back under its own rally low and the
    # model — correctly — calls a correction instead. That is the machine
    # working, and it cost this fixture two rewrites to notice.
    for _ in range(20):
        p *= 1.005
        rows.append((p, vol))
    return rows


print('== A. a distribution day is a down day on HIGHER volume ==')
rows = uptrend_prefix()
base = rows[-1][0]
rows.append((base * 0.99, 4_000_000))        # −1.0% on volume up from 3.0M
r = oneil.index_pass(bars(rows), 'TEST')
ok('the machine reaches a confirmed uptrend via a follow-through',
   r['ftd'] is not None, r['state'])
ok('a −1.0% close on higher volume is a distribution day', r['count'] == 1, r['live'])

# VOLUME IS THE WHOLE POINT. It is the footprint of institutions selling, not
# of the index drifting, and a down day on LIGHTER volume is the latter.
rows2 = uptrend_prefix()
rows2.append((rows2[-1][0] * 0.99, 1_000_000))     # same −1.0%, volume DOWN
ok('...the same down day on LIGHTER volume is not one',
   oneil.index_pass(bars(rows2), 'T')['count'] == 0)

# −0.2% is the line, and it is a floor not a rounding.
rows3 = uptrend_prefix()
rows3.append((rows3[-1][0] * 0.999, 9_000_000))    # −0.1% on huge volume
ok('a −0.1% close is drift, not distribution, however heavy',
   oneil.index_pass(bars(rows3), 'T')['count'] == 0)

# THE UPTREND CONDITION, which is the one everybody drops. During a correction
# there is no uptrend to distribute FROM. Without this the count runs up
# through every decline and reads "extremely dangerous" on the day the bottom
# forms — inverted, on the one day it decides anything.
down = [(100 * (0.98 ** i), 3_000_000 + i * 100_000) for i in range(40)]
rc = oneil.index_pass(bars(down), 'T')
ok('heavy down days during a CORRECTION are not counted',
   rc['state'] == 'correction' and rc['count'] == 0, rc['count'])


print()
print('== B. stalling — the distribution that is not a down day ==')
# Heavy volume, almost no progress, closing in the lower half of the range.
# The price does not fall because the selling is being ABSORBED, and this is
# the shape that shows up at tops where an index grinds sideways for a
# fortnight on huge volume before it breaks.
rows = uptrend_prefix()
p = rows[-1][0]
stall_close = p * 1.001                       # +0.1%: under the +0.2% ceiling
rows_ohlc = [(c, c * 1.004, c * 0.996, c, v) for c, v in rows]
rows_ohlc.append((p, p * 1.02, p * 0.999, stall_close, 5_000_000))
r = oneil.index_pass(bars(rows_ohlc), 'T')
ok('an up day on heavy volume closing in the lower half IS distribution',
   r['count'] == 1 and r['live'][0]['kind'] == 'stalling', r['live'])

# ...and the same session closing STRONG is not. Heavy volume with the close on
# the high is accumulation; it is the position in the range that separates them.
rows_ohlc2 = [(c, c * 1.004, c * 0.996, c, v) for c, v in uptrend_prefix()]
p2 = rows_ohlc2[-1][3]
rows_ohlc2.append((p2, p2 * 1.02, p2 * 0.999, p2 * 1.019, 5_000_000))
ok('...the same volume closing near the high is not',
   oneil.index_pass(bars(rows_ohlc2), 'T')['count'] == 0)

ok('the two kinds are told apart in the output, because they read differently '
   'on a chart',
   {'distribution', 'stalling'} >= {d['kind'] for d in r['live']})


print()
print('== C. the two removal rules ==')
# 1. AGE — 25 sessions. A count that never expires only rises and is
#    meaningless by March.
rows = uptrend_prefix()
rows.append((rows[-1][0] * 0.99, 4_000_000))       # the distribution day
p = rows[-1][0]
for _ in range(24):                                 # 24 quiet sessions
    p *= 1.0001
    rows.append((p, 900_000))
ok('a distribution day is still live 24 sessions later',
   oneil.index_pass(bars(rows), 'T')['count'] == 1)
rows.append((p * 1.0001, 900_000))                  # the 25th
ok('...and drops out at 25', oneil.index_pass(bars(rows), 'T')['count'] == 0)

# 2. RECOVERY — 5%, and INTRADAY. The rule is that the index TRADES 5% above
#    the distribution day's close, so it fires on the HIGH. Using the close is
#    stricter than IBD's rule and would hold days in the count they had already
#    dropped: the market would read more dangerous than it is, on exactly the
#    days a new uptrend is starting.
rows = uptrend_prefix()
rows.append((rows[-1][0] * 0.99, 4_000_000))
dd_close = rows[-1][0]
ohlc = [(c, c * 1.004, c * 0.996, c, v) for c, v in rows]
# A session whose HIGH is 5.5% above the dd close but whose CLOSE is only 1%.
ohlc.append((dd_close, dd_close * 1.055, dd_close * 0.999, dd_close * 1.01, 900_000))
r = oneil.index_pass(bars(ohlc), 'T')
ok('a day that TRADES 5% above removes it, even closing 1% up',
   r['count'] == 0, r['live'])

ohlc2 = [(c, c * 1.004, c * 0.996, c, v) for c, v in rows]
ohlc2.append((dd_close, dd_close * 1.03, dd_close * 0.999, dd_close * 1.02, 900_000))
ok('...a 3% high does not', oneil.index_pass(bars(ohlc2), 'T')['count'] == 1)


print()
print('== D. rally attempt and the follow-through day ==')
# Day 1 is the first UP close after the low. A follow-through BEFORE day 4 is
# explicitly not one: bounces in the first three days are the norm inside
# downtrends, and the wait IS the filter.
def attempt(day_of_ftd, gain=0.025, vol_mult=3.0, n=80):
    rows = []
    p = 100.0
    for _ in range(n):
        p *= 0.997
        rows.append((p, 1_000_000))
    for d in range(1, day_of_ftd):
        p *= 1.003
        rows.append((p, 1_000_000))
    rows.append((p * (1 + gain), int(1_000_000 * vol_mult)))
    return oneil.index_pass(bars(rows), 'T')

ok('a +2.5% surge on day 3 is NOT a follow-through', attempt(3)['ftd'] is None)
ok('the same day on day 4 IS one', attempt(4)['ftd'] is not None)
ok('...and it is recorded with its day number', attempt(5)['ftd']['day'] == 5)

# +1.7% is O'Neil's last published figure — 1% in the early editions, 1.5% in
# How to Make Money in Stocks, 1.7% in The Successful Investor once program
# trading made 1% days ordinary.
ok('a +1.5% day is not enough (his number is 1.7%)',
   attempt(4, gain=0.015)['ftd'] is None)
ok('...+1.8% is', attempt(4, gain=0.018)['ftd'] is not None)

# VOLUME HAS TWO TESTS, and the second was missing from the spec's first draft.
ok('a big gain on LIGHTER volume than the prior day is not a follow-through',
   attempt(4, vol_mult=0.5)['ftd'] is None)

# THE PRIOR SESSION IS THE WHOLE VOLUME TEST, and getting this wrong cost a
# wrong answer on the FIRST live run.
#
# This model also required volume above the index's own 50-day average. That is
# a stricter variant some people apply; it is not the published rule, which is
# "in higher volume than the previous session". On real bars it blocked the
# Nasdaq's August 2026 follow-through, the rally attempt ran to day 23
# unconfirmed, and the model published "market in correction" through a rally
# the S&P 500 had already confirmed with a clean day-4 follow-through.
#
# A rule stricter than the published one does not fail safe. It fails to the
# wrong answer, and it does it quietly.
rows = []
p = 100.0
for _ in range(80):
    p *= 0.997
    rows.append((p, 5_000_000))            # a HIGH 50-day average
for _ in range(3):
    p *= 1.003
    rows.append((p, 900_000))              # then a few very quiet days
rows.append((p * 1.025, 1_100_000))        # up on the prior day, under the avg
r = oneil.index_pass(bars(rows), 'T')
ok('a day that beats the PRIOR SESSION is a follow-through, even under the '
   '50-day average — that is his rule', r['ftd'] is not None, r['ftd'])
ok('...and the 50-day comparison is still REPORTED, it just does not decide',
   r['ftd']['vol_above_50d'] is False, r['ftd'])
ok('the model says so in its own thresholds, so nobody re-tightens it',
   'not the published rule' in oneil.THRESHOLDS['ftd_volume']['why'])

# UNDERCUT. Without the reset the day-count keeps rising through a continuing
# decline and a bounce on day 40 of a bear market reads as a bottom.
rows = []
p = 100.0
for _ in range(80):
    p *= 0.997
    rows.append((p, 1_000_000))
low = p
rows.append((p * 1.003, 1_000_000))        # day 1
rows.append((p * 1.004, 1_000_000))        # day 2
rows.append((low * 0.97, 2_000_000))       # undercuts the low — attempt dead
rows.append((low * 0.98, 1_000_000))       # new day 1
rows.append((low * 0.985, 1_000_000))
rows.append((low * 0.99, 1_000_000))
rows.append((low * 0.99 * 1.025, 4_000_000))   # day 4 of the NEW attempt
r = oneil.index_pass(bars(rows), 'T')
ok('undercutting the low resets the attempt, and the count restarts',
   r['ftd'] is not None and r['ftd']['day'] == 4, r['ftd'])
ok('...and the reset is recorded, not silent',
   any(e['type'] == 'rally_reset' for e in r['events']))

# A late follow-through is FLAGGED, not refused — he allows day 10-11.
ok('day 4-7 is on time', attempt(6)['ftd']['timing'] == 'on time')
ok('day 8-11 is flagged late', attempt(9)['ftd']['timing'] == 'late')
# PAST DAY 11 IT IS FLAGGED, NOT REFUSED. A rally attempt that could never be
# confirmed would be a state the market cannot leave — it would sit in
# "correction" through an entire advance, which is the failure this model
# exists to avoid.
late = attempt(20)
ok('past day 11 it is flagged "very late" and still counted',
   late['ftd'] is not None and late['ftd']['timing'] == 'very late', late['ftd'])
ok('...and the state does become a confirmed uptrend, not a dead end',
   late['state'] == 'confirmed_uptrend', late['state'])

# A NEW UPTREND STARTS WITH A CLEAN COUNT.
rows = uptrend_prefix()
rows.append((rows[-1][0] * 0.99, 4_000_000))
ok('a follow-through clears the old distribution count',
   oneil.index_pass(bars(rows), 'T')['count'] == 1)


print()
print('== E. the count becomes the status, and the WORSE index wins ==')
def with_dds(k):
    """k distribution days inside a confirmed uptrend."""
    rows = uptrend_prefix()
    p = rows[-1][0]
    for _ in range(k):
        p *= 0.99
        rows.append((p, 6_000_000))
        p *= 1.0005
        rows.append((p, 800_000))          # a quiet day between them
    return bars(rows)

m2 = oneil.market_model({'^GSPC': with_dds(2)})
ok('2 live days is a confirmed uptrend', m2['status'] == 'confirmed_uptrend', m2['status'])
m5 = oneil.market_model({'^GSPC': with_dds(5)})
ok('5 is uptrend under pressure', m5['status'] == 'uptrend_under_pressure', m5['status'])
m6 = oneil.market_model({'^GSPC': with_dds(6)})
ok('6 is a market in correction', m6['status'] == 'market_in_correction', m6['status'])

# A RALLY ATTEMPT IS NOT A FOURTH STATUS, and treating it as one was a real bug
# this audit found. IBD publishes exactly three labels; a rally attempt happens
# INSIDE "Market in correction" — the market has fallen, it is trying to bounce,
# and until a follow-through confirms the bounce the correction still stands.
# Publishing it as its own status reads as an improvement on a correction,
# which is exactly backwards: a rally attempt is a correction, plus hope.
ok('a rally attempt does NOT become its own published status',
   m6['status'] == 'market_in_correction', m6['status'])
ok('...it is reported as detail beside the correction',
   m6['indexes']['^GSPC']['in_rally_attempt'] is True
   and m6['rally_attempt'] and m6['rally_attempt']['day'] >= 1, m6['rally_attempt'])
ok('...and the reason says the correction still stands',
   'correction still stands' in m6['because'], m6['because'])
ok('only the three published labels can ever be a status',
   set(oneil.STATUS_LABEL) == {'confirmed_uptrend', 'uptrend_under_pressure',
                               'market_in_correction'})
ok('...while the machine still tracks the internal state it needs',
   m6['indexes']['^GSPC']['state'] == 'rally_attempt')

# COUNTED PER INDEX, NEVER POOLED. They diverge often and the divergence says
# which half of the market is being sold. Pooling would double-count a day the
# two shared and hide that.
both = oneil.market_model({'^GSPC': with_dds(1), '^IXIC': with_dds(5)})
ok('the WORSE of the two indexes drives the status',
   both['status'] == 'uptrend_under_pressure', both['status'])
ok('...and both counts are still published separately',
   both['indexes']['^GSPC']['count'] == 1 and both['indexes']['^IXIC']['count'] == 5,
   {k: v['count'] for k, v in both['indexes'].items()})

# A status word with no rows behind it is not checkable, and this is a claim
# about when to stop buying.
ok('every live day is listed with its date, index, move and volume ratio',
   len(m5['distribution_days']) == 5
   and all({'date', 'index', 'pct', 'vol_ratio', 'kind'} <= set(d)
           for d in m5['distribution_days']), m5['distribution_days'][:1])
ok('...newest first',
   [d['date'] for d in m5['distribution_days']]
   == sorted([d['date'] for d in m5['distribution_days']], reverse=True))

# EVERY NUMBER CARRIES THE RULE THAT PRODUCED IT.
ok('the rules in use are published with the status', '1.7%' in m5['rules_in_use']
   and '25 sessions' in m5['rules_in_use'], m5['rules_in_use'])
ok('...and every threshold carries its provenance',
   all('source' in t and 'why' in t for t in m5['thresholds'].values()))
ok("...naming O'Neil for the follow-through gain, not us",
   "O'Neil" in m5['thresholds']['ftd_gain_pct']['source'])
ok('the fuzzy edge is admitted rather than hidden',
   'not fully published' in m5['model_note'])
ok('the follow-through caveat travels with the model',
   'one in four' in m5['ftd_caveat'])

# HOW FAR INTO THE UPTREND. O'Neil buys early in one, and this is where
# base-stage counting starts, because bases are counted from the market bottom.
ok('sessions since the follow-through are counted',
   m2['sessions_since_ftd'] is not None and m2['sessions_since_ftd'] >= 0)
ok('...and banded', m2['ftd_band'] in ('early', 'established', 'late'))


print()
print('== F. what THIS stock did on those exact days ==')
# The reason the market model is worth putting on a card. Stamping "uptrend
# under pressure" on 150 cards is 150 identical lines, and a field with the
# same value on every row carries no information about any row.
days = [{'date': '2024-03-01', 'index': 'S&P 500', 'pct': -1.0},
        {'date': '2024-03-04', 'index': 'S&P 500', 'pct': -0.8},
        {'date': '2024-03-05', 'index': 'S&P 500', 'pct': -1.2}]
idx = pd.to_datetime(['2024-02-29', '2024-03-01', '2024-03-04', '2024-03-05'], utc=True)
leader = pd.DataFrame({'open': [100, 101, 102, 103], 'high': [101, 102, 103, 104],
                       'low': [99, 100, 101, 102], 'close': [100.0, 101.0, 102.0, 103.0],
                       'volume': [1e6] * 4}, index=idx)
r = oneil.stock_vs_distribution(leader, days)
ok('a stock UP on every distribution day is holding up',
   r['held'] == 3 and r['verdict'] == 'HOLDING UP', r)
ok('...and the relative move is measured against the INDEX, not zero',
   r['avg_rel'] > 1.0, r['avg_rel'])

laggard = leader.copy()
laggard['close'] = [100.0, 97.0, 95.0, 92.0]
ok('a stock down harder than the index is giving way',
   oneil.stock_vs_distribution(laggard, days)['verdict'] == 'GIVING WAY')

# THE DATES ARE SHOWN, not just the count, so it can be checked on a chart.
ok('the individual dates come back with it',
   len(r['dates']) == 3 and r['dates'][0]['date'] == '2024-03-01', r['dates'][:1])

# "0 of 0" reads as a failure. In a confirmed uptrend with no live distribution
# days there is nothing to hold up through, and saying so is the honest answer.
none = oneil.stock_vs_distribution(leader, [])
ok('no live distribution days says so, rather than printing 0 of 0',
   none['checked'] == 0 and 'nothing to hold up' in none['note'], none)
ok('a stock with no bars on those days says THAT instead',
   'no bars' in (oneil.stock_vs_distribution(
       leader.iloc[:1], days)['note'] or ''),
   oneil.stock_vs_distribution(leader.iloc[:1], days))


# MANY SYMBOLS, ONE PLACE. Every screener tool wants this for the tickers on
# its own page; nine of them each fetching the same daily bars would be nine
# copies of the same work against the same feed.
many = oneil.stocks_vs_distribution([], days)
ok('an empty symbol list is an empty answer, not a crash', many == {})
none_days = oneil.stocks_vs_distribution(['AAPL', 'MSFT'], [])
ok('with no live distribution days every symbol says so, without fetching',
   set(none_days) == {'AAPL', 'MSFT'}
   and all('nothing to hold up' in v['note'] for v in none_days.values()), none_days)
# A SYMBOL THAT CANNOT BE FETCHED IS NOT DROPPED. "We could not check this one"
# and "this one did not hold up" are opposite conclusions, and a missing key
# would let the page draw the second from the first.
unfetchable = oneil.stocks_vs_distribution(['NOTAREALTICKERXYZ'], days)
ok('a symbol that cannot be fetched comes back with a NOTE, not missing',
   'NOTAREALTICKERXYZ' in unfetchable
   and unfetchable['NOTAREALTICKERXYZ']['verdict'] is None
   and unfetchable['NOTAREALTICKERXYZ']['note'], unfetchable)

SRV = (pathlib.Path(__file__).resolve().parents[1] / 'server.py').read_text()
ok('qp serves it for a LIST of symbols in one request',
   "@app.get('/api/oneil/stock')" in SRV and 'symbols' in SRV)
ok('the market model endpoint has a TTL, so a stale read cannot answer forever',
   'age_h < 12' in SRV)
ok('...and it reports WHERE it published, not only in the log',
   "'wrote': where" in SRV)


print()
print('== G. it can never be the cause of a failure ==')
# The market model being stale must never be able to stop a scan on any of the
# nine tools. Every reader falls back to no data and renders as it does today.
_tmp = tempfile.mkdtemp(prefix='oneil-')
oneil.SHARED = pathlib.Path(_tmp) / 'oneil-market.json'
p = oneil.write_shared(m5)
ok('the model is published to the shared file', p and os.path.exists(p))
ok('...and reads back identically',
   oneil.read_shared()['status'] == m5['status'])
# ATOMIC. A reader must never see half a file, and nine tools read this one on
# their own schedules while qp rewrites it after every close.
ok('it is written via a temp file and renamed, so a reader never sees half',
   '.tmp' in pathlib.Path(__file__).parents[1].joinpath('oneil.py').read_text()
   and 'replace(SHARED)' in pathlib.Path(__file__).parents[1]
       .joinpath('oneil.py').read_text())

oneil.SHARED = pathlib.Path('/proc/nonexistent/cannot/exist/x.json')
ok('an unwritable location returns None rather than raising',
   oneil.write_shared(m5) is None)
ok('a missing file reads as None, not an exception', oneil.read_shared() is None)

ok('an empty frame does not raise', oneil.market_model({})['ok'] is False)
ok('a frame with no rows is skipped, not crashed on',
   oneil.market_model({'^GSPC': pd.DataFrame()}).get('ok') is False)
try:
    oneil.index_pass(pd.DataFrame({'close': [1, 2]}), 'T')
    ok('missing OHLC columns raise a NAMED error', False)
except ValueError as e:
    # It must name the column that is missing. "KeyError: 'volume'" three
    # frames deep is what this replaces.
    ok('missing OHLC columns raise a NAMED error',
       'column' in str(e) and 'close' in str(e), e)

# A PARTIAL MODEL SAYS SO. The status is the worse of the two indexes, so one
# index missing changes the answer and silence about it would be a lie.
ok('build() reports which index it could not fetch',
   'errors' in oneil.build.__doc__ or 'partial' in
   pathlib.Path(__file__).parents[1].joinpath('oneil.py').read_text())

import shutil                                                    # noqa: E402
shutil.rmtree(_tmp, ignore_errors=True)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
