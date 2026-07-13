"""Audit part 12 — Trade The Pool rules + the ONE-POSITION invariant.
Session rules: RTH-only entries, forced 15:50 EOD liquidation. Fees:
$0.005/share min $0.75/order. Counting: wins < $0.10/share credit 0.
Invariant: while a position is open, NEW entry signals of the same setup are
ignored; only after SL/TP/exit/eod can the next one fire."""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S
import chart.backtest as bt

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")

def bars_at(times_et, close, o=None, h=None, l=None, day='2024-01-09'):
    """bars at explicit ET clock times."""
    idx = pd.DatetimeIndex([pd.Timestamp(f'{day} {t}', tz='America/New_York')
                            for t in times_et]).tz_convert('UTC')
    close = np.array(close, float)
    o = np.array(o, float) if o is not None else close.copy()
    h = np.array(h, float) if h is not None else np.maximum(o, close)
    l = np.array(l, float) if l is not None else np.minimum(o, close)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': close,
                         'volume': np.full(len(close), 1000.0)}, index=idx)

RULES = {'rth_entries': True, 'eod_close': True}

print("== 1. session masks ==")
b = bars_at(['09:00', '09:30', '12:00', '15:45', '15:49', '15:50', '16:30'],
            [100, 100, 100, 100, 100, 100, 100])
eok, eod = S._session_masks(b, RULES)
chkv('entry allowed only 09:30–15:49', list(eok),
     [False, True, True, True, True, False, False])
chkv('eod = last bar before 15:50', list(eod),
     [False, False, False, False, True, False, False])

print("== 2. premarket / after-hours entries blocked; EOD force-close ==")
# entry signal at every bar; no exit rules -> without rules this would enter
# at bar0 (09:00) and stay open; WITH rules it enters 09:30 and eod-closes 15:49
ent = np.ones(7, dtype=bool)
tr, _, _, op = S._pair_trades(b, list(range(7)), ent, np.zeros(7, bool),
                              'long', {}, None, entry_ok=eok, eod_close=eod)
chkv('entered at 09:30 not 09:00', tr[0]['ei'] if tr else None, 1)
chkv('forced flat on the 15:49 bar', (tr[0]['xi'], tr[0]['reason']) if tr else None,
     (4, 'eod'))
chkv('nothing re-opens at/after 15:50', (len(tr), op), (1, None))

print("== 3. next_open fill landing outside the window is dropped ==")
# signal at 15:49 (allowed) but next_open fill = 15:50 bar -> blocked
b3 = bars_at(['15:48', '15:49', '15:50'], [100, 100, 100])
eok3, eod3 = S._session_masks(b3, RULES)
tr3, _, _, op3 = S._pair_trades(b3, list(range(3)),
                                np.array([False, True, False]), np.zeros(3, bool),
                                'long', {}, None, fill='next_open',
                                entry_ok=eok3, eod_close=eod3)
chkv('fill outside session dropped', (len(tr3), op3), (0, None))

print("== 4. ONE-POSITION invariant: repeated signals ignored until exit ==")
# fresh entry EDGES at bars 1,3,5 (signal flickers) but the position from bar1
# only exits via SL at bar 4 -> the bar-3 signal must NOT stack/replace;
# after the SL, the NEXT signal (bar 5) opens trade #2.
b4 = bars_at(['10:00', '10:01', '10:02', '10:03', '10:04', '10:05', '10:06'],
             [100, 100, 100, 100, 100, 100, 100],
             l=[99.9, 99.9, 99.9, 99.9, 98.9, 99.9, 99.9])
ent4 = np.array([False, True, False, True, False, True, False])
risk = {'sl': {'type': 'pct', 'value': 1}}
tr4, _, _, op4 = S._pair_trades(b4, list(range(7)), ent4, np.zeros(7, bool),
                                'long', risk, None)
