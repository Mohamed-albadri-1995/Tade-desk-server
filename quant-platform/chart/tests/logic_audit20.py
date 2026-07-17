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

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
