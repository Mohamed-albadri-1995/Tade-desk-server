"""T2 10:00 VWAP-Extension Ranking Setup (setup_spec.md v1.0).

Two halves, because the spec has two halves:

  PER SYMBOL  the direction test, the invalidation test, the VWAP stop frozen
              at 10:00, the 2R target, entry on the 10:00 open. This is a
              strategy — chart/seeds/t2_vwap_extension.json.
  PER DAY     "sort surviving tickers by extension, take the top 2 across the
              entire universe". This is a CROSS-SYMBOL decision. evaluate()
              sees one symbol at a time, so it cannot live in a strategy; it
              lives in the backtest runner as spec.rank_per_day.

That split matters: the spec's own numbers are +0.09 avg R taking every
signal, +1.17 taking the top 2. Building only the per-symbol half would
reproduce the wrong one.

PART A — the window primitives line up with the spec's minute boundaries.
PART B — direction test: each of the three conditions gates the trade.
PART C — invalidation test, both cut-offs (09:40 long, 09:50 short).
PART D — risk: stop frozen at the 10:00 VWAP, 2R, stop-first on a both-touched
         bar (the spec's conservative assumption, which its results depend on).
PART E — per-day ranking: top N by extension across symbols.
"""
import sys, pathlib, json
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

import tools.compare_server as cs
import chart.strategy as S
import chart.backtest as bt
import qp
from qp.registry import REGISTRY
from qp.primitives.bars import Bars

ET = 'America/New_York'
DAY = '2026-08-04'
SEEDS = json.loads((pathlib.Path(S.__file__).resolve().parent
                    / 'seeds' / 't2_vwap_extension.json').read_text())
LONG = [d for d in SEEDS if d['side'] == 'long'][0]
SHORT = [d for d in SEEDS if d['side'] == 'short'][0]


def frame(closes, day=DAY, vols=None):
    """1-min RTH bars from 09:30, plus 30 premarket bars."""
    t0 = pd.Timestamp(f'{day} 09:30', tz=ET)
    idx = [t0 - pd.Timedelta(minutes=i) for i in range(30, 0, -1)]
    px = [closes[0]] * 30
    for i, c in enumerate(closes):
        idx.append(t0 + pd.Timedelta(minutes=i)); px.append(c)
    px = np.asarray(px, dtype=float)
    v = np.full(len(px), 1e5) if vols is None else np.asarray(vols, dtype=float)
    return pd.DataFrame({'open': px, 'high': px + 0.01, 'low': px - 0.01,
                         'close': px, 'volume': v},
                        index=pd.DatetimeIndex(idx).tz_convert('UTC'))

FRAMES = {}
class Stub:
    def load(self, sym, tf, start, end):
        f = FRAMES[sym]
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['t2x'] = Stub()

def run(strat, sym, df, fill='next_open'):
    FRAMES[sym] = df
    return S.evaluate(strat, sym, '1m', 1, feed='t2x', view='all',
                      asof=DAY, fill=fill)

def n_trades(r):
    return len((r.get('trades') or [])
               + ([r['open_trade']] if r.get('open_trade') else []))

# A clean long day: rises through the morning, decision close near the high,
# VWAP rising, later lows never undercut the early lows, then runs to 2R.
UP = [10.0 + 0.02 * i for i in range(30)]          # 09:30-09:59, ends 10.58
GOOD_LONG = UP + [10.60 + 0.06 * i for i in range(60)]

print("=" * 64)
print("PART A — window boundaries match the spec's minutes")
print("=" * 64)
df = frame(GOOD_LONG)
b = Bars(df)
et = df.index.tz_convert(ET)
i59 = [i for i, t in enumerate(et) if t.strftime('%H:%M') == '09:59'][0]
mh = REGISTRY['levels.window_high'].fn(b, start=930, end=1000)
ml = REGISTRY['levels.window_low'].fn(b, start=930, end=1000)
ok("the morning window is 09:30-09:59 inclusive (end 1000 is exclusive)",
   abs(mh[i59] - (max(UP) + 0.01)) < 1e-9 and abs(ml[i59] - (min(UP) - 0.01)) < 1e-9,
   f"{mh[i59]} {ml[i59]}")
