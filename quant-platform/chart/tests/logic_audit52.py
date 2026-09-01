"""Audit part 52 — demand, the RS line, and divergence (workshop section 3).

WHY THIS EXISTS.

The workshop's third section is the sharpest thing in CAN SLIM and this system
did not have it:

    "While the broad market index breaks down to new lows during a panic, the
     target stock fails to make a new low and instead reverses upward."

    "The stock's Relative Strength line begins making higher highs and enters
     new high ground BEFORE the stock price itself breaks out."

THE WORD "BEFORE" IS THE WHOLE SIGNAL, and it is the thing an implementation
loses first. An RS line at a new high on the same day price makes one is
arithmetic — price rose, the index did not, the ratio rose — and says nothing
the price chart did not. An RS line at a new high while price is still inside
its base is a different claim entirely. Part C exists to make sure the code
can tell those apart, because a version that cannot would still look right.

PART A — U/D volume ratio: a plain 50-day count, and what it does with nothing.
PART B — Accumulation/Distribution: bounded, windowed, and NOT Chaikin.
PART C — the RS line at new high ground BEFORE price.
PART D — divergence, and its precondition.
PART E — it never raises, and every absence says which absence it is.
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


from chart import ratings                                        # noqa: E402


def frame(rows, start='2024-01-02'):
    """rows = (open, high, low, close, volume) or (close, volume)."""
    idx = pd.bdate_range(start, periods=len(rows), tz='UTC')
    out = []
    for r in rows:
        if len(r) == 2:
            c, v = r
            out.append({'open': c, 'high': c * 1.01, 'low': c * 0.99,
                        'close': c, 'volume': v})
        else:
            o, h, l, c, v = r
            out.append({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v})
    return pd.DataFrame(out, index=idx)


print('== A. U/D volume ratio — a plain 50-day count ==')
# Up days carrying twice the volume of down days is the shape of institutional
# accumulation in the only place it is visible.
rows, p = [(100.0, 1_000_000)], 100.0
for i in range(60):
    up = i % 2 == 0
    p = p * 1.01 if up else p * 0.99
    rows.append((p, 2_000_000 if up else 1_000_000))
r = ratings.up_down_volume_ratio(frame(rows))
ok('twice the volume on up days reads as about 2.0',
   r['ratio'] and 1.8 <= r['ratio'] <= 2.2, r['ratio'])
ok('...and the window it was measured over travels with it',
   '50' in str(r.get('window')), r.get('window'))

rows2, p = [(100.0, 1_000_000)], 100.0
for i in range(60):
    up = i % 2 == 0
    p = p * 1.01 if up else p * 0.99
    rows2.append((p, 1_000_000 if up else 2_000_000))
ok('the same shape inverted reads as about 0.5',
   0.4 <= ratings.up_down_volume_ratio(frame(rows2))['ratio'] <= 0.6)

# UNCHANGED DAYS BELONG TO NEITHER SIDE. In the denominator a quiet stock
# looks distributed; in the numerator, the reverse. They are not evidence.
flat = [(100.0, 9_000_000)] * 30 + [(101.0, 1_000_000), (100.0, 1_000_000)]
rf = ratings.up_down_volume_ratio(frame(flat))
ok('unchanged sessions are counted as neither up nor down',
   rf['flat_days'] >= 29 and rf['ratio'] == 1.0, rf)

# An infinity on a card is a bug people report. The honest reading of "no down
# volume at all" is that there is nothing to divide by.
allup = [(100.0 * (1.01 ** i), 1_000_000) for i in range(30)]
ru = ratings.up_down_volume_ratio(frame(allup))
ok('no down-day volume gives no ratio, and says why',
   ru['ratio'] is None and 'nothing to divide by' in ru['note'], ru)


print()
print('== B. Accumulation/Distribution — bounded, windowed, NOT Chaikin ==')
# Every session closing on its high: the top of the scale.
strong = [(100, 101, 99, 100.9, 1_000_000)] * 70
rs = ratings.acc_dis(frame(strong))
ok('closing on the high every day scores near +1', rs['raw'] > 0.7, rs['raw'])
ok('...and grades A', rs['letter'] == 'A', rs['letter'])

weak = [(100, 101, 99, 99.1, 1_000_000)] * 70
rw = ratings.acc_dis(frame(weak))
ok('closing on the low every day scores near -1', rw['raw'] < -0.7, rw['raw'])
ok('...and grades E', rw['letter'] == 'E', rw['letter'])

mid = [(100, 101, 99, 100.0, 1_000_000)] * 70
ok('closing mid-range grades C', ratings.acc_dis(frame(mid))['letter'] == 'C')

# BOUNDED IS THE DIFFERENCE FROM CHAIKIN, and it is what makes two stocks
# comparable at all. Chaikin's line is cumulative and unbounded: ten times the
# volume would give ten times the number for the same behaviour.
heavy = [(100, 101, 99, 100.9, 50_000_000)] * 70
ok('ten times the volume, same behaviour, same score — because it is '
   'normalised by the volume in the window',
   abs(ratings.acc_dis(frame(heavy))['raw'] - rs['raw']) < 0.01,
   (ratings.acc_dis(frame(heavy))['raw'], rs['raw']))
ok('...and it can never leave -1..+1',
   -1 <= rs['raw'] <= 1 and -1 <= rw['raw'] <= 1)

# WINDOWED, not cumulative: 13 weeks. Two years of distribution followed by 13
# weeks of accumulation is an accumulation reading — that is the point of a
# window, and Chaikin's cumulative line would still be deep negative.
mixed = [(100, 101, 99, 99.1, 1_000_000)] * 400 + [(100, 101, 99, 100.9, 1_000_000)] * 70
ok('a year of distribution before 13 good weeks does not drag the reading down',
   ratings.acc_dis(frame(mixed))['raw'] > 0.7,
   ratings.acc_dis(frame(mixed))['raw'])

# The trap travels WITH the number so it reaches the page, not a document.
ok('the Chaikin confusion is carried with the rating itself',
   'Chaikin' in ratings.acc_dis(frame(strong))['not'])
ok('...and the letter says it is ours, not IBD\'s',
   'not IBD' in ratings.acc_dis(frame(strong))['note'])
ok('the raw number rides beside the letter, so the banding is checkable',
   'raw' in rs and rs['raw'] is not None)

# A zero-range session has no "where the close sat" to read. Counting it as
# neutral would be a claim; it is an absence.
halted = [(100, 100, 100, 100, 1_000_000)] * 20 + [(100, 101, 99, 100.9, 1_000_000)] * 50
ok('a zero-range session is dropped, not scored as neutral',
   ratings.acc_dis(frame(halted))['sessions'] <= 50,
   ratings.acc_dis(frame(halted))['sessions'])


print()
print('== C. the RS line at new high ground BEFORE price ==')
# THE CASE THE WHOLE FEATURE EXISTS FOR. The index falls hard; the stock is
# flat. Price is nowhere near its own high, but stock/index is at its highest
# ever — somebody is buying this while the market is not, and it is legible
# BEFORE the breakout.
n = 260
idx_rows, ip = [], 100.0
for i in range(n):
    ip = ip * (1.004 if i < 160 else 0.994)      # up, then a hard decline
    idx_rows.append((ip, 1_000_000))
stk_rows, sp = [], 100.0
for i in range(n):
    # Up with it, then a SHALLOW pullback — down 14% while the index is down
    # 45%. Price is well off its own high (so the breakout has not happened
    # yet) while stock/index is at its highest ever. That asymmetry is the
    # entire signal, and a stock that merely went FLAT would sit AT its high
    # and prove nothing — which is what the first version of this fixture did.
    sp = sp * (1.004 if i < 160 else 0.9985)
    stk_rows.append((sp, 1_000_000))
stock, index = frame(stk_rows), frame(idx_rows)
t = ratings.rs_line_tell(stock, index)
ok('a flat stock in a falling market puts the RS line at a new high',
   t['rs_line_at_high'] is True, t)
ok('...while price is NOT at a new high', t['price_at_high'] is False, t)
ok('...so the tell fires', t['tell'] is True, t)
ok('...and it says how far price still has to travel',
   t['price_off_high_pct'] < 0, t['price_off_high_pct'])
ok('the LEAD is reported in sessions — the line got there first',
   t['lead_sessions'] is not None and t['lead_sessions'] > 0, t['lead_sessions'])

# AND THE CASE THAT MUST NOT FIRE. Both at new highs together is arithmetic:
# price rose and the index did not, so the ratio rose. It says nothing the
# price chart did not already say, and a version that cannot tell these apart
# would still look right on the first case.
up_rows = [(100.0 * (1.004 ** i), 1_000_000) for i in range(n)]
flat_idx = [(100.0, 1_000_000) for _ in range(n)]
t2 = ratings.rs_line_tell(frame(up_rows), frame(flat_idx))
ok('a stock at its own new high does NOT fire the tell, however strong',
   t2['rs_line_at_high'] is True and t2['price_at_high'] is True
   and t2['tell'] is False, t2)

# A stock falling faster than the index: the line is at a LOW, not a high.
down_rows = [(100.0 * (0.99 ** i), 1_000_000) for i in range(n)]
t3 = ratings.rs_line_tell(frame(down_rows), frame(flat_idx))
ok('a laggard fires nothing', t3['tell'] is False and t3['rs_line_at_high'] is False)

# The line is stock/index and nothing else. Two frames that share no dates
# produce no line rather than a wrong one.
other = frame(up_rows, start='2010-01-04')
ok('frames with no shared dates give no line, not a misaligned one',
   len(ratings.rs_line(frame(up_rows), other)) == 0)
ok('...and the tell says it could not be measured',
   ratings.rs_line_tell(frame(up_rows), other).get('note') is not None)


print()
print('== D. divergence, and its precondition ==')
# All three facts, and all three must be there: the index broke to a new low,
# the stock did not, and the stock is above where it sat at the index's bottom.
n = 200
idx_rows, ip = [], 100.0
for i in range(n):
    ip = ip * (0.997 if i < 180 else 1.002)     # long decline, then a bounce
    idx_rows.append((ip, 1_000_000))
stk_rows, sp = [], 100.0
for i in range(n):
    sp = sp * (0.9995 if i < 120 else 1.003)    # held its floor, then rose
    stk_rows.append((sp, 1_000_000))
dv = ratings.divergence(frame(stk_rows), frame(idx_rows))
ok('the index made a new low in the window', dv['index_new_low'] is True, dv)
ok('...the stock did not', dv['stock_new_low'] is False, dv)
ok('...and it is above where it sat at the index bottom', dv['reversed_up'] is True)
ok('so it is diverging', dv['diverging'] is True, dv)
ok('the index low DATE comes back, so it is checkable on a chart',
   dv['index_low_date'], dv)

# WITHOUT THE PANIC THIS MEASURES NOTHING. A stock not making a new low during
# a calm month is not diverging from anything — it is simply a stock. This is
# the assertion that stops the field firing on every quiet name on the page.
calm_idx = [(100.0 * (1.001 ** i), 1_000_000) for i in range(n)]
dv2 = ratings.divergence(frame(stk_rows), frame(calm_idx))
ok('no new low in the index means no divergence, whatever the stock did',
   dv2['diverging'] is False and dv2['index_new_low'] is False, dv2)
ok('...and it says the difference: nothing to diverge FROM is not a failure',
   'nothing to diverge' in (dv2['note'] or ''), dv2['note'])

# A stock that broke down WITH the market is following it, not diverging.
falling = [(100.0 * (0.995 ** i), 1_000_000) for i in range(n)]
dv3 = ratings.divergence(frame(falling), frame(idx_rows))
ok('a stock making its own new low is following the market, not diverging',
   dv3['diverging'] is False and dv3['stock_new_low'] is True, dv3)

# CLOSES, not intraday lows — the same reason the follow-through anchor is a
# close. A spike through a level the session closed back above is not a break.
SRC = (pathlib.Path(__file__).resolve().parents[1] / 'ratings.py').read_text()
ok('divergence is measured on closing prices, and says so',
   'Closing prices throughout' in SRC)


print()
print('== E. every absence says which absence it is ==')
short = frame([(100.0, 1_000_000)] * 5)
ok('too few sessions gives no U/D ratio, with a reason',
   ratings.up_down_volume_ratio(short)['ratio'] is None
   and ratings.up_down_volume_ratio(short)['note'])
ok('...no A/D grade either', ratings.acc_dis(short)['letter'] is None)
ok('...and no RS tell', ratings.rs_line_tell(short, short)['tell'] is False)
ok('...and no divergence', ratings.divergence(short, short)['diverging'] is False)

try:
    ratings.up_down_volume_ratio(pd.DataFrame({'close': [1, 2, 3]}))
    ok('missing OHLC columns raise a NAMED error', False)
except ValueError as e:
    ok('missing OHLC columns raise a NAMED error', 'column' in str(e), e)

# One pass for one stock, which is what the endpoint calls.
both = ratings.stock_ratings(frame(stk_rows), frame(idx_rows))
ok('stock_ratings returns every measure in one pass',
   set(both) == {'ud', 'ad', 'rs_line', 'divergence'}, list(both))
ok('...and works with no index, minus the two that need one',
   set(ratings.stock_ratings(frame(stk_rows))) == {'ud', 'ad'})

# THE PAGE SAYS THE SAME THINGS THE MODULE DOES. A card that printed "RS line
# at a new high" without the BEFORE distinction would be the exact failure this
# audit exists to prevent, and the module being right would not stop it.
UI = (pathlib.Path(__file__).resolve().parents[3] / 'public' / 'index.html').read_text()
ok('the card shows the tell as "new high BEFORE price"',
   'NEW HIGH BEFORE PRICE' in UI)
ok('...and says explicitly when both are high, so it is not read as the tell',
   'the line is not leading' in UI)
ok('the card distinguishes "nothing to diverge from" from a failure',
   'nothing to diverge from' in UI)
ok('the A/D definition carries the Chaikin trap onto the page',
   'Chaikin' in UI)
ok('...and says the letter is ours, not IBD\'s',
   'IBD percentile-ranks its rating' in UI)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