chkv('signal at bar3 ignored while holding; trade1 = SL @4',
     [(t['ei'], t['xi'], t['reason']) for t in tr4], [(1, 4, 'SL')])
chkv('next signal after the exit opens trade 2', op4['ei'] if op4 else None, 5)

print("== 5. TTP fees + counted-profit (hand-computed) ==")
mk = lambda pps, i: {'date': '2024-01-09', 'symbol': 'X', 'side': 'long',
                     'entry_ts': i * 100, 'exit_ts': i * 100 + 50, 'entry': 20.0,
                     'exit': 20.0 + pps, 'ret': pps / 20.0, 'reason': 'exit'}
# 100 shares, $0.005/sh => $0.50 < $0.75 min -> $0.75/order, $1.50 round trip
# t1: +0.15/sh -> gross $15, net $13.50, COUNTS
# t2: +0.05/sh -> gross $5,  net $3.50,  win below min -> counted 0
# t3: -0.20/sh -> gross -$20, net -$21.50, loss ALWAYS counts
spec = {'shares': 100, 'fee_per_share': 0.005, 'fee_min': 0.75,
        'min_profit_ps': 0.10}
ttp = bt._ttp_block([mk(0.15, 1), mk(0.05, 2), mk(-0.20, 3)], [], spec)
chkv('fees = 3 trades x $1.50', ttp['fees_usd'], 4.5)
chkv('net = 13.50+3.50-21.50', ttp['net_pnl_usd'], -4.5)
chkv('counted = 13.50-21.50 (small win credited 0)', ttp['counted_pnl_usd'], -8.0)
chkv('1 wasted win below $0.10/sh', ttp['wins_below_min'], 1)
# per-share fee above the minimum: 500 shares -> $2.50/order
ttp2 = bt._ttp_block([mk(0.15, 1)], [], {**spec, 'shares': 500})
chkv('per-share fee beats the minimum at 500sh', ttp2['fees_usd'], 5.0)
# open position pays one side only
ttp3 = bt._ttp_block([], [{'entry': 20.0, 'side': 'long'}], spec)
chkv('open trade pays entry side only', ttp3['fees_usd'], 0.75)

print("== 6. rules flow through evaluate + backtest spec ==")
import tools.compare_server as cs
class StubLoader:
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:4000]
        base = np.full(len(idx), 50.0)
        return pd.DataFrame({'open': base, 'high': base + 0.05, 'low': base - 0.05,
                             'close': base + 0.01, 'volume': 1000.0}, index=idx)
cs._LOADERS['stub12'] = StubLoader()
T = lambda: {'kind': 'time', 'field': 'hhmm'}
C = lambda v: {'kind': 'const', 'value': v}
# entry at 08:00 ET (premarket) — with TTP rules this must produce NOTHING
strat_pm = {'name': 'pm', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(800)}]},
            'exit': {'logic': 'AND', 'rules': []}}
r = S.evaluate(strat_pm, 'AAA', '1m', 2, feed='stub12', view='all',
               asof='2024-01-09', rules=RULES)
chkv('premarket strategy: zero trades, zero open', (len(r['trades']), r['open_trade']), (0, None))
# entry at 14:00, no exit -> eod-closed same day, reason eod
strat_day = {'name': 'd', 'side': 'long',
             'entry': {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1400)}]},
             'exit': {'logic': 'AND', 'rules': []}}
out = bt.run({'strategy': strat_day, 'tf': '1m', 'days': 1, 'feed': 'stub12',
              'view': 'all', 'fill': 'close', 'start': '2024-01-09', 'end': '2024-01-09',
              'universe': {'kind': 'symbols', 'symbols': ['AAA']},
              'rules': RULES, 'shares': 100, 'fee_per_share': 0.005,
              'fee_min': 0.75, 'min_profit_ps': 0.10})
chkv('backtest eod exit recorded', out['summary']['exits_by'], {'eod': 1})
chkv('ttp block present in summary', 'ttp' in out['summary'], True)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
