"""Audit part 9 — fill model: 'close' (preview) vs 'next_open' (honest live).
Every expectation hand-computed. Phase 4 step 2."""
import sys, numpy as np, pandas as pd
import pathlib; sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")

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

print("== 1. entry fills at NEXT bar's open ==")
# signal at j=1 (close 100); next bar opens at 100.5 -> entry price 100.5, ei=2
b = bars_from(close=[100, 100, 100.8, 101, 101],
              o    =[100, 100, 100.5, 100.9, 101],
              h    =[100.2, 100.2, 101, 101.2, 101.3],
              l    =[99.9, 99.9, 100.3, 100.7, 100.9])
ent = np.array([False, True, False, False, False])
exi = np.array([False, False, False, True, False])   # exit signal at j=3
tr, _, _, op = S._pair_trades(b, list(range(5)), ent, exi, 'long', {}, None,
                              fill='next_open')
chkv('entry bar = signal+1', tr[0]['ei'] if tr else None, 2)
chkv('entry price = open[2]', round(tr[0]['entry'], 2) if tr else None, 100.5)
print("== 2. exit-rule fills at NEXT bar's open ==")
chkv('exit bar = signal+1', tr[0]['xi'] if tr else None, 4)
chkv('exit price = open[4]', round(tr[0]['exit'], 2) if tr else None, 101.0)
chkv('ret = (101-100.5)/100.5', round(tr[0]['ret'], 5), round(0.5 / 100.5, 5))
# same strategy under close-fill: entry close[1]=100, exit close[3]=101
tr_c, _, _, _ = S._pair_trades(b, list(range(5)), ent, exi, 'long', {}, None,
                               fill='close')
chkv('close-fill differs (entry 100, exit 101)',
     (tr_c[0]['ei'], round(tr_c[0]['entry'], 2), tr_c[0]['xi'], round(tr_c[0]['exit'], 2)),
     (1, 100.0, 3, 101.0))

print("== 3. signal on the LAST bar -> no fill, no trade, no phantom open ==")
b2 = bars_from(close=[100, 100, 100])
tr2, _, _, op2 = S._pair_trades(b2, list(range(3)),
                                np.array([False, False, True]), np.zeros(3, bool),
                                'long', {}, None, fill='next_open')
chkv('no trade and no open position', (len(tr2), op2), (0, None))

print("== 4. SL distance anchors to the OPEN fill price ==")
# signal j=0; fill at open[1]=200. SL 1% => 198. low[2]=197.9 -> SL at 198.
b3 = bars_from(close=[100, 200.4, 199],
               o    =[100, 200.0, 199.5],
               h    =[100.1, 200.6, 199.8],
               l    =[99.9, 199.8, 197.9])
risk = {'sl': {'type': 'pct', 'value': 1}}
tr3, _, _, _ = S._pair_trades(b3, list(range(3)), np.array([True, False, False]),
                              np.zeros(3, bool), 'long', risk, None, fill='next_open')
chkv('SL = 1% below open fill (198)', (tr3[0]['reason'], round(tr3[0]['exit'], 2)) if tr3 else None,
     ('SL', 198.0))

print("== 5. SL live on the ENTRY bar itself (gap after the open) ==")
# fill at open[1]=100; SL 1% = 99; low[1]=98.5 pierces it SAME bar -> SL at bar 1
b4 = bars_from(close=[100, 99.2, 99.2],
               o    =[100, 100.0, 99.2],
               h    =[100.1, 100.2, 99.4],
               l    =[99.9, 98.5, 99.0])
tr4, _, _, _ = S._pair_trades(b4, list(range(3)), np.array([True, False, False]),
                              np.zeros(3, bool), 'long', risk, None, fill='next_open')
chkv('same-bar stop-out after open fill', (tr4[0]['ei'], tr4[0]['xi'], tr4[0]['reason']) if tr4 else None,
     (1, 1, 'SL'))
# contrast: close-fill exempts the entry bar
tr4c, _, _, _ = S._pair_trades(b4, list(range(3)), np.array([True, False, False]),
                               np.zeros(3, bool), 'long', risk, None, fill='close')
chkv('close-fill entry bar exempt (SL waits)', tr4c[0]['xi'] if tr4c else None, 1)

print("== 6. pending market exit beats intrabar SL on the fill bar ==")
# in position from bar1 (open 100). exit signal at bar1 close; bar2 opens 99.6
# and its low ALSO pierces SL 99 — the market order at the open prints first.
b5 = bars_from(close=[100, 99.7, 99.4],
               o    =[100, 100.0, 99.6],
               h    =[100.1, 100.2, 99.7],
               l    =[99.9, 99.5, 98.8])
tr5, _, _, _ = S._pair_trades(b5, list(range(3)), np.array([True, False, False]),
                              np.array([False, True, False]), 'long', risk, None,
                              fill='next_open')
chkv('market exit at open beats SL', (tr5[0]['xi'], tr5[0]['reason'], round(tr5[0]['exit'], 2)) if tr5 else None,
     (2, 'exit', 99.6))

print("== 7. exit signal on the last bar -> position stays open (honest) ==")
b6 = bars_from(close=[100, 100.5, 101], o=[100, 100.2, 100.7])
tr6, _, _, op6 = S._pair_trades(b6, list(range(3)), np.array([True, False, False]),
                                np.array([False, False, True]), 'long', {}, None,
                                fill='next_open')
chkv('no fill bar -> open trade reported', (len(tr6), op6['ei'] if op6 else None), (0, 1))
chkv('open ret from open-fill entry', round(op6['ret'], 5) if op6 else None,
     round((101 - 100.2) / 100.2, 5))

print("== 8. trade-aware exits use the OPEN fill entry ==")
# P&L% <= -1 from entry 100 (open fill): closes 99.4 @bar2 -> -0.6%, 98.9 @bar3 -> -1.1%
# signal at bar3 close, fills open[4]
b7 = bars_from(close=[100, 100, 99.4, 98.9, 98.7],
               o    =[100, 100.0, 99.6, 99.1, 98.8])
xg = {'logic': 'AND', 'rules': [{'left': {'kind': 'trade', 'field': 'pnl_pct'},
                                 'op': 'le', 'right': {'kind': 'const', 'value': -1}}]}
tr7, _, _, _ = S._pair_trades(b7, list(range(5)), np.array([True, False, False, False, False]),
                              None, 'long', {}, None, exit_group=xg, fill='next_open')
chkv('pnl measured from open fill, exit at next open',
     (tr7[0]['ei'], tr7[0]['xi'], round(tr7[0]['exit'], 2)) if tr7 else None, (1, 4, 98.8))

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
