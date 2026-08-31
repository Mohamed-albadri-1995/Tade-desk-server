"""Audit part 40 — Relative Strength, as O'Neil defines it.

THE MISTAKE THIS EXISTS TO PREVENT.

"Relative strength" means two different things and the framework only works
with one of them. RSI measures a stock against its OWN recent range and is
bounded 0..100. O'Neil's RS Rating measures a stock against EVERY OTHER STOCK
and is a percentile 1..99. Two names can both print RSI 70 while one is the
strongest stock in the market and the other is a laggard bouncing inside a
downtrend. An implementation that quietly used the first would produce a
plausible column of numbers that answered a question nobody asked.

So what is pinned here is not "does it compute" — it is that the number means
"beat N% of the market", and keeps meaning that under the conditions that
usually break it.

PART A — the weighted formula, against hand arithmetic.
PART B — the most recent quarter really does count double.
PART C — a percentile, not a scaled score: one parabolic name must not
         compress everyone else.
PART D — splits. Adjusted prices are not optional in a performance measure.
PART E — an incomplete history is NaN, never a partial score.
PART F — the tradeable gate: sub-$5 and illiquid names leave the universe.
PART G — group strength ranks on the MEDIAN, so one runaway name cannot
         carry a group of laggards.
"""
import sys
import pathlib

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import chart.relstrength as R                                  # noqa: E402

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


def chkv(name, got, exp):
    ok(name, got == exp, f'got={got!r} exp={exp!r}')


def frame(series: dict, n: int = R._YEAR + 1) -> pd.DataFrame:
    """A wide close frame: {symbol: [oldest..newest]} of length n."""
    idx = pd.bdate_range('2025-01-01', periods=n).strftime('%Y-%m-%d')
    return pd.DataFrame(series, index=idx)


def flat_then(sym_paths: dict, n: int = R._YEAR + 1) -> pd.DataFrame:
    """Every symbol starts at 100 and ends where the caller says, moving only
    on the quarter boundaries the formula actually reads. Everything between is
    irrelevant to the score and is left flat so the arithmetic stays checkable
    by hand."""
    out = {}
    for sym, quarters in sym_paths.items():
        # quarters = (p252, p189, p126, p63, p0) — oldest first
        col = np.empty(n, dtype=float)
        p252, p189, p126, p63, p0 = quarters
        col[:] = p252
        col[n - 1 - 3 * R._Q:] = p189
        col[n - 1 - 2 * R._Q:] = p126
        col[n - 1 - 1 * R._Q:] = p63
        col[n - 1] = p0
        out[sym] = col
    return frame(out, n)


print('== A. the weighted formula, against hand arithmetic ==')
# One symbol, every quarter boundary at 100 and today at 110.
# RS = .4(110/100) + .2(110/100) + .2(110/100) + .2(110/100) = 1.10
px = flat_then({'AAA': (100, 100, 100, 100, 110)})
raw = R.raw_scores(px)
ok('flat history, +10% today -> 1.10', abs(raw['AAA'] - 1.10) < 1e-9, raw['AAA'])

# A real four-quarter path. P0=120, P63=110, P126=105, P189=102, P252=100.
#   .4(120/110) + .2(120/105) + .2(120/102) + .2(120/100)
#   = .4(1.090909) + .2(1.142857) + .2(1.176471) + .2(1.2)
#   = .4363636 + .2285714 + .2352941 + .24 = 1.1402292
px = flat_then({'BBB': (100, 102, 105, 110, 120)})
raw = R.raw_scores(px)
ok('four-quarter path matches hand arithmetic',
   abs(raw['BBB'] - 1.1402292) < 1e-6, raw['BBB'])

chkv('the four weights sum to exactly 1', sum(w for _, w in R.WEIGHTS), 1.0)


