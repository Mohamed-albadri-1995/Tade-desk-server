"""Audit part 55 — the base, on a WEEKLY chart, as O'Neil taught it.

WEEKLY IS NOT A DISPLAY CHOICE, and this audit exists mostly to hold that line.

O'Neil taught bases on weekly charts and MarketSmith draws them weekly. Every
threshold in the pattern is stated in weeks, and running the same tests on
daily bars is a different measurement wearing the same words:

    a base is 7-65 WEEKS. On daily bars that is 35-325 of them, and every
    shape test drowns in intraday noise.

    "heavy volume with no price progress" is a WEEK closing flat on volume
    well above average. One day doing that is a session. Five weeks of it is
    institutions absorbing what the decline shook out.

    the handle is a "minor controlled drift" of two to eight weeks. Measured
    daily it is a fortnight of wiggles with no shape at all.

PART A — it resamples to weekly, and says so.
PART B — the three phases: the waves down, the accumulation weeks, the handle.
PART C — what is NOT a base, which is most things.
PART D — the pivot, and the distance to it.
PART E — it reports numbers rather than a verdict, and never raises.
"""
import pathlib
import sys

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


from chart import base as B                                    # noqa: E402


def daily(weekly_closes, weekly_vols=None, start='2024-01-01'):
    """Turn a list of WEEKLY closes into daily bars, five days a week.

    Built this way on purpose: the input is what a weekly chart shows, and the
    module has to get back to it. If the resample were wrong, every expected
    number below would be wrong with it.
    """
    vols = weekly_vols or [1_000_000] * len(weekly_closes)
    rows, idx = [], []
    d = pd.Timestamp(start, tz='UTC')
    while d.dayofweek != 0:
        d += pd.Timedelta(days=1)
    prev = weekly_closes[0]
    for wc, wv in zip(weekly_closes, vols):
        for k in range(5):
            # A straight line within the week, so the weekly close is exactly
            # the number given and the weekly high/low bracket it.
            c = prev + (wc - prev) * (k + 1) / 5
            rows.append({'open': c, 'high': c * 1.01, 'low': c * 0.99,
                         'close': c, 'volume': wv / 5})
            idx.append(d)
            d += pd.Timedelta(days=1)
        d += pd.Timedelta(days=2)
        prev = wc
    return pd.DataFrame(rows, index=pd.DatetimeIndex(idx))


def cup(lip=100.0, low=75.0, weeks_down=12, weeks_up=12,
        handle_weeks=4, handle_low=None, vol=None):
    """A cup with a handle, in weekly closes: decline, base, recovery, drift."""
    out = [lip * 0.97, lip * 0.99, lip]
    for i in range(weeks_down):
        # In waves rather than a straight line: a decline is three legs down
        # with bounces between, which is what washes out weak holders.
        t = (i + 1) / weeks_down
        # An 8% bounce every fourth week. Under the 5% threshold a wave does
        # not end, which is the point of having a threshold — but it also
        # means a fixture with 4% bounces is a SMOOTH decline as far as the
        # counter is concerned, and that cost this fixture a rewrite.
        wobble = 1 + (0.08 if i % 4 == 3 else 0)
        out.append((lip + (low - lip) * t) * wobble)
    for i in range(weeks_up):
        out.append(low + (lip - low) * (i + 1) / weeks_up)
    peak = out[-1]
    hl = handle_low if handle_low is not None else peak * 0.93
    for i in range(handle_weeks):
        out.append(peak + (hl - peak) * (i + 1) / handle_weeks)
    return out


print('== A. weekly, and it says so ==')
d = daily([100.0, 101.0, 102.0, 103.0])
w = B.to_weekly(d)
ok('twenty daily bars become four weekly bars', len(w) == 4, len(w))
ok('...and the weekly close is the week\'s LAST close',
   abs(float(w['close'].iloc[-1]) - 103.0) < 1e-6, w['close'].tolist())
ok('...the weekly volume is the week\'s SUM, not its average',
   abs(float(w['volume'].iloc[0]) - 1_000_000) < 1, float(w['volume'].iloc[0]))
ok('...the weekly high is the week\'s highest',
   float(w['high'].iloc[-1]) >= float(w['close'].iloc[-1]))

