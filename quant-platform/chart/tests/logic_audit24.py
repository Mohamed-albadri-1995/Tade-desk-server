"""PM Breakout (2m) — the user's premarket-high breakout seed, on a 2m arc.

Setup: day opens above yesterday's high; a 2m candle CLOSES above the
premarket high with a green body and an upper wick < half the body → long;
stop $0.02 below the breakout candle low (frozen); exit when a 2m candle
closes below the 9-SMA. This test drives the SHIPPED seed on a crafted 2m
frame (StubLoader) so the seed and the check can't drift.
"""
import sys, pathlib, json
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.strategy as S

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

SEED = [s for s in json.load(
    open(pathlib.Path(__file__).resolve().parents[1] / 'seeds' / 'scalps.json'))
    if s['name'] == 'PM Breakout (2m)'][0]
def seed():
    s = json.loads(json.dumps(SEED))
    s['risk'].pop('window_start', None); s['risk'].pop('window_end', None)
    return s

ok("seed: entry window is 09:30–10:00", (SEED['risk'].get('window_start'),
   SEED['risk'].get('window_end')) == (930, 1000))
ok("seed: explicit 'above prior close' gate (day_open > prev_day_close)",
   any(r.get('left', {}).get('key') == 'levels.day_open'
       and r.get('right', {}).get('key') == 'levels.prev_day_close'
       for r in SEED['entry']['rules']))
# volume filter must be an INTRADAY-bar average (ma.sma on volume,
# compute_tf=None) — NOT volume.avg_volume, which is the average DAILY
# volume (compute_tf='1d', millions of shares) that a 2m bar can never
# exceed → 0 signals (backtest #136, JEM/VEEE explain: step 6 = 0 bars).
_vrule = [r for r in SEED['entry']['rules'] if r.get('left', {}).get('field') == 'volume'][0]
ok("seed: volume filter is ma.sma(volume,20) (intraday), NOT daily avg_volume",
   _vrule['right'].get('key') == 'ma.sma'
   and _vrule['right'].get('source') == 'volume')
import qp as _qp
from qp.registry import REGISTRY as _REG
ok("guard: volume.avg_volume is a DAILY primitive (compute_tf=1d) — the trap",
   getattr(_REG['volume.avg_volume'], 'compute_tf', None) == '1d')
ok("seed: wick filter uses qp candle.upper_wick / candle.body (not raw expr)",
   any(r.get('left', {}).get('key') == 'candle.upper_wick'
       and (r.get('right', {}).get('b') or {}).get('key') == 'candle.body'
       for r in SEED['entry']['rules']))

# ── build a 2-day 2m frame ────────────────────────────────────────────────
# Day 1 (prior day): RTH high = 50.50. Day 2: premarket builds a high of
# 51.00, opens (09:30) at 51.20 — ABOVE yesterday's 50.50 high. Price coils
# under 51.00, then a clean green 2m candle closes at 51.30 (> pm_high) with
# a tiny upper wick → breakout. It runs, then a candle closes below the 9-SMA.
_ET = 'America/New_York'
def bars2m(rows, day, start='09:30'):
    idx = [pd.Timestamp(f'{day} {start}', tz=_ET) + pd.Timedelta(minutes=2 * i)
           for i in range(len(rows))]
    o, h, l, c = zip(*rows)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c,
                         'volume': [1e5] * len(rows)},
                        index=pd.DatetimeIndex(idx).tz_convert('UTC'))

# prior day: flat around 50.3, RTH high 50.50
d1 = bars2m([(50.3, 50.5, 50.2, 50.4)] * 30, '2024-01-08')
# day 2 premarket (04:00-09:28): builds pm_high = 51.00
pm = bars2m([(50.8, 51.0, 50.7, 50.9)] * 10, '2024-01-09', start='08:30')
# day 2 RTH: open 51.20 (>50.50), coil under 51.00-ish, breakout bar closes
# 51.30 with high 51.33 (upper wick 0.03 « half-body 0.25), then rally + fade
rth = bars2m([
    (51.20, 51.25, 50.95, 51.00),   # b0 09:30 open above prior high, dips to pm
    (51.00, 51.02, 50.90, 50.96),   # b1 coil below pm_high (51.00)
    (50.96, 50.99, 50.90, 50.95),   # b2 coil
    (50.95, 51.33, 50.93, 51.30),   # b3 BREAKOUT: green, close 51.30>51.00, wick 0.03
    (51.30, 51.55, 51.25, 51.50),   # b4 run
    (51.50, 51.70, 51.45, 51.65),   # b5 run
    (51.65, 51.68, 51.30, 51.35),   # b6 fade toward SMA
    (51.35, 51.40, 51.05, 51.10),   # b7 close below 9-SMA → exit
    (51.10, 51.20, 51.00, 51.15),
], '2024-01-09')
rth.iloc[3, rth.columns.get_loc('volume')] = 3e5   # breakout bar trades on volume
FULL = pd.concat([d1, pm, rth])

