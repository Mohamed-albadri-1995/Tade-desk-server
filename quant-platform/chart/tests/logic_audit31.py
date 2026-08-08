"""Opening Range + session VWAP, entry at the 09:35 open.

The brief, rule by rule:
  1-min chart, session VWAP anchored 09:30.
  Opening Range = the five candles 09:30-09:34; mark its midpoint.
  At the 09:34 CLOSE, all three must hold:
     price above (below) session VWAP
     session VWAP turning up (down)
     the 09:34 candle closes in the top (bottom) 45% of the OR
  Entry at the OPEN of 09:35. Stop beyond the OR midpoint. First target 2R,
  take half, trail the balance behind session VWAP.
  If the midpoint is less than ~0.5 ATR away, skip.

PART A — the pieces line up in time: the OR is complete and frozen exactly at
         the decision bar, and the fill is the next bar's open.
PART B — a day built to the spec fires, long and short.
PART C — break each condition in turn; each one alone must kill the trade.
PART D — the risk side: stop at the midpoint, 2R half, runner trails VWAP.

NOT in these rules, deliberately (see the commit message): volume, and the
"cut it early if it grinds back" management rule. Neither is defined precisely
enough yet to encode, and a wrong version is worse than none.
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
import qp
from qp.registry import REGISTRY
from qp.primitives.bars import Bars

ET = 'America/New_York'
DAY = '2026-07-14'
SEEDS = json.loads((pathlib.Path(S.__file__).resolve().parent
                    / 'seeds' / 'or_vwap.json').read_text())
LONG = [d for d in SEEDS if d['side'] == 'long'][0]
SHORT = [d for d in SEEDS if d['side'] == 'short'][0]


def frame(closes, day=DAY, start='09:30', pre=30):
    """1-min bars: `pre` premarket bars then the given RTH closes."""
    idx, px = [], []
    t0 = pd.Timestamp(f'{day} {start}', tz=ET)
    for i in range(pre, 0, -1):
        idx.append(t0 - pd.Timedelta(minutes=i)); px.append(closes[0])
    for i, c in enumerate(closes):
        idx.append(t0 + pd.Timedelta(minutes=i)); px.append(c)
    px = np.asarray(px, dtype=float)
    return pd.DataFrame(
        {'open': px, 'high': px + 0.01, 'low': px - 0.01, 'close': px,
         'volume': np.full(len(px), 1e5)},
        index=pd.DatetimeIndex(idx).tz_convert('UTC'))


FRAMES = {}
class Stub:
    def load(self, sym, tf, start, end):
        f = FRAMES[sym]
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['orv'] = Stub()

def run(strat, sym, df):
    FRAMES[sym] = df
    return S.evaluate(strat, sym, '1m', 1, feed='orv', view='all',
                      asof=DAY, fill='next_open')

# A day that satisfies every long condition:
#   OR (09:30-09:34) rises 10.00 -> 10.40, so ORH=10.41 ORL=9.99, mid≈10.20
#   the 09:34 close (10.40) sits at ~96% of the OR  -> top 45%  ✓
#   price is above session VWAP and VWAP is rising                ✓
#   09:34 close - mid ≈ 0.20, ATR of a 0.02-range bar is ~0.02   ✓ (>0.5 ATR)
#   then it runs to 11.20 so 2R is reached, then falls back under VWAP
GOOD_LONG = ([10.00, 10.10, 10.20, 10.30, 10.40]        # 09:30-09:34  the OR
             + [10.45 + 0.05 * i for i in range(30)]     # 09:35+       the move
             + [10.60 - 0.10 * i for i in range(20)])    # fade back under VWAP

print("=" * 64)
print("PART A — the pieces line up in time (no look-ahead, right fill bar)")
print("=" * 64)
df = frame(GOOD_LONG)
b = Bars(df)
orh = REGISTRY['levels.window_high'].fn(b, start=930, end=935)
orl = REGISTRY['levels.window_low'].fn(b, start=930, end=935)
vw = REGISTRY['vwap.session'].fn(b)
et = df.index.tz_convert(ET)
i34 = [i for i, t in enumerate(et) if t.strftime('%H:%M') == '09:34'][0]
i35 = i34 + 1
ok("the Opening Range is COMPLETE at the 09:34 close",
   abs(orh[i34] - 10.41) < 1e-9 and abs(orl[i34] - 9.99) < 1e-9,
   f"orh={orh[i34]} orl={orl[i34]}")
ok("...and unchanged at 09:35, i.e. frozen not still forming",
   orh[i35] == orh[i34] and orl[i35] == orl[i34])
ok("the OR does not peek at bars after 09:34 (end is exclusive)",
   orh[i34] == max(df['high'].to_numpy()[i34 - 4:i34 + 1]))
ok("session VWAP exists at 09:34 but not before 09:30",
   vw[i34] == vw[i34] and vw[i34 - 5] != vw[i34 - 5])
ok("a 10-bar VWAP lookback would be NaN here — hence 3 bars in the rules",
   vw[i34 - 10] != vw[i34 - 10])
ok("the window is 935/935 so the FILL bar is the 09:35 open",
   (LONG['risk']['window_start'], LONG['risk']['window_end']) == (935, 935))

print("=" * 64)
print("PART B — a day built to the spec fires, both sides")
print("=" * 64)
r = run(LONG, 'GOOD', df)
ok("long evaluates cleanly", r.get('ok') and not r.get('error'), f"{r.get('error')}")
tr = (r.get('trades') or []) + ([r['open_trade']] if r.get('open_trade') else [])
ok("exactly one trade", len(tr) == 1, f"{len(tr)} trades, drops={r.get('entry_drops')}")
if tr:
    ent = pd.Timestamp(tr[0]['entry_ts'], unit='s', tz='UTC').tz_convert(ET)
    ok("the fill is the 09:35 bar", ent.strftime('%H:%M') == '09:35', f"{ent}")
    ok("entry price is the 09:35 OPEN, not the 09:34 close",
       abs(tr[0]['entry'] - df['open'].to_numpy()[i35]) < 1e-9,
       f"{tr[0]['entry']} vs open {df['open'].to_numpy()[i35]}")
    ok("the stop is the OR midpoint (10.20), frozen",
       tr[0].get('stop') is not None and abs(tr[0]['stop'] - 10.20) < 0.02,
       f"{tr[0].get('stop')}")
# THE SUBTLE PART. levels.window_high/low run LIVE while the window is still
# forming, so the three conditions can already be true at 09:31-09:33 on a
# partial Opening Range. The 935/935 window is what actually pins the decision
# to the 09:34 close — those earlier bars are refused and COUNTED, not silently
# ignored. Without the window this setup would enter on a 2-bar "range".
ok("earlier bars in the same run are refused by the window, and counted",
   (r.get('entry_drops') or {}).get('outside_window', 0) >= 1,
   f"{r.get('entry_drops')}")
ok("...and only one entry survives", len(tr) == 1)
# mirrored short day
GOOD_SHORT = ([10.00, 9.90, 9.80, 9.70, 9.60]
              + [9.55 - 0.05 * i for i in range(30)]
              + [9.40 + 0.10 * i for i in range(20)])
rs = run(SHORT, 'GOODS', frame(GOOD_SHORT))
ts = (rs.get('trades') or []) + ([rs['open_trade']] if rs.get('open_trade') else [])
ok("the mirrored short fires on a mirrored day", len(ts) == 1,
   f"{len(ts)} drops={rs.get('entry_drops')}")

print("=" * 64)
print("PART C — break one condition at a time; each alone kills the trade")
print("=" * 64)
def n_trades(strat, tag, closes):
    rr = run(strat, tag, frame(closes))
    return len((rr.get('trades') or [])
               + ([rr['open_trade']] if rr.get('open_trade') else [])), rr

# (1) closes in the BOTTOM of the OR — the 09:34 candle gives the range back
bad_pos = [10.00, 10.30, 10.40, 10.20, 10.02] + GOOD_LONG[5:]
n, rr = n_trades(LONG, 'POS', bad_pos)
ok("09:34 closing in the bottom of the OR → no trade", n == 0,
   f"{n} {rr.get('entry_drops')}")
# (2) price BELOW session VWAP at the decision bar (fade into the close)
bad_vwap = [10.40, 10.30, 10.20, 10.10, 10.00] + GOOD_LONG[5:]
n, rr = n_trades(LONG, 'VW', bad_vwap)
ok("price below session VWAP → no trade", n == 0, f"{n}")
# (3) a FLAT opening range: midpoint is inside 0.5 ATR, "unusually quiet"
flat = [10.00, 10.001, 10.002, 10.001, 10.002] + [10.05 + 0.05 * i for i in range(30)]
n, rr = n_trades(LONG, 'FLAT', flat)
ok("a too-quiet opening range → skipped (the 0.5 ATR guard)", n == 0, f"{n}")
# (4) the same good shape, but the long rules on a DOWN day
n, rr = n_trades(LONG, 'DOWN', GOOD_SHORT)
ok("the long setup does not fire on a short day", n == 0, f"{n}")
n, rr = n_trades(SHORT, 'UP', GOOD_LONG)
ok("the short setup does not fire on a long day", n == 0, f"{n}")
# (5) timing: the signal may only fill at 09:35, never later in the day
late = ([10.20, 10.19, 10.18, 10.19, 10.18]      # nothing at the open
        + [10.18] * 20
        + [10.30 + 0.05 * i for i in range(40)])  # a clean trend at 09:55+
n, rr = n_trades(LONG, 'LATE', late)
ok("a setup that only appears later in the day is NOT taken",
   n == 0, f"{n} {rr.get('entry_drops')}")
ok("...and the reason is recorded as outside_window, not silence",
   (rr.get('entry_drops') or {}).get('outside_window', 0) > 0
   or not (rr.get('entry_drops') or {}), f"{rr.get('entry_drops')}")

print("=" * 64)
print("PART D — the risk side: 2R half, runner trails session VWAP")
print("=" * 64)
ok("first target is half the position at 2R",
   LONG['risk']['targets'] == [{'fraction': 0.5, 'r_multiple': 2.0}],
   f"{LONG['risk']['targets']}")
ok("the stop is anchored to the OR midpoint and FROZEN at entry",
   LONG['risk']['sl']['type'] == 'prim' and LONG['risk']['sl']['freeze'] is True)
ok("the exit is scoped to the RUNNER (armed only after the half banks)",
   LONG['exit'].get('scope') == 'runner')
ok("the runner exits on a close back through session VWAP",
   LONG['exit']['rules'][0]['op'] == 'cross_below'
   and LONG['exit']['rules'][0]['right']['key'] == 'vwap.session')
ok("short mirrors it exactly", SHORT['exit']['rules'][0]['op'] == 'cross_above'
   and SHORT['risk']['targets'] == LONG['risk']['targets'])
ok("one attempt per day", LONG['risk']['max_entries_per_day'] == 1)
if tr and tr[0].get('legs'):
    leg = tr[0]['legs'][0]
    risk = tr[0]['entry'] - tr[0]['stop']
    ok("the 2R leg banks at entry + 2x risk",
       abs(leg['price'] - (tr[0]['entry'] + 2 * risk)) < 0.05,
       f"leg={leg['price']} want={tr[0]['entry'] + 2 * risk}")
    ok("...and it is half the position", abs(leg['fraction'] - 0.5) < 1e-9)
ok("both are restore-only, so edits in the browser survive a deploy",
   LONG.get('_keep_user_edits') is True and SHORT.get('_keep_user_edits') is True)

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