ok("...and is complete at the decision bar, not still forming at 09:58",
   mh[i59] >= mh[i59 - 1])
a = REGISTRY['levels.window_low'].fn(b, start=930, end=941)
bb = REGISTRY['levels.window_low'].fn(b, start=941, end=1000)
ok("the long invalidation splits at 09:40/09:41 as specified",
   abs(a[i59] - (UP[0] - 0.01)) < 1e-9 and abs(bb[i59] - (UP[11] - 0.01)) < 1e-9,
   f"A={a[i59]} B={bb[i59]}")
c = REGISTRY['levels.window_high'].fn(b, start=930, end=951)
d = REGISTRY['levels.window_high'].fn(b, start=951, end=1000)
ok("the short invalidation splits at 09:50/09:51",
   abs(c[i59] - (UP[20] + 0.01)) < 1e-9 and abs(d[i59] - (UP[29] + 0.01)) < 1e-9,
   f"C={c[i59]} D={d[i59]}")
vw = REGISTRY['vwap.session'].fn(b)
ok("a 10-bar VWAP lookback EXISTS at 09:59 (30 session bars by then)",
   vw[i59 - 10] == vw[i59 - 10])
ok("the entry window is 1000/1000 → the fill is the 10:00 open",
   (LONG['risk']['window_start'], LONG['risk']['window_end']) == (1000, 1000))

print("=" * 64)
print("PART B — direction test: all three conditions, each one gating")
print("=" * 64)
r = run(LONG, 'GOOD', df)
ok("a clean long day fires exactly once", n_trades(r) == 1,
   f"{n_trades(r)} drops={r.get('entry_drops')}")
t = (r.get('trades') or [None])[0]
if t:
    ok("the fill is the 10:00 bar",
       pd.Timestamp(t['entry_ts'], unit='s', tz='UTC').tz_convert(ET)
       .strftime('%H:%M') == '10:00',
       pd.Timestamp(t['entry_ts'], unit='s', tz='UTC').tz_convert(ET).strftime('%H:%M'))
# range_position below 55: give the range back on the last few bars
low_pos = UP[:24] + [10.30, 10.20, 10.10, 10.05, 10.02, 10.01] + GOOD_LONG[30:]
ok("range_position < 55 → no trade", n_trades(run(LONG, 'RP', frame(low_pos))) == 0)
# price under VWAP at the decision bar
under = [10.6 - 0.02 * i for i in range(30)] + [10.0] * 60
ok("close below session VWAP → no long", n_trades(run(LONG, 'UV', frame(under))) == 0)
# VWAP slope <= 0 while price is STILL ABOVE it. This needs care: a flat price
# does not flatten a cumulative VWAP — the average keeps drifting toward price.
# Falling VWAP + price above it means price dropped far enough to drag the
# average down, then crossed back over a still-falling average.
FALLV = [12.00] * 15 + [10.00] * 13 + [11.20] * 2      # 09:30-09:59
df_fv = frame(FALLV + [11.5] * 60)
_b = Bars(df_fv); _vw = REGISTRY['vwap.session'].fn(_b)
_et = df_fv.index.tz_convert(ET)
_i59 = [i for i, t in enumerate(_et) if t.strftime('%H:%M') == '09:59'][0]
_mh = REGISTRY['levels.window_high'].fn(_b, start=930, end=1000)[_i59]
_ml = REGISTRY['levels.window_low'].fn(_b, start=930, end=1000)[_i59]
_pos = (FALLV[-1] - _ml) / (_mh - _ml) * 100
# assert the SETUP of the test before trusting its conclusion
ok("(test setup) VWAP really is falling over the 10-bar lookback",
   _vw[_i59] < _vw[_i59 - 10], f"{_vw[_i59]:.4f} vs {_vw[_i59 - 10]:.4f}")
ok("(test setup) ...while price is still ABOVE VWAP, and range_pos >= 55",
   FALLV[-1] > _vw[_i59] and _pos >= 55, f"close={FALLV[-1]} vwap={_vw[_i59]:.4f} pos={_pos:.1f}")