print()
print('== B. the most recent quarter counts double ==')
# Same total 12-month gain, delivered in different quarters. The one whose gain
# landed in the LAST quarter must score higher — that is the whole point of the
# weighting, and a naive 12-month return would rate them identically.
px = flat_then({
    'LATE':  (100, 100, 100, 100, 120),   # all of it in the last quarter
    'EARLY': (100, 120, 120, 120, 120),   # all of it a year ago, flat since
})
raw = R.raw_scores(px)
ok('same 12-month gain, recent mover scores higher',
   raw['LATE'] > raw['EARLY'], (raw['LATE'], raw['EARLY']))
# LATE  = .4(1.2) + .2(1.2) + .2(1.2) + .2(1.2) = 1.20
# EARLY = .4(1.0) + .2(1.0) + .2(1.0) + .2(1.2) = 1.04
ok('and by the amount the weights say', abs(raw['LATE'] - 1.20) < 1e-9
   and abs(raw['EARLY'] - 1.04) < 1e-9, (raw['LATE'], raw['EARLY']))


print()
print('== C. a PERCENTILE, not a scaled score ==')
# Nine ordinary names and one that went up 50x. Under min-max scaling the nine
# would all collapse into the bottom of the range and every one of them would
# rate near 1. A percentile is indifferent to how far the outlier ran.
paths = {f'S{i}': (100, 100, 100, 100, 100 + i) for i in range(9)}
paths['MOON'] = (100, 100, 100, 100, 5000)
px = flat_then(paths)
raw = R.raw_scores(px)
rated = raw.dropna()
pct = rated.rank(pct=True, method='average')
scaled = (1 + (pct * 98).round()).clip(1, 99).astype(int)
ok('the outlier takes the top rating', scaled['MOON'] == 99, scaled['MOON'])
ok('the ordinary names still spread across the scale, not squashed at 1',
   scaled.drop('MOON').max() >= 80 and scaled.drop('MOON').min() <= 20,
   sorted(scaled.drop('MOON').tolist()))
ok('the weakest name is the weakest rating',
   scaled.idxmin() == 'S0', scaled.idxmin())

# Ties must share a rating. Two identical stocks that got different numbers
# would mean the ordering carried information the prices do not.
px = flat_then({'T1': (100, 100, 100, 100, 110),
                'T2': (100, 100, 100, 100, 110),
                'LO': (100, 100, 100, 100, 90)})
raw = R.raw_scores(px).dropna()
pct = raw.rank(pct=True, method='average')
sc = (1 + (pct * 98).round()).clip(1, 99).astype(int)
chkv('identical performance -> identical rating', sc['T1'], sc['T2'])


print()
print('== D. splits — adjusted prices are not optional ==')
# THE FAULT: a 2-for-1 split halves the raw close. On RAW prices this stock
# reads -50% over the year and rates 1 — and the names that split are exactly
# the ones that led. The module fetches adjusted=true for this reason; here the
# arithmetic that depends on it is pinned.
unsplit = flat_then({'SPLIT': (100, 110, 120, 130, 140)})     # adjusted view
rawsplit = flat_then({'SPLIT': (100, 110, 120, 130, 70)})     # raw view, post 2:1
a = R.raw_scores(unsplit)['SPLIT']
b = R.raw_scores(rawsplit)['SPLIT']
ok('adjusted view scores it a winner', a > 1.0, a)
ok('raw view would score the SAME stock a loser', b < 1.0, b)
ok('the two disagree by more than a decile of performance', (a - b) > 0.4, (a, b))
chkv('the fetcher asks for adjusted prices',
     'adjusted=true' in open(pathlib.Path(__file__).resolve().parents[1]
                             / 'relstrength.py').read(), True)


print()
print('== E. an incomplete history is NaN, never a partial score ==')
# An eight-month-old IPO up 300% must not outrank a year-old leader on a
# measure defined as twelve months long.
px = flat_then({'OLD': (100, 100, 100, 100, 110),
                'IPO': (100, 100, 100, 100, 400)})
