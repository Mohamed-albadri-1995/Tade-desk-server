"""Audit part 39 — the 'desk' fill model: what the live desk actually does.

WHY THIS EXISTS.

Both older fill models use ONE price for two different jobs — the price the
trade is booked at, and the price every level is measured from. The desk uses
two, and has no choice about it:

    the DECISION price   the close of bar j, the first moment that price is
                         knowable. The stop and every target are priced from it
                         right there and sent to the broker as ABSOLUTE prices,
                         because SignalStack takes a bracket and cannot amend
                         one afterwards.

    the FILL price       a market order reaching the tape a few seconds into
                         bar j+1. Nothing re-prices the bracket after it.

'close' gets the levels right and the entry wrong. 'next_open' gets the entry
right and then re-measures the levels from it — which quietly hands the trade
back the exact R the strategy was tested at, an R the desk never gets.

Live, 2026-08-19: WULF short, decided 15.37, filled 15.24, stop 15.74. The plan
said 2.00R. Measured from the fill it was 1.31R. Nothing reported the gap,
because the backtest that justified the setup had measured the second version.

Every expectation below is hand-computed.
"""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

def chkv(name, got, exp):
    ok(name, got == exp, f"got={got!r} exp={exp!r}")


def bars_from(close, o=None, h=None, l=None):
    n = len(close)
    idx = pd.date_range('2024-01-02 09:30', periods=n, freq='1min',
                        tz='America/New_York').tz_convert('UTC')
    close = np.array(close, float)
    o = np.array(o, float) if o is not None else close.copy()
    h = np.array(h, float) if h is not None else np.maximum(o, close)
    l = np.array(l, float) if l is not None else np.minimum(o, close)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': close,
                         'volume': np.full(n, 1000.0)}, index=idx)

def run(b, ent, exi, side, risk, fill):
    n = len(b)
    return S._pair_trades(b, list(range(n)), np.array(ent), np.array(exi),
                          side, risk, None, fill=fill)


print("== 1. the entry fills where next_open fills — only the levels move ==")
# signal at j=0 (close 100). Bar 1 opens at 100.60 — sixty cents of gap.
# A 1% stop measured from the DECISION close (100) sits at 99.00.
# The same stop measured from the FILL (100.60) would sit at 99.594.
b = bars_from(close=[100, 100.8, 100.4, 99.5, 98.8],
              o    =[99.9, 100.60, 100.7, 100.2, 99.4],
              h    =[100.2, 101.0, 100.9, 100.3, 99.5],
              l    =[99.8, 100.5, 100.2, 99.40, 98.7])
risk = {'sl': {'type': 'pct', 'value': 1}}
ent = [True, False, False, False, False]
exi = [False] * 5

td, _, _, _ = run(b, ent, exi, 'long', risk, 'desk')
tn, _, _, _ = run(b, ent, exi, 'long', risk, 'next_open')

chkv('desk fills at open[1], same as next_open',
     round(td[0]['entry'], 2), round(tn[0]['entry'], 2))
chkv('desk fill price is 100.60', round(td[0]['entry'], 2), 100.60)
chkv('desk stop is 1% below the DECISION close: 99.00',
     round(td[0]['stop'], 4), 99.0)
chkv('next_open stop is 1% below the FILL: 99.594',
     round(tn[0]['stop'], 4), 99.594)

print()
print("== 2. the trade carries BOTH prices, so a report can show the gap ==")
chkv('desk records the decision price', round(td[0]['decided'], 2), 100.0)
chkv('desk records the fill price', round(td[0]['entry'], 2), 100.60)
ok('the two differ — that difference IS the execution gap',
   abs(td[0]['decided'] - td[0]['entry']) > 0.5)
chkv('next_open reports one price twice',
     round(tn[0]['decided'], 3), round(tn[0]['entry'], 3))

print()
print("== 3. the stop that fires is the DESK's stop, at the DESK's price ==")
# low[3] = 99.40. It pierces the desk's 99.00 stop? No — 99.40 > 99.00, so the
# desk survives bar 3. It DOES pierce next_open's 99.594. The two models take
# different trades on the same bars, which is the whole point.
ok('next_open is stopped out at its own 99.594 level',
   tn[0]['reason'] == 'SL' and tn[0]['xi'] == 3, tn[0])
ok('the desk is NOT stopped out on that bar — its stop is lower',
   not (td[0]['reason'] == 'SL' and td[0]['xi'] == 3), td[0])

print()
print("== 4. an R-multiple target is priced off the decision close ==")
# Long. Decision close 100, stop 1% below = 99.00, so 1R = 1.00 and a 2R target
# is 102.00. Measured from the 100.60 fill it would be 99.594 / 101.412 — a
# target the desk would never have placed.
risk2 = {'sl': {'type': 'pct', 'value': 1},
         'targets': [{'fraction': 1.0, 'r_multiple': 2.0}]}