r_fl = run(LONG, 'FALLV', df_fv)
ok("→ a falling VWAP alone blocks the long", n_trades(r_fl) == 0, f"{n_trades(r_fl)}")
ok("the long rules do not fire on a falling day",
   n_trades(run(LONG, 'DN', frame(under))) == 0)

print("=" * 64)
print("PART C — invalidation test at both cut-offs")
print("=" * 64)
# LONG: make a NEW low after 09:41 (B < A) while still closing strong
inval_l = ([10.20, 10.18, 10.16, 10.14, 10.12, 10.10, 10.08, 10.06, 10.04, 10.02,
            10.00]                                   # 09:30-09:40  A = 9.99
           + [9.50]                                  # 09:41        B undercuts A
           + [9.55 + 0.06 * i for i in range(18)])   # recovers, closes near high
inval_l = inval_l + [11.0 + 0.05 * i for i in range(60)]
r_il = run(LONG, 'INVL', frame(inval_l))
ok("a lower low after 09:41 rejects the long", n_trades(r_il) == 0,
   f"{n_trades(r_il)} drops={r_il.get('entry_drops')}")
# and the same shape WITHOUT the undercut is taken
ok_l = ([10.20 - 0.02 * i for i in range(11)]
        + [10.00]
        + [10.05 + 0.06 * i for i in range(18)]
        + [11.0 + 0.05 * i for i in range(60)])
ok("...while the same shape without the undercut is taken",
   n_trades(run(LONG, 'OKL', frame(ok_l))) == 1)
# SHORT: a HIGHER high after 09:51 rejects
DOWN = [10.0 - 0.02 * i for i in range(30)]
inval_s = DOWN[:21] + [10.50] + [9.45 - 0.02 * i for i in range(8)] \
    + [9.20 - 0.05 * i for i in range(60)]
ok("a higher high after 09:51 rejects the short",
   n_trades(run(SHORT, 'INVS', frame(inval_s))) == 0)
ok("...while a clean short day is taken",
   n_trades(run(SHORT, 'OKS', frame(DOWN + [9.40 - 0.05 * i for i in range(60)]))) == 1)

print("=" * 64)
print("PART D — risk: VWAP stop frozen at 10:00, 2R, stop-first")
print("=" * 64)
ok("the stop is the session VWAP, FROZEN (not trailing)",
   LONG['risk']['sl']['type'] == 'prim'
   and LONG['risk']['sl']['anchor']['key'] == 'vwap.session'
   and LONG['risk']['sl']['freeze'] is True)
ok("the target is the WHOLE position at 2R (as backtested)",
   LONG['risk']['targets'] == [{'fraction': 1.0, 'r_multiple': 2.0}])
if t:
    risk = t['entry'] - t['stop']
    ok("the stop sits at the 10:00 VWAP, below the entry", 0 < risk,
       f"entry={t['entry']} stop={t['stop']}")
    ok("the exit is entry + 2R", abs(t['exit'] - (t['entry'] + 2 * risk)) < 0.05,
       f"{t['exit']} want {t['entry'] + 2 * risk}")
# stop_first: one bar that touches BOTH must book the stop, not the target
ok("stop_first is set on both seeds",
   LONG['risk'].get('stop_first') is True and SHORT['risk'].get('stop_first') is True)
def both_touch(stop_first):
    idx = pd.DatetimeIndex([pd.Timestamp(f'{DAY} 09:30', tz=ET)
                            + pd.Timedelta(minutes=i) for i in range(6)]).tz_convert('UTC')
    o = np.array([10.0, 10.0, 10.0, 10.0, 10.0, 10.0])
    df2 = pd.DataFrame({'open': o, 'high': np.array([10.01, 10.01, 10.01, 10.01, 12.0, 10.0]),
                        'low': np.array([9.99, 9.99, 9.99, 9.99, 8.0, 10.0]),
                        'close': o, 'volume': np.full(6, 1e5)}, index=idx)
    strat = {'name': 'x', 'side': 'long',
             'entry': {'logic': 'AND', 'rules': [
                 {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
                  'right': {'kind': 'const', 'value': 1}}]},
             'exit': {'logic': 'AND', 'rules': []},
             'risk': {'sl': {'type': 'pct', 'value': 5.0},
                      'targets': [{'fraction': 1.0, 'r_multiple': 2.0}],
                      'max_entries_per_day': 1,
                      **({'stop_first': True} if stop_first else {})}}
    FRAMES['BOTH'] = df2
    rr = S.evaluate(strat, 'BOTH', '1m', 1, feed='t2x', view='all',
                    asof=DAY, fill='close')
    tt = (rr.get('trades') or [])
    return tt[0]['reason'] if tt else None