r = B.analyse(daily(cup()))
ok('the analysis declares the timeframe it used', r.get('timeframe') == 'weekly', r)
ok('...and says WHY, so nobody reruns it on daily bars',
   'measure something else' in r.get('timeframe_note', ''), r.get('timeframe_note'))
ok('every length reported is in weeks', 'weeks' in r and isinstance(r['weeks'], int))

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'base.py').read_text()
ok('the module resamples before it measures anything',
   SRC.index('def to_weekly') < SRC.index('def analyse'))
ok('the week ends on Friday, like a weekly chart', "W-FRI" in SRC)
ok('the current PARTIAL week is kept, or every reading would be a week old',
   'partial final week is kept' in SRC)


print()
print('== B. the three phases ==')
r = B.analyse(daily(cup(weeks_down=12, weeks_up=12, handle_weeks=4)))
ok('the base is found, and its length is in weeks',
   r['ok'] and 25 <= r['weeks'] <= 32, r['weeks'])
ok('the left lip is the high the base started from',
   abs(r['left_lip'] - 100.0) < 1.5, r['left_lip'])
ok('the depth is measured lip to low',
   22 <= r['depth_pct'] <= 28, r['depth_pct'])
ok('...and a 25% base is in the typical band',
   r['checks']['depth_typical'] is True, r['depth_pct'])

# PHASE 1 — the waves. "Typically three down, which washes out weak retail
# holders." Counted with a threshold, or a smooth fall counts as thirty and
# every one-week bounce ends a wave.
ok('the decline is counted in WAVES, not bars', r['waves_down'] >= 2, r['waves_down'])
straight = B.analyse(daily([100.0] * 3 + [100 - i * 2 for i in range(13)]
                           + [74 + i * 2 for i in range(13)]))
ok('a single smooth leg down is one wave, not thirteen',
   straight['ok'] and straight['waves_down'] <= 2, straight.get('waves_down'))

# PHASE 2 — HEAVY VOLUME WITHOUT PRICE PROGRESS. The phase people skip, and
# the one that says institutions were absorbing what the decline shook out.
closes = cup()
vols = [1_000_000] * len(closes)
flat = [100.0, 101.0, 102.0] + [80.0] * 6 + [80 + i * 2 for i in range(12)]
fvols = [1_000_000] * 3 + [4_000_000] * 6 + [1_000_000] * 12
acc = B.analyse(daily(flat, fvols))
ok('flat WEEKS on heavy volume are found and counted',
   len(acc['accumulation_weeks']) >= 4, len(acc['accumulation_weeks']))
ok('...and each is listed with its week and volume multiple, so it can be '
   'seen on the chart',
   all({'week', 'vol_x', 'close_chg_pct'} <= set(a) for a in acc['accumulation_weeks']),
   acc['accumulation_weeks'][:1])
quiet = B.analyse(daily(flat, [1_000_000] * len(flat)))
ok('the same flat weeks on ORDINARY volume are not accumulation',
   len(quiet['accumulation_weeks']) == 0, quiet['accumulation_weeks'])

# PHASE 3 — the handle: a minor controlled drift in the UPPER part of the base.
ok('a shallow late drift is read as a handle', r['handle'] is not None
   and r['handle']['valid'] is True, r['handle'])
ok('...with its own length in weeks and its own depth',
   1 <= r['handle']['weeks'] <= 8 and r['handle']['depth_pct'] <= 15, r['handle'])

# A "handle" that gives back half the cup is the cup FAILING, not a handle.
deep = B.analyse(daily(cup(handle_weeks=5, handle_low=80.0)))
ok('a drift that gives back half the cup is NOT a handle',
   deep['handle'] is None or deep['handle']['valid'] is False, deep['handle'])
ok('...and the reason is visible: it is not in the upper half',
   deep['handle'] is None or deep['handle']['in_upper_half'] is False, deep['handle'])


print()
print('== C. what is NOT a base ==')
# A stock at its highs is not building one, and that is not a fault. Saying
# "no base" as though something were wrong is how a reading becomes noise.
rising = B.analyse(daily([100 + i for i in range(30)]))
ok('a stock making new highs has no base, and it is not an error',
   rising['ok'] is False and 'no base yet' in rising.get('reason', ''), rising)

