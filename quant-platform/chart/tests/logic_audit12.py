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

print("== 4b. MAX ENTRIES PER DAY (2 strikes and out) ==")
# a falling knife: enters, stops out, re-enters, stops out, would enter a 3rd
# time — with max_per_day=2 the 3rd (and 4th) attempts are BLOCKED.
bk = bars_at(['10:00','10:01','10:02','10:03','10:04','10:05','10:06','10:07'],
             [100, 100, 98, 98, 96, 96, 94, 94],
             l=[99.9, 98.5, 97.9, 96.5, 95.9, 94.5, 93.9, 93.5])
entk = np.array([False, True, False, True, False, True, False, True])
riskk = {'sl': {'type': 'pct', 'value': 1}}
trU, _, _, opU = S._pair_trades(bk, list(range(8)), entk, np.zeros(8, bool),
                                'long', riskk, None)
chkv('uncapped: re-enters the knife 4 times',
     len(trU) + (1 if opU else 0), 4)
trC, _, _, opC = S._pair_trades(bk, list(range(8)), entk, np.zeros(8, bool),
                                'long', riskk, None, max_per_day=2)
chkv('capped at 2: only 2 attempts that day',
     len(trC) + (1 if opC else 0), 2)
chkv('both capped trades are the FIRST two entries',
     [t['ei'] for t in trC], [1, 3])

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
ttp3 = bt._ttp_block([], [{'entry': 20.0, 'side': 'long', 'legs': []}], spec)
chkv('open trade pays entry side only', ttp3['fees_usd'], 0.75)

print("== 5b. TTP treats a SCALE-OUT as ONE trade (blended average) ==")
# entry 20; T1 banks 1/2 at +0.30/sh, runner 1/2 exits at +0.04/sh.
# The $0.10 rule tests the AVERAGE: (0.5*0.30 + 0.5*0.04) = +0.17/sh → CLEARS
# the min, so the WHOLE trade counts (even though the runner slice alone was
# below). Commissions are still per order: 1 entry + 2 exits = 3 × $0.75.
sc = {'date': '2024-01-09', 'symbol': 'X', 'side': 'long', 'entry': 20.0,
      'exit': 20.04, 'ret': 0.0085, 'reason': 'exit',
      'legs': [{'fraction': 0.5, 'price': 20.30}]}
t = bt._ttp_block([sc], [], spec)
chkv('3 orders of fees (1 entry + 2 exits)', t['fees_usd'], 2.25)
chkv('net = 100*0.17 gross - 2.25 fees', t['net_pnl_usd'], round(17 - 2.25, 2))
chkv('counted = net (blended 0.17/sh clears the min)', t['counted_pnl_usd'],
     round(17 - 2.25, 2))
chkv('NOT a wasted win — the trade average cleared $0.10', t['wins_below_min'], 0)
# a scale-out whose BLENDED average is below $0.10 IS wasted as one trade:
# T1 1/2 @ +0.06, runner 1/2 @ +0.02 → avg 0.04 < 0.10 → wasted, counted 0.
sc2 = {'side': 'long', 'entry': 20.0, 'exit': 20.02, 'ret': 0.002, 'reason': 'exit',
       'legs': [{'fraction': 0.5, 'price': 20.06}]}
t2 = bt._ttp_block([sc2], [], spec)
chkv('blended-below-min scale-out is ONE wasted win', t2['wins_below_min'], 1)
chkv('wasted → counted 0', t2['counted_pnl_usd'], 0.0)
# more legs ⇒ more orders. 300sh: entry order = 0.005*300 = $1.50 (beats min);
# each 100-share exit = $0.75 min. So 1.50 + 3×0.75 = $3.75 (vs $2.25 for a
# single exit) — scale-out genuinely costs more commission.
sc3 = {'side': 'long', 'entry': 20.0, 'exit': 20.5, 'ret': 0.02, 'reason': 'exit',
       'legs': [{'fraction': 1/3, 'price': 20.2}, {'fraction': 1/3, 'price': 20.4}]}
t3 = bt._ttp_block([sc3], [], {**spec, 'shares': 300})
chkv('3-exit trade: entry(full) + 3 exits = 1.50 + 3×0.75', t3['fees_usd'], 3.75)
single = bt._ttp_block([{'side': 'long', 'entry': 20.0, 'exit': 20.5,
                         'ret': 0.025, 'reason': 'exit', 'legs': []}], [], {**spec, 'shares': 300})
chkv('same size single-exit pays less (entry + 1 exit)', single['fees_usd'], 3.0)

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

print("== 7. corners: next_open x eod interplay ==")
# exit signal fires ON the eod bar (next_open): the eod close must take it —
# nothing may fill on the next day's open.
b7 = bars_at(['15:47', '15:48', '15:49', '15:50'], [100, 100, 100, 100],
             o=[100, 100, 100, 99])
eok7, eod7 = S._session_masks(b7, RULES)
tr7, _, _, op7 = S._pair_trades(b7, list(range(4)), np.array([True, False, False, False]),
                                np.array([False, False, True, False]), 'long', {}, None,
                                fill='next_open', entry_ok=eok7, eod_close=eod7)
chkv('eod supersedes a same-bar exit signal', [(t['xi'], t['reason']) for t in tr7],
     [(2, 'eod')])
chkv('nothing open after eod', op7, None)
# entry signal one bar BEFORE eod with next_open: fill bar IS the eod bar -> blocked
tr8, _, _, op8 = S._pair_trades(b7, list(range(4)), np.array([False, True, False, False]),
                                np.zeros(4, bool), 'long', {}, None,
                                fill='next_open', entry_ok=eok7, eod_close=eod7)
chkv('fill landing on the liquidation bar is blocked', (len(tr8), op8), (0, None))

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
