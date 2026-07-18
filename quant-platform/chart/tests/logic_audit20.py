"""SCALPS_SPEC engine gaps: cross-symbol (market) operands + today_vol_max.

1. levels.today_vol_max — running RTH max single-bar volume, resets each day
   (hand-computed expectations).
2. Cross-symbol operand: "symbol":"MKT…" computes on the reference symbol's
   bars from the same feed and causally aligns onto the traded timeline —
   the SPY market gate of SCALPS_SPEC. Rising market passes, falling blocks.
3. No look-ahead: destination bars BEFORE the reference's first bar see NaN
   (rule False), and offsets apply on the REFERENCE timeline.
"""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.strategy as S

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

def _idx(n, day='2024-01-09', start='09:30'):
    return pd.DatetimeIndex(
        [pd.Timestamp(f'{day} {start}', tz='America/New_York') + pd.Timedelta(minutes=i)
         for i in range(n)]).tz_convert('UTC')

def frame(cl, vol=None, day='2024-01-09', start='09:30'):
    cl = np.array(cl, float); n = len(cl)
    vol = np.array(vol, float) if vol is not None else np.full(n, 1e5)
    return pd.DataFrame({'open': np.r_[cl[0], cl[:-1]], 'high': cl + 0.05,
                         'low': cl - 0.05, 'close': cl, 'volume': vol},
                        index=_idx(n, day, start))

print("=" * 64)
print("PART A — levels.today_vol_max (running day max, resets next day)")
print("=" * 64)
d1 = frame([50, 50.1, 50.2, 50.1, 50.3, 50.2], vol=[5, 3, 8, 2, 9, 4])
d2 = frame([51, 51.1, 51.2], vol=[3, 7, 1], day='2024-01-10')
two = pd.concat([d1, d2])
_, _, lines = cs.overlay_arrays(two, {'key': 'levels.today_vol_max',
                                      'source': 'close', 'params': {}}, {}, causal=True)
vm = lines[0][1]
ok("day 1 running max = [5,5,8,8,9,9]",
   np.allclose(vm[:6], [5, 5, 8, 8, 9, 9]), f"got={vm[:6]}")
ok("day 2 RESETS: [3,7,7] (yesterday's 9 does not leak)",
   np.allclose(vm[6:], [3, 7, 7]), f"got={vm[6:]}")

print("=" * 64)
print("PART B — cross-symbol market gate through evaluate()")
print("=" * 64)
SCEN = {
    'XX':     frame([50.0, 50.1, 50.2, 50.1, 50.2, 50.3, 50.2, 50.3]),
    'MKTUP':  frame([400, 401, 402, 403, 404, 405, 406, 407]),
    'MKTDN':  frame([400, 399, 398, 397, 396, 395, 394, 393]),
    'MKTLATE': frame([500, 501, 502, 503, 504, 505], start='09:32'),
}
class StubLoader:
    def load(self, symbol, tf, start, end):
        if tf == '1d':
            idx = pd.date_range(end - pd.Timedelta(days=120), end, freq='1D', tz='UTC')
            base = np.full(len(idx), 50.0)
            return pd.DataFrame({'open': base, 'high': base + .6, 'low': base - .6,
                                 'close': base, 'volume': 1e7}, index=idx)
        f = SCEN.get(symbol)
        if f is None:
            return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'],
                                index=pd.DatetimeIndex([], tz='UTC'))
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['xsym'] = StubLoader()

def strat(mkt):
    return {'name': 't', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [
                {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
                 'right': {'kind': 'const', 'value': 0}},
                # MARKET GATE: reference close above its own close 3 bars ago
                {'left': {'kind': 'price', 'field': 'close', 'symbol': mkt},
                 'op': 'gt',
                 'right': {'kind': 'price', 'field': 'close', 'offset': 3, 'symbol': mkt}},
            ]},
            'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}

def run(s):
    return S.evaluate(s, 'XX', '1m', 1, feed='xsym', view='all',
                      asof='2024-01-09', fill='close')

r_up = run(strat('MKTUP'))
r_dn = run(strat('MKTDN'))
ok("rising market: gate PASSES (entries > 0)",
   r_up.get('ok') and len(r_up.get('entries') or []) >= 1,
   f"err={r_up.get('error')} entries={r_up.get('entries')}")
ok("falling market: gate BLOCKS (0 entries)",
   r_dn.get('ok') and len(r_dn.get('entries') or []) == 0,
   f"entries={r_dn.get('entries')}")
ok("referenced_symbols() finds the gate's symbol",
   S.referenced_symbols(strat('MKTUP')) == ['MKTUP'])

