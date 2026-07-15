"""Audit part 19 — entry DISCIPLINE (S1): per-strategy attempts cap, cooldown,
min-hold. Hand-computed. Backward compatible: absent knobs = today's behavior."""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS = 0; FAIL = 0
def chk(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")

def bars(close, o=None, h=None, l=None, day='2024-01-09', start='09:30'):
    n = len(close)
    idx = pd.DatetimeIndex([pd.Timestamp(f'{day} {start}', tz='America/New_York')
                            + pd.Timedelta(minutes=i) for i in range(n)]).tz_convert('UTC')
    close = np.array(close, float)
    o = np.array(o, float) if o is not None else close.copy()
    h = np.array(h, float) if h is not None else np.maximum(o, close)
    l = np.array(l, float) if l is not None else np.minimum(o, close)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': close,
                         'volume': np.full(n, 1e5)}, index=idx)

# a falling knife: entry EDGE every other bar, 1% SL → each entry stops out.
b = bars([100, 100, 99, 99, 98, 98, 97, 97, 96, 96],
         l=[99.9, 98.9, 98.9, 97.9, 97.9, 96.9, 96.9, 95.9, 95.9, 94.9])
ent = np.array([False, True, False, True, False, True, False, True, False, True])
risk = {'sl': {'type': 'pct', 'value': 1}}
def run(**kw):
    tr, _, _, op = S._pair_trades(b, list(range(10)), ent, np.zeros(10, bool),
                                  'long', risk, None, **kw)
    return [t['ei'] for t in tr] + ([op['ei']] if op else [])

print("== 1. baseline: no discipline → every edge enters (SL each) ==")
chk('uncapped enters on all 5 edges', run(), [1, 3, 5, 7, 9])

print("== 2. max_per_day caps attempts ==")
chk('cap 2 → first two only', run(max_per_day=2), [1, 3])
chk('cap 1 → one and done', run(max_per_day=1), [1])

print("== 3. cooldown blocks re-entry for N bars after an exit ==")
# each trade: enter bar k, SL next bar (k+1). cooldown 3 → after exit at k+1,
# no entry until k+1+3. So entries at 1(exit2), next allowed >=5 → 5(exit6),
# next >=9 → 9. = [1,5,9].
chk('cooldown 3 spaces entries', run(cooldown_bars=3), [1, 5, 9])
chk('cooldown 0 = no effect', run(cooldown_bars=0), [1, 3, 5, 7, 9])

print("== 4. min_hold defers the EXIT RULE, not SL ==")
# flat price, entry bar1; exit rule TRUE from bar2 on; SL far away.
b2 = bars([100, 100, 100, 100, 100, 100], h=[100.1]*6, l=[99.9]*6)
e2 = np.array([False, True, False, False, False, False])
ex2 = np.array([False, False, True, True, True, True])   # exit rule true bar2+
r2 = {'sl': {'type': 'pct', 'value': 50}}                # SL never hits
def run2(**kw):
    tr, _, _, op = S._pair_trades(b2, list(range(6)), e2, ex2, 'long', r2, None, **kw)
    return [(t['ei'], t['xi'], t['reason']) for t in tr]
chk('no min-hold: exit rule fires at bar2', run2(), [(1, 2, 'exit')])
chk('min_hold 3: exit rule deferred to bar4 (ei+3)', run2(min_hold_bars=3),
    [(1, 4, 'exit')])

print("== 5. discipline threads through evaluate() from strategy.risk ==")
import tools.compare_server as cs
class Stub:
    def load(self, sym, tf, start, end):
        idx = pd.DatetimeIndex([pd.Timestamp('2024-01-09 09:30', tz='America/New_York')
                                + pd.Timedelta(minutes=i) for i in range(12)]).tz_convert('UTC')
        c = np.array([100, 100, 99, 99, 98, 98, 97, 97, 96, 96, 95, 95], float)
        return pd.DataFrame({'open': c, 'high': c + 0.05,
                             'low': c - 1.2, 'close': c, 'volume': 1e5}, index=idx)  # deep lows → SL
cs._LOADERS['disc'] = Stub()
strat = {'name': 'd', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': [{'left': {'kind': 'price', 'field': 'close'},
                    'op': 'lt', 'right': {'kind': 'price', 'field': 'open', 'offset': 1}}]},
         'exit': {'logic': 'AND', 'rules': []},
         'risk': {'sl': {'type': 'pct', 'value': 1}, 'max_entries_per_day': 2}}
r = S.evaluate(strat, 'X', '1m', 1, feed='disc', view='all', asof='2024-01-09', fill='close')
nent = len(r['trades']) + (1 if r['open_trade'] else 0)
chk('strategy.risk.max_entries_per_day caps evaluate() to 2', nent, 2)
# panel rule overrides the strategy value
r1 = S.evaluate(strat, 'X', '1m', 1, feed='disc', view='all', asof='2024-01-09',
                fill='close', rules={'max_entries_per_day': 1})
chk('panel rule overrides strategy cap → 1',
    len(r1['trades']) + (1 if r1['open_trade'] else 0), 1)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
