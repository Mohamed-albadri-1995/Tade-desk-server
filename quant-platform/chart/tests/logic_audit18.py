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

print("== 6b. over-banking guard: fractions summing >1 clamp to 100% ==")
# legs 0.7 + 0.7 = 1.4 → the 2nd is clamped to the remaining 0.3.
b = bars([100, 100, 102, 104],
         h=[100, 100.2, 102.5, 104.5], l=[99.9, 99.8, 101.5, 103.5])
risk = {'sl': {'type': 'pct', 'value': 2},
        'targets': [{'fraction': 0.7, 'r_multiple': 1.0},
                    {'fraction': 0.7, 'r_multiple': 2.0}]}
tr, _, _, op = S._pair_trades(b, list(range(4)), entry_at(4, 1), np.zeros(4, bool),
                              'long', risk, None)
chk('2nd leg clamped to 0.3 (total = 1.0)',
    round(sum(g['fraction'] for g in tr[0]['legs']), 6) if tr else None, 1.0)
chk('weighted = 0.7*.02 + 0.3*.04', round(tr[0]['ret'], 6) if tr else None,
    round(0.7 * 0.02 + 0.3 * 0.04, 6))

print("== 7. STEP 2 — fixed pct-distance leg (no R needed) ==")
# take 1/2 at +3% from entry (=103), runner rides to close 106. No SL at all.
b = bars([100, 100, 103, 106], h=[100, 100.2, 103.2, 106.0], l=[99.9, 99.8, 102.5, 105.5])
risk = {'targets': [{'fraction': 0.5, 'tp': {'type': 'pct', 'value': 3}}]}
tr, _, _, op = S._pair_trades(b, list(range(4)), entry_at(4, 1), np.zeros(4, bool),
                              'long', risk, None)
chk('pct leg banked @103', (op['legs'][0]['reason'], round(op['legs'][0]['price'], 2)) if op else None,
    ('T1', 103.0))
chk('weighted open = 0.5*.03 + 0.5*.06', round(op['ret'], 6) if op else None,
    round(0.5 * 0.03 + 0.5 * 0.06, 6))

print("== 8. STEP 2 — points-distance leg ==")
b = bars([100, 100, 100.5, 101], h=[100, 100.1, 100.6, 101.1], l=[99.9, 99.9, 100.2, 100.7])
risk = {'targets': [{'fraction': 0.5, 'tp': {'type': 'points', 'value': 0.5}}]}
tr, _, _, op = S._pair_trades(b, list(range(4)), entry_at(4, 1), np.zeros(4, bool),
                              'long', risk, None)
chk('points leg banked @100.5', round(op['legs'][0]['price'], 2) if (op and op['legs']) else None, 100.5)

print("== 9. STEP 2 — prim-anchored leg trails per bar ==")
# take 1/2 when price reaches the session VWAP (a rising line). Needs a feed;
# use the module's overlay path via a tiny stub.
import tools.compare_server as cs
class Stub:
    # a proper ET-RTH day so vwap.session computes: price dips then recovers,
    # so a long entered near the dip can take 1/2 when price rises back to VWAP.
    def load(self, sym, tf, start, end):
        n = 30
        idx = pd.DatetimeIndex([pd.Timestamp('2024-01-09 09:30', tz='America/New_York')
                                + pd.Timedelta(minutes=i) for i in range(n)]).tz_convert('UTC')
        base = np.array([103, 102, 101, 100, 99, 99, 100, 101, 102, 103] + [104] * 20, float)
        return pd.DataFrame({'open': base, 'high': base + 0.1, 'low': base - 0.1,
                             'close': base, 'volume': 1000.0}, index=idx)
cs._LOADERS['so'] = Stub()
strat = {'name': 's', 'side': 'long',
         # enter NEAR THE DIP (close < 100 → bar 4 @99) so the VWAP line sits
         # ABOVE the entry. The old always-true entry opened bar 0 @103 and the
         # leg "banked" at ~101 — BELOW entry — which the wrong-side guard now
         # correctly refuses (a profit target under the fill is a phantom).
         'entry': {'logic': 'AND', 'rules': [{'left': {'kind': 'price', 'field': 'close'},
                                              'op': 'lt', 'right': {'kind': 'const', 'value': 100}}]},
         'exit': {'logic': 'AND', 'rules': []},
         'risk': {'sl': {'type': 'pct', 'value': 5},
                  'targets': [{'fraction': 0.5, 'tp': {'type': 'prim',
                               'anchor': {'kind': 'primitive', 'key': 'vwap.session'}, 'value': 0}}]}}