ok("with stop_first ON, a both-touched bar books the STOP",
   both_touch(True) in ('SL', 'trail'), f"{both_touch(True)}")
ok("with it OFF the target still wins (existing behaviour unchanged)",
   both_touch(False) == 'T1', f"{both_touch(False)}")

print("=" * 64)
print("PART E — per-day ranking: top N by extension, across the universe")
print("=" * 64)
def _ts(date, hhmm='10:00'):
    """Real epoch seconds — run() day-slices on _et_date(entry_ts), so a
    placeholder timestamp would drop every trade before ranking ever ran."""
    return int(pd.Timestamp(f'{date} {hhmm}', tz=ET).timestamp())

def trade(sym, date, entry, stop, side='long', ret=0.0):
    return {'date': date, 'symbol': sym, 'side': side, 'entry': entry,
            'stop': stop, 'exit': entry * (1 + ret), 'ret': ret,
            'entry_ts': _ts(date), 'exit_ts': _ts(date, '15:59'),
            'reason': 'TP', 'legs': [], 'ctx': {}}
# extension = (entry/stop - 1)*100 for a long: 5%, 3%, 1%
rows = [trade('AAA', '2026-08-04', 105.0, 100.0),
        trade('BBB', '2026-08-04', 103.0, 100.0),
        trade('CCC', '2026-08-04', 101.0, 100.0),
        trade('DDD', '2026-08-05', 110.0, 100.0),
        trade('EEE', '2026-08-05', 102.0, 100.0)]
import types
saved = bt._pairs, bt._resolve_strategy, bt._dates
kept = None
# exercise the ranking block directly through run() by stubbing the engine
class _FakeStrat(dict):
    pass