px.loc[px.index[:150], 'IPO'] = np.nan          # no history before ~8 months
raw = R.raw_scores(px)
ok('the IPO is unrateable, not merely low', pd.isna(raw['IPO']), raw['IPO'])
ok('the established name is unaffected', abs(raw['OLD'] - 1.10) < 1e-9, raw['OLD'])

# Too little history for ANYONE is an error, not an empty answer: a silent
# empty series reads as "no strong stocks today".
short = frame({'AAA': [100.0] * 50}, n=50)
try:
    R.raw_scores(short)
    ok('a too-short frame raises', False, 'no error raised')
except ValueError as e:
    ok('a too-short frame raises and says how much it needed',
       str(R._YEAR + 1) in str(e), str(e))


print()
print('== F. the tradeable gate ==')
px = flat_then({'GOOD': (100, 100, 100, 100, 110),
                'PENNY': (2.0, 2.0, 2.0, 2.0, 3.0),      # under $5
                'THIN': (100, 100, 100, 100, 110)})      # priced fine, no volume
dv = px.copy()
dv[:] = 50_000_000.0
dv['THIN'] = 10_000.0                                    # far under the floor
raw = R.raw_scores(px, dv)
ok('a $3 stock leaves the universe', pd.isna(raw['PENNY']), raw['PENNY'])
ok('an illiquid stock leaves the universe', pd.isna(raw['THIN']), raw['THIN'])
ok('a real stock stays', not pd.isna(raw['GOOD']), raw['GOOD'])
# Without the gate the penny stock's +50% would have been the top rating in
# this universe — which is exactly how a percentile gets ruined.
raw_nogate = R.raw_scores(px)
ok('and without the gate it WOULD have outranked the real one',
   raw_nogate['PENNY'] > raw_nogate['GOOD'], (raw_nogate['PENNY'], raw_nogate['GOOD']))


print()
print('== G. group strength ranks on the median ==')
# BROAD: four solidly strong names, median 86.5, every one of them over 80.
# NARROW: two 99s and two laggards — median 55.5, breadth 0.5. NARROW holds the
# two best stocks in the universe and must still rank second, because the
# question the funnel asks is whether the GROUP is rising, not whether it
# contains a winner.
rs = pd.Series({
    'B1': 82, 'B2': 85, 'B3': 88, 'B4': 90,          # BROAD  — median 86.5
    'N1': 99, 'N2': 99, 'N3': 10, 'N4': 12,          # NARROW — median 55.5
})
groups = {'B1': 'BROAD', 'B2': 'BROAD', 'B3': 'BROAD', 'B4': 'BROAD',
          'N1': 'NARROW', 'N2': 'NARROW', 'N3': 'NARROW', 'N4': 'NARROW'}
g = R.group_strength(rs, groups).set_index('group')
chkv('the broadly strong group ranks first', int(g.loc['BROAD', 'group_rank']), 1)
ok('even though the other group holds the two best stocks',
   g.loc['NARROW', 'top_rs'] > g.loc['BROAD', 'top_rs'],
   (g.loc['NARROW', 'top_rs'], g.loc['BROAD', 'top_rs']))
ok('breadth is reported, not just the middle',
   abs(g.loc['BROAD', 'share_over_80'] - 1.0) < 1e-9
   and abs(g.loc['NARROW', 'share_over_80'] - 0.5) < 1e-9,
   (g.loc['BROAD', 'share_over_80'], g.loc['NARROW', 'share_over_80']))

# A symbol with no rating must not be counted as a member — an unrateable
# stock is not a weak one, and counting it would understate a real group.
g2 = R.group_strength(pd.Series({'B1': 75, 'B2': np.nan}),
                      {'B1': 'BROAD', 'B2': 'BROAD'}).set_index('group')
chkv('unrated members are not counted', int(g2.loc['BROAD', 'members']), 1)
chkv('no groups at all is an empty frame, not an error',
     len(R.group_strength(pd.Series(dtype=float), {})), 0)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