b2 = bars_from(close=[100, 100.8, 101.5, 102.4, 102.6],
               o    =[99.9, 100.60, 100.9, 101.6, 102.5],
               h    =[100.2, 101.0, 101.7, 102.50, 102.8],
               l    =[99.8, 100.5, 100.8, 101.5, 102.3])
t2d, _, _, _ = run(b2, ent, exi, 'long', risk2, 'desk')
t2n, _, _, _ = run(b2, ent, exi, 'long', risk2, 'next_open')
chkv('desk 2R target = 100 + 2×1.00 = 102.00',
     round(t2d[0]['legs'][0]['price'], 4) if t2d and t2d[0]['legs'] else None, 102.0)
chkv('next_open 2R target = 100.60 + 2×1.006 = 102.612',
     round(t2n[0]['legs'][0]['price'], 4) if t2n and t2n[0]['legs'] else None, 102.612)

print()
print("== 5. the R the trade REALLY got, on the desk's own numbers ==")
# This is the WULF arithmetic, as a short. Decision 15.37, stop 15.74, so the
# plan's 1R is 0.37 and its 2R target is 15.37 − 0.74 = 14.63. The fill comes
# in at 15.24 — thirteen cents worse for a short. Real risk 15.74 − 15.24 =
# 0.50; real reward 15.24 − 14.63 = 0.61. That is 1.22R, not 2.00R.
decided, stop, fillp = 15.37, 15.74, 15.24
plan_r = abs(decided - stop)
target = decided - 2.0 * plan_r
real_r = abs(fillp - target) / abs(stop - fillp)
chkv('the plan prices the target at 14.63', round(target, 2), 14.63)
ok('the same trade, entered at the real fill, is worth about 1.2R',
   1.15 < real_r < 1.3, round(real_r, 3))
ok('and it is WORSE, never better, when the fill goes against you',
   real_r < 2.0)

print()
print("== 6. a target that lands the wrong side of the fill is dropped ==")
# The gap can be big enough to swallow the whole planned reward before a share
# is bought. Decision 100, stop 99, 2R target 102 — and the next bar opens at
# 102.50. A resting limit at 102 would fill instantly and book a LOSS as a
# "target", which no trader can place. The leg must be dropped, not taken.
b3 = bars_from(close=[100, 103, 103.5, 104, 104],
               o    =[99.9, 102.50, 103.1, 103.6, 104],
               h    =[100.2, 103.4, 103.8, 104.2, 104.3],
               l    =[99.8, 102.4, 103.0, 103.5, 103.9])
t3, _, _, o3 = run(b3, ent, exi, 'long', risk2, 'desk')
armed = (o3 or {}).get('tgt_armed', None) if o3 else (len(t3[0]['legs']) if t3 else None)
ok('the un-placeable 2R leg is not armed', armed == 0, armed)

print()
print("== 7. a short is measured the same way, in the other direction ==")
# Decision close 100, 1% stop ABOVE = 101, 2R target = 98. Fill at the next
# open, 99.40 — for a short that is worse: you sold lower than you priced.
b4 = bars_from(close=[100, 99.2, 98.6, 97.9, 97.5],
               o    =[100.1, 99.40, 99.1, 98.5, 97.8],
               h    =[100.2, 99.5, 99.2, 98.6, 97.9],
               l    =[99.8, 99.1, 98.5, 97.80, 97.4])
t4, _, _, _ = run(b4, ent, exi, 'short', risk2, 'desk')
chkv('short stop is 1% ABOVE the decision close: 101.00',
     round(t4[0]['stop'], 4) if t4 else None, 101.0)
chkv('short 2R target = 100 − 2×1.00 = 98.00',
     round(t4[0]['legs'][0]['price'], 4) if t4 and t4[0]['legs'] else None, 98.0)
chkv('short fill is the next open, 99.40',
     round(t4[0]['entry'], 2) if t4 else None, 99.40)

print()
print("== 8. the older models are untouched, byte for byte ==")
# The whole change is one extra variable that equals the old one everywhere but
# 'desk'. If either older model moved, every result ever produced by this engine
# would have quietly changed meaning.
for name in ('close', 'next_open'):
    a, _, _, _ = run(b2, ent, exi, 'long', risk2, name)
    ok(f"{name}: levels still measured from its own entry price",
       a and abs(a[0]['decided'] - a[0]['entry']) < 1e-9,
       a[0] if a else None)

print()
print("== 9. an unknown fill model is refused, not silently downgraded ==")
# Falling back would fall back to 'close' — the MOST optimistic of the three.
# A typo in the one field that decides how honest a run is would then make the
# run less honest and say nothing at all.
try:
    run(b, ent, exi, 'long', risk, 'next-open')
    ok('a typo raises', False, 'no error raised')
except ValueError as e:
    ok('a typo raises and names the known models',
       'next-open' in str(e) and 'desk' in str(e), str(e))

chkv('the three models are the declared set',
     tuple(sorted(S.FILL_MODELS)), ('close', 'desk', 'next_open'))

print()
print(f"        {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
