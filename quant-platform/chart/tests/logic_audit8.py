"""Audit part 8 — SL/TP/exit can NEVER fire before (or on) the entry bar.

The user's execution invariant: "the entry signal is an implicit AND on every
SL/TP/exit condition". Structurally guaranteed in _pair_trades (all exit paths
live inside the in-position branch; the entry bar itself is skipped) — these
cases pin it so it can never regress. At the broker this maps to bracket
children attached to the entry order, so the same guarantee holds live.
"""
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

P = lambda f='close': {'kind': 'price', 'field': f}
C = lambda x: {'kind': 'const', 'value': x}

print("== SL/TP/exit can never fire before entry ==")
# lows SLASH through the would-be SL level (99) on bars 0-2, BEFORE the entry
# at bar 3. No trade may exist before bar 3; the SL may fire at bar 4+ only.
b = bars_from(close=[100, 100, 100, 100, 100, 100],
              l=[97.0, 97.0, 97.0, 99.8, 99.8, 98.9],
              h=[100.2] * 6)
risk = {'sl': {'type': 'pct', 'value': 1}}          # SL level = 99 after entry
ent = np.array([False, False, False, True, False, False])
tr, slv, _, op = S._pair_trades(b, list(range(6)), ent, np.zeros(6, bool),
                                'long', risk, None)
chkv('no trade before the entry bar', all(t['ei'] == 3 for t in tr), True)
chkv('SL fires only AFTER entry (bar 5)',
     [(t['ei'], t['xi'], t['reason']) for t in tr], [(3, 5, 'SL')])
chkv('SL level not armed before entry (view NaN)',
     [v == v for v in slv[:3]], [False, False, False])

# same for an ANCHORED (trailing) stop: the line exists on every bar, but it
# must only be ARMED from the entry bar on.
riskA = {'sl': {'type': 'prim', 'value': 0, 'anchor': C(99)}}
trA, slvA, _, _ = S._pair_trades(b, list(range(6)), ent, np.zeros(6, bool),
                                 'long', riskA, None)
chkv('anchored SL ignores pre-entry violations',
     [(t['ei'], t['xi'], t['reason']) for t in trA], [(3, 5, 'SL')])
chkv('anchored level not armed before entry',
     [v == v for v in slvA[:3]], [False, False, False])

# TP: highs pierce the would-be TP (102) before entry — must not close anything
b2 = bars_from(close=[100, 100, 100, 100, 100],
               h=[105, 105, 100.2, 100.2, 102.5],
               l=[99.9] * 5)
risk2 = {'tp': {'type': 'pct', 'value': 2}}
ent2 = np.array([False, False, True, False, False])
tr2, _, tpv2, _ = S._pair_trades(b2, list(range(5)), ent2, np.zeros(5, bool),
                                 'long', risk2, None)
chkv('TP fires only AFTER entry', [(t['ei'], t['xi'], t['reason']) for t in tr2],
     [(2, 4, 'TP')])

# exit CONDITION true long before entry: nothing closes before a position exists
b3 = bars_from(close=[100] * 5)
ex_all = np.ones(5, bool)                            # exit condition always true
ent3 = np.array([False, False, False, True, False])
tr3, _, _, _ = S._pair_trades(b3, list(range(5)), ent3, ex_all, 'long', {}, None)
chkv('exit rule waits for a position', [(t['ei'], t['xi']) for t in tr3], [(3, 4)])

# entry bar itself is exempt: SL pierced ON the entry bar doesn't exit same-bar
b4 = bars_from(close=[100, 100, 100], l=[99.9, 98.5, 99.8], h=[100.1] * 3)
tr4, _, _, op4 = S._pair_trades(b4, list(range(3)), np.array([False, True, False]),
                                np.zeros(3, bool), 'long', risk, None)
chkv('no same-bar exit on the entry bar',
     all(t['xi'] > t['ei'] for t in tr4), True)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