r = S.evaluate(strat, 'X', '1m', 1, feed='so', view='all', asof='2024-01-09', fill='close')
tr9 = (r.get('trades') or []) + ([r['open_trade']] if r.get('open_trade') else [])
chk('prim-anchored leg evaluates without error', r.get('ok'), True)
chk('a position opened', bool(tr9), True)
chk('trade carries legs list (surfaced by evaluate)', bool(tr9) and ('legs' in tr9[0]), True)
chk('the prim-anchored leg actually banked', bool(tr9) and len(tr9[0]['legs']) == 1, True)

print("== 10. STEP 3 — legs surface as chart markers + backtest counts them ==")
# reuse the case-9 recover-to-VWAP strat; a banked leg must show a teal T-marker.
mk = r.get('markers') or []
tmarks = [m for m in mk if str(m.get('text', '')).startswith('T')]
chk('a scale-out leg marker (T1 …%) is drawn', len(tmarks) >= 1, True)
chk('leg marker is the teal partial colour', tmarks[0]['color'] if tmarks else None, '#14b8a6')
# run a tiny backtest and confirm the summary counts the partials
import chart.backtest as bt
out = bt.run({'strategy': strat, 'tf': '1m', 'days': 1, 'feed': 'so', 'view': 'all',
              'fill': 'close', 'start': '2024-01-09', 'end': '2024-01-09',
              'universe': {'kind': 'symbols', 'symbols': ['X']}})
covv = out['summary'].get('coverage') or {}
chk('backtest summary counts scale-out legs', (covv.get('scaleout_legs') or 0) >= 1, True)

print("== 11. STRADDLE bar — the bracket bug: target AND stop hit same bar ==")
# entry @100, 1% stop (=99), one 1/3 leg at 1R (=101). A later bar's range
# trades THROUGH both: high 101.5 (limit @101 fills), low 98.5 (stop @99 hits).
# A live bracket rests the 1/3 limit and the stop on separate lots → BOTH fill:
# bank 1/3 @ +1%, stop 2/3 @ -1% = -1/3%. (Old engine stopped 100% and threw
# the partial away, understating every scale-out that pulled back to its stop.)
bstr = bars([100, 100, 100, 100, 100],
            h=[100.1, 100.1, 101.5, 100.1, 100.1],
            l=[99.9, 99.9, 98.5, 99.9, 99.9])
rstr = {'sl': {'type': 'pct', 'value': 1}, 'targets': [{'fraction': 1/3, 'r_multiple': 1.0}]}
trs, _, _, _ = S._pair_trades(bstr, list(range(5)), entry_at(5, 1), np.zeros(5, bool),
                              'long', rstr, None)
chk('straddle: one closed trade', len(trs), 1)
chk('straddle: banked the 1/3 partial (a T1 leg exists)',
    len(trs[0]['legs']) if trs else 0, 1)
chk('straddle: weighted ret = 1/3(+1%) + 2/3(-1%) = -1/3%',
    trs[0]['ret'] if trs else None, (1/3)*0.01 + (2/3)*(-0.01))
# a GENUINE gap: the bar OPENS below the stop → the stop is the first print,
# the whole lot is gone before price could reach the target → no partial.
bgap = bars([100, 100, 100, 100, 100],
            o=[100, 100, 98.7, 100, 100],
            h=[100.1, 100.1, 101.5, 100.1, 100.1],
            l=[99.9, 99.9, 98.5, 99.9, 99.9])
trg, _, _, _ = S._pair_trades(bgap, list(range(5)), entry_at(5, 1), np.zeros(5, bool),
                              'long', rstr, None)
chk('gap-through-stop: NO partial banked', len(trg[0]['legs']) if trg else None, 0)
# fills at the GAP OPEN (98.7), not the stop level (99) — real gap slippage
chk('gap-through-stop: full stop at the open = -1.3%',
    trg[0]['ret'] if trg else None, (98.7 - 100) / 100)
# SHORT mirror of the straddle: entry @100, stop @101, 1/3 leg at 1R (=99).
bsh = bars([100, 100, 100, 100, 100],
           h=[100.1, 100.1, 101.5, 100.1, 100.1],
           l=[99.9, 99.9, 98.5, 99.9, 99.9])
trsh, _, _, _ = S._pair_trades(bsh, list(range(5)), entry_at(5, 1), np.zeros(5, bool),
                               'short', rstr, None)
chk('short straddle: banked the 1/3 partial', len(trsh[0]['legs']) if trsh else 0, 1)
chk('short straddle: weighted ret = 1/3(+1%) + 2/3(-1%) = -1/3%',
    trsh[0]['ret'] if trsh else None, (1/3)*0.01 + (2/3)*(-0.01))

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
