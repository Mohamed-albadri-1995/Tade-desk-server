"""Audit part 18 — scale-out (partial exits), step 1: R-multiple legs.
Hand-computed weighted returns. Backward compat: no `targets` ⇒ identical to
the old single-exit math."""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS = 0; FAIL = 0
def chk(name, got, exp, tol=1e-6):
    global PASS, FAIL
    okk = (got == exp) if not isinstance(exp, float) else (got is not None and abs(got - exp) <= tol)
    if okk: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")

def bars(close, o=None, h=None, l=None):
    n = len(close)
    idx = pd.date_range('2024-01-09 10:00', periods=n, freq='1min',
                        tz='America/New_York').tz_convert('UTC')
    close = np.array(close, float)
    o = np.array(o, float) if o is not None else close.copy()
    h = np.array(h, float) if h is not None else np.maximum(o, close)
    l = np.array(l, float) if l is not None else np.minimum(o, close)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': close,
                         'volume': np.full(n, 1e5)}, index=idx)

def entry_at(n, k):
    e = np.zeros(n, bool); e[k] = True; return e

print("== 1. backward compat: no targets == old single-exit ==")
# enter bar1 @100, fixed 2% SL (=98). Price rises to 105 then we exit at close.
b = bars([100, 100, 103, 105], h=[100, 100.5, 103.5, 105.5], l=[99.9, 99.5, 102.5, 104.5])
risk = {'sl': {'type': 'pct', 'value': 2}}
tr, _, _, op = S._pair_trades(b, list(range(4)), entry_at(4, 1), np.zeros(4, bool),
                              'long', risk, None)
chk('no targets → still open, ret = mark-to-market', op['ret'] if op else None,
    (105 - 100) / 100)
chk('no legs key growth', len(tr), 0)

print("== 2. two R-multiple legs bank, runner rides (LONG) ==")
# enter bar1 @100, SL @98 → 1R = 2.00. T1 @102 (1R, 1/3), T2 @104 (2R, 1/3).
# bar2 high 102.x hits T1; bar3 high 104.x hits T2; runner (1/3) open at close 106.
b = bars([100, 100, 102, 104, 106],
         h=[100, 100.2, 102.3, 104.3, 106.0], l=[99.9, 99.8, 101.5, 103.5, 105.5])
risk = {'sl': {'type': 'pct', 'value': 2},
        'targets': [{'fraction': 1/3, 'r_multiple': 1.0},
                    {'fraction': 1/3, 'r_multiple': 2.0}]}
tr, _, _, op = S._pair_trades(b, list(range(5)), entry_at(5, 1), np.zeros(5, bool),
                              'long', risk, None)
# T1 ret = (102-100)/100 = .02 ; T2 ret = (104-100)/100 = .04 ; runner @106 = .06
# weighted open ret = 1/3*.02 + 1/3*.04 + 1/3*.06 = .04
chk('2 legs banked', len(op['legs']) if op else None, 2)
chk('leg1 = T1 @102', (op['legs'][0]['reason'], round(op['legs'][0]['price'], 2)) if op else None,
    ('T1', 102.0))
chk('leg2 = T2 @104', (op['legs'][1]['reason'], round(op['legs'][1]['price'], 2)) if op else None,
    ('T2', 104.0))
chk('weighted open ret = 0.04', round(op['ret'], 6) if op else None, 0.04)

print("== 3. runner stops out after banking a leg ==")
# T1 @102 banked on bar2; then price collapses and the 2/3 runner stops at 98.
b = bars([100, 100, 102, 99, 97],
         h=[100, 100.2, 102.4, 99.5, 97.5], l=[99.9, 99.8, 101.5, 97.5, 96.5])
risk = {'sl': {'type': 'pct', 'value': 2},
        'targets': [{'fraction': 1/3, 'r_multiple': 1.0}]}
tr, _, _, op = S._pair_trades(b, list(range(5)), entry_at(5, 1), np.zeros(5, bool),
                              'long', risk, None)
# banked 1/3 at +2% = +.00667 ; runner 2/3 stops at 98 = -2% → 2/3*-.02 = -.01333
# total = .00667 - .01333 = -.00667
chk('one trade closed', len(tr), 1)
chk('final reason = SL', tr[0]['reason'] if tr else None, 'SL')
chk('weighted total = 1/3*.02 + 2/3*(-.02)', round(tr[0]['ret'], 6) if tr else None,
    round((1/3)*0.02 + (2/3)*(-0.02), 6))
chk('runner exit @98', round(tr[0]['exit'], 2) if tr else None, 98.0)

print("== 4. fractions sum to 1.0 → fully scaled out, no runner ==")
b = bars([100, 100, 102, 104],
         h=[100, 100.2, 102.5, 104.5], l=[99.9, 99.8, 101.5, 103.5])
risk = {'sl': {'type': 'pct', 'value': 2},
        'targets': [{'fraction': 0.5, 'r_multiple': 1.0},
                    {'fraction': 0.5, 'r_multiple': 2.0}]}
tr, _, _, op = S._pair_trades(b, list(range(4)), entry_at(4, 1), np.zeros(4, bool),
                              'long', risk, None)
chk('fully closed (no open runner)', op, None)
chk('final trade = last leg T2', tr[0]['reason'] if tr else None, 'T2')
chk('weighted = 0.5*.02 + 0.5*.04 = .03', round(tr[0]['ret'], 6) if tr else None, 0.03)

print("== 5. no priceable stop → targets disabled (R undefined) ==")
b = bars([100, 100, 102, 104])
risk = {'targets': [{'fraction': 0.5, 'r_multiple': 1.0}]}  # no sl
tr, _, _, op = S._pair_trades(b, list(range(4)), entry_at(4, 1), np.zeros(4, bool),
                              'long', risk, None)
chk('no legs without a stop', len(op['legs']) if op else None, 0)

print("== 6. SHORT mirror: legs below entry ==")
# enter short @100, SL @102 → 1R=2. T1 @98 (1/3), runner rides to close 94.
b = bars([100, 100, 98, 95, 94],
         h=[100.1, 100.2, 98.5, 95.5, 94.5], l=[99.9, 99.8, 97.6, 94.5, 93.5])
risk = {'sl': {'type': 'pct', 'value': 2},
        'targets': [{'fraction': 1/3, 'r_multiple': 1.0}]}
tr, _, _, op = S._pair_trades(b, list(range(5)), entry_at(5, 1), np.zeros(5, bool),
                              'short', risk, None)
chk('short leg1 @98 banked', (op['legs'][0]['reason'], round(op['legs'][0]['price'], 2)) if op else None,
    ('T1', 98.0))
# T1 short ret = (100-98)/100 = .02 ; runner @94 = (100-94)/100 = .06
chk('short weighted open = 1/3*.02 + 2/3*.06', round(op['ret'], 6) if op else None,
    round((1/3)*0.02 + (2/3)*0.06, 6))

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