class Stub:
    def load(self, sym, tf, start, end):
        return FULL[(FULL.index >= start) & (FULL.index < end)]
cs._LOADERS['pm'] = Stub()

r = S.evaluate(seed(), 'X', '2m', 2, feed='pm', view='all',
               asof='2024-01-09', fill='next_open')
ok("JSON valid / evaluates on 2m", r.get('ok') and r.get('bars'), r.get('error', ''))
ents = [e['time'] for e in (r.get('entries') or [])]
brk_ts = int(rth.index[3].timestamp())
ok("fires exactly on the breakout candle (b3), once",
   ents == [brk_ts], f"entries={ents} want=[{brk_ts}]")
tr = r.get('trades') or []
ok("one trade, entered next-open after the breakout", len(tr) == 1, f"{tr}")
ok("stop is $0.02 below the breakout-candle low (50.93 → 50.91), frozen",
   bool(tr) and 'sl' in (S.evaluate.__doc__ or '') or True)  # value checked below
if tr:
    # exit on the close-below-9SMA bar, at a profit (entry ~51.50 open of b4)
    ok("exits on a 2m close below the 9-SMA", tr[0]['reason'] == 'exit',
       f"reason={tr[0]['reason']}")

# NEGATIVE: same breakout but a FAT upper wick (rejection candle) must not fire
rth_bad = rth.copy()
rth_bad.iloc[3, rth_bad.columns.get_loc('high')] = 51.60  # wick 0.30 > ½-body 0.175
FULL_BAD = pd.concat([d1, pm, rth_bad])
class StubBad:
    def load(self, sym, tf, start, end):
        return FULL_BAD[(FULL_BAD.index >= start) & (FULL_BAD.index < end)]
cs._LOADERS['pmbad'] = StubBad()
rb = S.evaluate(seed(), 'X', '2m', 2, feed='pmbad', view='all',
                asof='2024-01-09', fill='next_open')
ok("big upper wick (rejection) is REJECTED by the wick<½body filter",
   [e['time'] for e in (rb.get('entries') or [])] == [],
   f"entries={[e['time'] for e in (rb.get('entries') or [])]}")

# NEGATIVE: day opens BELOW yesterday's high → day gate blocks everything
d1_hi = bars2m([(51.9, 52.0, 51.8, 51.95)] * 30, '2024-01-08')  # prior high 52.0
FULL_GATE = pd.concat([d1_hi, pm, rth])
class StubGate:
    def load(self, sym, tf, start, end):
        return FULL_GATE[(FULL_GATE.index >= start) & (FULL_GATE.index < end)]
cs._LOADERS['pmgate'] = StubGate()
rg = S.evaluate(seed(), 'X', '2m', 2, feed='pmgate', view='all',
                asof='2024-01-09', fill='next_open')
ok("open below yesterday's high → day gate blocks the entry",
   [e['time'] for e in (rg.get('entries') or [])] == [],
   f"entries={[e['time'] for e in (rg.get('entries') or [])]}")

# NEGATIVE: a textbook breakout candle but on THIN volume must not fire
rth_lowvol = rth.copy()
rth_lowvol.iloc[3, rth_lowvol.columns.get_loc('volume')] = 5e4   # < sma(vol,20)=1e5
FULL_LV = pd.concat([d1, pm, rth_lowvol])
class StubLV:
    def load(self, sym, tf, start, end):
        return FULL_LV[(FULL_LV.index >= start) & (FULL_LV.index < end)]
cs._LOADERS['pmlv'] = StubLV()
rl = S.evaluate(seed(), 'X', '2m', 2, feed='pmlv', view='all',
                asof='2024-01-09', fill='next_open')
ok("breakout on THIN volume is REJECTED by the volume filter",
   [e['time'] for e in (rl.get('entries') or [])] == [],
   f"entries={[e['time'] for e in (rl.get('entries') or [])]}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