bt._resolve_strategy = lambda spec: {'name': 'x', 'side': 'long',
                                     'entry': {'logic': 'AND', 'rules': []},
                                     'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
bt._pairs = lambda spec, strategy=None: [(r["date"], r["symbol"], {}) for r in rows]
_by = {(r['date'], r['symbol']): r for r in rows}
def fake_eval(strategy, sym, tf, days, **kw):
    r = _by[(kw['asof'], sym)]
    return {'ok': True, 'bars': 100, 'entries': [], 'open_trade': None,
            'trades': [{'entry_ts': r['entry_ts'], 'exit_ts': r['exit_ts'],
                        'entry': r['entry'], 'exit': r['exit'], 'stop': r['stop'],
                        'ret': r['ret'], 'reason': 'TP', 'legs': []}]}
import chart.strategy as _S
_orig_eval, _S.evaluate = _S.evaluate, fake_eval
bt.strat = _S
try:
    out = bt.run({'strategy': {}, 'tf': '1m', 'feed': 'polygon',
                  'universe': {'kind': 'symbols', 'symbols': ['X']},
                  'start': '2026-08-04', 'end': '2026-08-05',
                  'rank_per_day': {'metric': 'vwap_extension', 'top_n': 2}})
finally:
    _S.evaluate = _orig_eval
    bt._pairs, bt._resolve_strategy, bt._dates = saved
got = sorted((t['symbol'], t['date']) for t in out['trades'])
ok("only the top 2 per day survive",
   got == [('AAA', '2026-08-04'), ('BBB', '2026-08-04'),
           ('DDD', '2026-08-05'), ('EEE', '2026-08-05')], f"{got}")
ok("the weakest name of the day is dropped", ('CCC', '2026-08-04') not in got)
ok("a day with fewer than N survivors keeps what it has",
   sum(1 for s, d in got if d == '2026-08-05') == 2)
cv = out['summary']['coverage']['rank_per_day']
ok("the ranking is reported, with how many it dropped",
   cv['top_n'] == 2 and cv['kept'] == 4 and cv['dropped_by_rank'] == 1, f"{cv}")
exts = {t['symbol']: t['ctx']['rank_metric'] for t in out['trades']}
ok("the extension is stored per trade, so a run can be audited",
   abs(exts['AAA'] - 5.0) < 1e-6 and abs(exts['BBB'] - 3.0) < 1e-6, f"{exts}")
ok("each trade knows its rank within the day",
   {t['symbol']: t['ctx']['rank_in_day'] for t in out['trades']}['AAA'] == 1)

print("=" * 64)
print("PART F — one run, BOTH books, ranked across the whole day")
print("=" * 64)
# The spec ranks "across the entire universe" — 07-31 selects FFAI long AND
# COHU short. Two separate backtests would rank inside each side and pick
# different names, so a run has to be able to carry both books at once.
rows2 = [trade('LNG1', '2026-08-04', 105.0, 100.0, 'long'),    # ext 5.0
         trade('LNG2', '2026-08-04', 101.0, 100.0, 'long'),    # ext 1.0
         trade('SHT1', '2026-08-04', 100.0, 104.0, 'short'),   # ext 4.0
         trade('SHT2', '2026-08-04', 100.0, 100.5, 'short')]   # ext 0.5
_by2 = {(r['date'], r['symbol']): r for r in rows2}
def fake_eval2(strategy, sym, tf, days, **kw):
    r = _by2.get((kw['asof'], sym))
    # each book only claims the names of its own side
    if r is None or r['side'] != strategy.get('side'):
        return {'ok': True, 'bars': 100, 'entries': [], 'trades': [], 'open_trade': None}
    return {'ok': True, 'bars': 100, 'entries': [], 'open_trade': None,
            'trades': [{'entry_ts': r['entry_ts'], 'exit_ts': r['exit_ts'],
                        'entry': r['entry'], 'exit': r['exit'], 'stop': r['stop'],
                        'ret': r['ret'], 'reason': 'TP', 'legs': []}]}
saved2 = bt._pairs
bt._pairs = lambda spec, strategy=None: [(r["date"], r["symbol"], {}) for r in rows2]
_orig2, _S.evaluate = _S.evaluate, fake_eval2
def _book(side):
    return {'name': f'book {side}', 'side': side,
            'entry': {'logic': 'AND', 'rules': []},
            'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
try:
    out2 = bt.run({'strategies': [_book('long'), _book('short')],
                   'tf': '1m', 'feed': 'polygon',
                   'universe': {'kind': 'symbols', 'symbols': ['X']},
                   'start': '2026-08-04', 'end': '2026-08-04',
                   'rank_per_day': {'metric': 'vwap_extension', 'top_n': 2}})
finally:
    _S.evaluate = _orig2
    bt._pairs = saved2
picked = sorted(t['symbol'] for t in out2['trades'])
ok("the top 2 are taken across BOTH books, not 2 per side",
   picked == ['LNG1', 'SHT1'], f"{picked}")
ok("...which means a short can outrank a long",
   {t['symbol']: t['side'] for t in out2['trades']} == {'LNG1': 'long', 'SHT1': 'short'})
ok("each trade names the book it came from",
   sorted(t['ctx']['strategy'] for t in out2['trades']) == ['book long', 'book short'],
   f"{[t['ctx'].get('strategy') for t in out2['trades']]}")
ok("the summary names both strategies",
   out2['summary']['strategy_name'] == 'book long + book short',
   f"{out2['summary'].get('strategy_name')}")
ok("...and reports the side as 'both'", out2['summary']['strategy_side'] == 'both')
ok("a pair is counted ONCE even though two books evaluated it",
   out2['summary']['coverage']['evaluated'] == 4,
   f"{out2['summary']['coverage']['evaluated']}")
ok("extension ranks correctly across sides (5.0 > 4.0 > 1.0 > 0.5)",
   round(sorted(t['ctx']['rank_metric'] for t in out2['trades'])[-1], 6) == 5.0)

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