short = B.analyse(daily([100.0, 99.0, 97.0, 98.0, 99.0]))
ok('too few weeks to read a base says how many there were',
   short['ok'] is False and 'weeks' in short, short)

# 7 weeks is the floor: shorter is a pullback, not a base — the consolidation
# has not lasted long enough to change who owns the stock.
brief = B.analyse(daily([100.0] * 3 + [95.0, 93.0, 96.0, 99.0]))
ok('a four-week dip is not a base',
   brief['ok'] is False or brief['checks']['length_ok'] is False, brief)

crash = B.analyse(daily([100.0] * 3 + [100 - i * 4 for i in range(20)]
                        + [22 + i * 3 for i in range(15)]))
ok('a 75% collapse is too deep to be a base, and the check says so',
   crash['ok'] and crash['checks']['depth_ok'] is False, crash.get('depth_pct'))


print()
print('== D. the pivot ==')
ok("the pivot is ten cents above the handle's high",
   abs(r['pivot'] - (r['handle']['high'] + 0.10)) < 1e-6, (r['pivot'], r['handle']))
ok('...a real ten cents, so a breakout must CLEAR the level, not touch it',
   'PIVOT_OFFSET' in SRC and '0.10' in SRC)
ok('how far price is from the pivot is reported', r['pct_to_pivot'] is not None)
no_handle = B.analyse(daily(cup(handle_weeks=0)))
ok('with no handle the pivot falls back to the left lip',
   no_handle['ok'] and abs(no_handle['pivot'] - (no_handle['left_lip'] + 0.10)) < 1e-6,
   (no_handle['pivot'], no_handle['left_lip']))


print()
print('== E. numbers, not a verdict ==')
# O'Neil's own point about bases is that you LOOK at them. A boolean that hid
# the depth, the length, the accumulation and the handle would be a claim
# nobody could check against a chart.
ok('every check is reported separately, not collapsed into a yes',
   set(r['checks']) == {'length_ok', 'depth_ok', 'depth_typical', 'waves_ok',
                        'accumulation_ok', 'handle_ok'}, list(r['checks']))
ok('...with a score out of the count, so partial is visible as partial',
   0 <= r['score'] <= r['of'] and r['of'] == 6, (r['score'], r['of']))
ok('the summary is the four numbers, not a label',
   'week base' in r['summary'] and 'waves down' in r['summary'], r['summary'])
ok('...and it says when there is no handle rather than implying one',
   'no handle yet' in B.analyse(daily(cup(handle_weeks=0)))['summary'],
   B.analyse(daily(cup(handle_weeks=0)))['summary'])

ok('an empty frame does not raise',
   B.analyse(pd.DataFrame())['ok'] is False)
try:
    B.analyse(pd.DataFrame({'close': [1, 2, 3]}))
    ok('missing OHLC columns raise a NAMED error inside a result', True)
except Exception as e:                                         # noqa: BLE001
    ok('missing OHLC columns raise a NAMED error inside a result', False, e)
ok('...and it names the column', 'column' in
   (B.analyse(pd.DataFrame({'close': [1, 2, 3]})).get('error') or ''),
   B.analyse(pd.DataFrame({'close': [1, 2, 3]})))

# WEEKLY HAS TO SURVIVE THE TRIP TO THE PAGE. A panel that printed "28 weeks"
# from daily bars would be the same words about a different measurement.
UI = (pathlib.Path(__file__).resolve().parents[3] / 'public' / 'index.html').read_text()
ok('the panel labels the base block WEEKLY', 'N — the base (WEEKLY)' in UI)
ok('...and repeats why, under the block',
   'weekly charts' in UI and 'in weeks' in UI)
ok('the route declares the timeframe it returns', "baseTimeframe: 'weekly'" in
   (pathlib.Path(__file__).resolve().parents[3] / 'src' / 'routes' / 'market.js').read_text())
ok('the three phases are all on the page, not just the verdict',
   'waves down' in UI and 'Accumulation weeks' in UI and 'Handle:' in UI)
ok('the pivot and the distance to it are shown',
   'Pivot <b>' in UI and 'pct_to_pivot' in UI)
ok('a handle that is too deep says WHICH test it failed',
   'not in the upper half of the base' in UI)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
