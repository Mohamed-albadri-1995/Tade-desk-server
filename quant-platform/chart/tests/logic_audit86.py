"""The live decision is not slowed by reading bar times one at a time.

2026-09-24, OR + VWAP 09:35: sixteen cards took 9 seconds to decide, and the
orders went out from 09:35:09 — the later the order, the further the price
from the one decided on (MAZE was refused at 09:35:20). Profiled: 83% of the
time for one symbol was pandas boxing a Timestamp for every `et[i]` in the
session VWAP and the opening-range levels — 41,000 calls per symbol. Reading
the times in one pass instead made one symbol 5x faster (478 → 96 ms here).

This file checks, by running them:

  1. evaluating the real 09:35 strategy on one symbol does not index the
     DatetimeIndex bar by bar any more (a count, not a clock, so a slow
     machine cannot fail it and a fast one cannot hide it);
  2. the numbers did not move: session VWAP and the opening-range high/low
     against an independent pandas groupby, over days that cross a DST change.

Before the change, check 1 fails (41,450 lookups).
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

HERE = pathlib.Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
import chart.strategy as S                                          # noqa: E402
import tools.compare_server as cs                                   # noqa: E402
from qp.primitives.bars import Bars                                 # noqa: E402
from qp.primitives import vwap as V, levels as LV                   # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}   {extra}')


ET = 'America/New_York'


def frame(start, end, seed=1):
    idx = pd.date_range(start, end, freq='1min', tz=ET)
    idx = idx[(idx.hour >= 4) & (idx.hour < 20) & (idx.dayofweek < 5)]
    n = len(idx)
    rng = np.random.default_rng(seed)
    c = 20 * np.cumprod(1 + rng.normal(0, 0.002, n))
    o = np.r_[c[0], c[:-1]]
    return pd.DataFrame({'open': o, 'high': np.maximum(o, c) * 1.001,
                         'low': np.minimum(o, c) * 0.999, 'close': c,
                         'volume': rng.integers(10_000, 100_000, n).astype(float)},
                        index=idx.tz_convert('UTC'))


print('== 1. one symbol, the real 09:35 strategy: no per-bar index lookups ==')
SEED = json.loads((HERE.parents[1] / 'seeds' / 'or_vwap.json').read_text())
SEED = SEED if isinstance(SEED, list) else SEED.get('strategies', [SEED])
STRATS = [s for s in SEED if 'OR + VWAP 09:35' in s.get('name', '')]
ok('both sides of OR + VWAP 09:35 are in the seed', len(STRATS) == 2, len(STRATS))

# what the desk evaluates at 09:35: yesterday's whole day and today to 09:34
live = pd.concat([frame('2026-09-23 04:00', '2026-09-23 19:59'),
                  frame('2026-09-24 04:00', '2026-09-24 09:34', seed=2)])
ts = [int(x.value // 10**9) for x in live.index]
cs.prepare_bars = lambda *a, **k: (live, ts, {'end': live.index[-1]})

calls = {'n': 0}
_orig = pd.DatetimeIndex.__getitem__


def _count(self, key):
    if isinstance(key, (int, np.integer)):
        calls['n'] += 1
    return _orig(self, key)


pd.DatetimeIndex.__getitem__ = _count
try:
    for s in STRATS:
        r = S.evaluate(s, 'X', '1m', 2, feed='yahoo', view='all',
                       asof='2026-09-24', fill='desk')
        ok(f'{s["side"]} evaluates', r.get('ok'), r.get('error'))
finally:
    pd.DatetimeIndex.__getitem__ = _orig
# 1,295 bars; it was 41,450 before. A few per bar are left elsewhere.
ok(f'bar-by-bar DatetimeIndex lookups per symbol: {calls["n"]} (was 41,450)',
   calls['n'] < 5_000, calls['n'])

print('== 2. same numbers, checked against pandas groupby, across a DST change ==')
df = frame('2026-03-05', '2026-03-11')          # clocks change 2026-03-08
et = df.index.tz_convert(ET)
day = et.date
mins = et.hour * 60 + et.minute
b = Bars.from_frame(df)

rth = (mins >= 570) & (mins < 960)
pv = ((df['high'] + df['low'] + df['close']) / 3 * df['volume']).where(rth)
vv = df['volume'].where(rth)
ref = (pv.groupby(day).cumsum() / vv.groupby(day).cumsum()).where(rth).to_numpy()
got = V.session(b)
ok('session VWAP equals the groupby VWAP on every bar',
   np.allclose(got, ref, equal_nan=True, rtol=0, atol=1e-9),
   np.nanmax(np.abs(got - ref)))

inwin = (mins >= 570) & (mins < 575)            # 09:30–09:35, the 09:35 range
for which, col, agg in (('high', 'high', 'cummax'), ('low', 'low', 'cummin')):
    s = df[col].where(inwin)
    ref = getattr(s.groupby(day), agg)().groupby(day).ffill().to_numpy()
    got = (LV.window_high if which == 'high' else LV.window_low)(b, 930, 935)
    ok(f'opening-range {which} 09:30–09:35 equals the groupby, frozen after',
       np.array_equal(got, ref, equal_nan=True))

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