print("=" * 64)
print("PART C — causal alignment: no look-ahead before the ref exists")
print("=" * 64)
late = {'name': 'l', 'side': 'long',
        'entry': {'logic': 'AND', 'rules': [
            {'left': {'kind': 'price', 'field': 'close', 'symbol': 'MKTLATE'},
             'op': 'gt', 'right': {'kind': 'const', 'value': 0}}]},
        'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
rl = run(late)
ents = sorted(e['time'] for e in (rl.get('entries') or []))
first_ref_ts = int(SCEN['MKTLATE'].index[0].timestamp())
ok("bars BEFORE the reference's first bar are gated OFF (NaN → False)",
   bool(ents) and ents[0] >= first_ref_ts, f"entries={ents} ref0={first_ref_ts}")
mkt_missing = {'name': 'm', 'side': 'long',
               'entry': {'logic': 'AND', 'rules': [
                   {'left': {'kind': 'price', 'field': 'close', 'symbol': 'NOPE'},
                    'op': 'gt', 'right': {'kind': 'const', 'value': 0}}]},
               'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
rm = run(mkt_missing)
ok("unfetchable reference symbol fails SAFE: ok run, 0 entries (gate blocks)",
   rm.get('ok') and len(rm.get('entries') or []) == 0,
   f"err={rm.get('error')} entries={rm.get('entries')}")

print("=" * 64)
print("PART D — review fixes: symbol'd RISK anchors + honest chart lines")
print("=" * 64)
# a stop ANCHORED to a reference symbol's line must be discovered (preloaded)
# and priced — before the fix it raised inside _anchor_levels, was swallowed,
# and the trade ran with NO stop at all.
anchored = {'name': 'a', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [
                {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
                 'right': {'kind': 'const', 'value': 0}}]},
            'exit': {'logic': 'AND', 'rules': []},
            'risk': {'sl': {'type': 'prim', 'value': 0.5,
                            'anchor': {'kind': 'primitive', 'key': 'ma.ema',
                                       'params': {'length': 3}, 'symbol': 'MKTUP'}}}}
ok("referenced_symbols() walks risk anchors",
   S.referenced_symbols(anchored) == ['MKTUP'], S.referenced_symbols(anchored))
ra = run(anchored)
ok("symbol-anchored SL is PRICED (an 'SL level' series exists — not silently dropped)",
   ra.get('ok') and any(s.get('name') == 'SL level' for s in ra.get('series') or []),
   f"err={ra.get('error')} series={[s.get('name') for s in ra.get('series') or []]}")
# cross-symbol primitives must NOT be drawn from the traded symbol's bars —
# the line would silently show the wrong symbol's data.
gate_prim = {'name': 'g', 'side': 'long',
             'entry': {'logic': 'AND', 'rules': [
                 {'left': {'kind': 'primitive', 'key': 'ma.ema',
                           'params': {'length': 3}, 'symbol': 'MKTUP'},
                  'op': 'gt', 'right': {'kind': 'const', 'value': 0}}]},
             'exit': {'logic': 'AND', 'rules': []}, 'risk': {}}
ok("_unique_indicators SKIPS cross-symbol operands (no wrong-symbol lines)",
   S._unique_indicators(gate_prim) == [], S._unique_indicators(gate_prim))

print("=" * 64)
print("PART E — anchored stops support the PDF's literal $.02 offset")
print("=" * 64)
abs_bars = frame([50, 50.5, 51, 50.8, 51.2])
lvl = S._anchor_levels({'type': 'prim', 'value': 0.0, 'abs': 0.02,
                        'anchor': {'kind': 'primitive', 'key': 'levels.today_low',
                                   'source': 'close'}}, 'long', abs_bars, {})
low_run = np.minimum.accumulate(abs_bars['low'].to_numpy())
ok("LONG: level == running LoD − $0.02 exactly",
   lvl is not None and np.allclose(lvl[~np.isnan(lvl)],
                                   (low_run - 0.02)[~np.isnan(lvl)]),
   f"lvl={lvl}")
lvs = S._anchor_levels({'type': 'prim', 'value': 0.0, 'abs': 0.02,
                        'anchor': {'kind': 'primitive', 'key': 'levels.today_high',
                                   'source': 'close'}}, 'short', abs_bars, {})
hi_run = np.maximum.accumulate(abs_bars['high'].to_numpy())
ok("SHORT: level == running HoD + $0.02 exactly",
   lvs is not None and np.allclose(lvs[~np.isnan(lvs)],
                                   (hi_run + 0.02)[~np.isnan(lvs)]),
   f"lvl={lvs}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
