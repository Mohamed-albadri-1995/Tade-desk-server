"""Audit part 16 — preview WINDOW honesty (the phantom signal ladder).
required_days() extends the fetch for indicator warm-up (ma.ema len 3000 on
1m: 2 requested days -> 13 fetched). The chart only displays the requested
window; anything returned on warm-up bars gets snapped by the chart library
onto the nearest bar it has -> a stacked ladder of arrows at one spot.
evaluate() and test_condition() must slice every output (markers, entries,
trades, series, bar count, fire-rate %) to the REQUESTED window while the
warm-up bars keep feeding indicator values and position state."""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.strategy as S

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")


class StubLoader:
    """24/7 flat 1m bars over exactly the requested [start, end]."""
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:25000]
        n = len(idx)
        return pd.DataFrame({'open': np.full(n, 50.0), 'high': np.full(n, 50.06),
                             'low': np.full(n, 49.99), 'close': np.full(n, 50.01),
                             'volume': np.full(n, 1000.0)}, index=idx)


cs._LOADERS['stub16'] = StubLoader()
T = lambda: {'kind': 'time', 'field': 'hhmm'}
C = lambda v: {'kind': 'const', 'value': v}
EMA = {'kind': 'primitive', 'key': 'ma.ema', 'source': 'close',
       'params': {'length': 3000}}   # forces required_days: 2 -> 13
ENTRY = {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1400)},
                                   {'left': EMA, 'op': 'gt', 'right': C(0)}]}
WSTART = int(pd.Timestamp('2024-01-08 00:00', tz='America/New_York').timestamp())

print("== A. no exit: warm-up entry stays state, never a drawn ladder ==")
rA = S.evaluate({'name': 'a', 'side': 'long', 'entry': ENTRY,
                 'exit': {'logic': 'AND', 'rules': []}},
                'AAA', '1m', 2, feed='stub16', view='all', asof='2024-01-09')
chkv('bar count = the requested 2 days only', rA['bars'], 2880)
chkv('2 visible signals (Jan 8 + Jan 9), warm-up ones sliced',
     len(rA['entries']), 2)
chkv('every marker inside the window',
     all(m['time'] >= WSTART for m in rA['markers']), True)
chkv('no closed trades in window', len(rA['trades']), 0)
chkv('the pre-window position is still reported open',
     rA['open_trade'] is not None, True)
shapes = sorted(m['shape'] for m in rA['markers'])
chkv('2 grey dots, NO entry arrow for the pre-window position',
     shapes, ['circle', 'circle'])
chkv('window first bar stamped right', rA['first'], '2024-01-08 00:00 ET')

print("== B. daily exit: visible trades only, all inside the window ==")
rB = S.evaluate({'name': 'b', 'side': 'long', 'entry': ENTRY,
                 'exit': {'logic': 'AND',
                          'rules': [{'left': T(), 'op': 'eq', 'right': C(1410)}]}},
                'AAA', '1m', 2, feed='stub16', view='all', asof='2024-01-09')
chkv('exactly the 2 in-window trades survive (warm-up ~10 sliced)',
     len(rB['trades']), 2)
chkv('every trade entered inside the window',
     all(t['entry_ts'] >= WSTART for t in rB['trades']), True)
chkv('every marker inside the window',
     all(m['time'] >= WSTART for m in rB['markers']), True)
arrows = [m for m in rB['markers'] if m['shape'] == 'arrowUp']
chkv('2 solid entry arrows', len(arrows), 2)
chkv('every series point inside the window',
     all(v['time'] >= WSTART for s in rB['series'] for v in s['values']), True)
chkv('stats describe the visible trades', rB['stats']['trades'], 2)

print("== C. test_condition: fire-rate % on visible bars only ==")
rC = S.test_condition({'left': EMA, 'op': 'gt', 'right': C(0)},
                      'AAA', '1m', 2, feed='stub16', view='all',
                      asof='2024-01-09')
chkv('bars = requested window', rC['bars'], 2880)
chkv('pct = 100 in-window (would be ~70 with warm-up NaNs counted)',
     rC['pct'], 100.0)
chkv('every dot inside the window',
     all(m['time'] >= WSTART for m in rC['markers']), True)
chkv('every series point inside the window',
     all(v['time'] >= WSTART for s in rC['series'] for v in s['values']), True)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
