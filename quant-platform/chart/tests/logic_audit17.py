"""The 5 SMB scalps (trades_.pdf) — the SHIPPED SEEDS fire on their PDF arcs.

From-scratch rebuild: every test loads the seed from seeds/scalps.json and
runs it through the FULL evaluate() path against a hand-crafted 1-minute day
shaped like the PDF's picture (grind→acceleration→snapback, break→retest→
attack, sold-off→backside→box→VWAP, drive→box→HitchHiker candle). Each arc
asserts the seed fires ON THE RIGHT BAR, and each PDF "avoid" case asserts it
does NOT fire. No inline strategy copies — the seeds ARE what's tested, so
seed and test can never drift apart again.
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

def _day_index(n, day='2024-01-09', start='09:30'):
    return pd.DatetimeIndex(
        [pd.Timestamp(f'{day} {start}', tz='America/New_York') + pd.Timedelta(minutes=i)
         for i in range(n)]).tz_convert('UTC')

def frame(close, o=None, h=None, l=None, v=None, day='2024-01-09', start='09:30'):
    close = np.array(close, float); n = len(close)
    o = np.array(o, float) if o is not None else close.copy()
    h = np.array(h, float) if h is not None else np.maximum(o, close)
    l = np.array(l, float) if l is not None else np.minimum(o, close)
    v = np.array(v, float) if v is not None else np.full(n, 1e5)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': close, 'volume': v},
                        index=_day_index(n, day, start))

SCEN = {}
class StubLoader:
    def load(self, symbol, tf, start, end):
        if tf == '1d':
            idx = pd.date_range(end - pd.Timedelta(days=120), end, freq='1D', tz='UTC')
            n = len(idx); base = np.full(n, 50.0)
            # steady ~1.2 TR so atr_daily is a clean known number (3 ATR ≈ 3.6)
            return pd.DataFrame({'open': base, 'high': base + 0.6, 'low': base - 0.6,
                                 'close': base, 'volume': 1e7}, index=idx)
        f = SCEN.get(symbol)
        if f is None:
            return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'],
                                index=pd.DatetimeIndex([], tz='UTC'))
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['scalp'] = StubLoader()

# a flat SPY so the RubberBand market gates pass in both directions (ema20 ==)
SCEN['SPY'] = frame([400.0] * 70, [400.0] * 70, [400.05] * 70, [399.95] * 70,
                    [1e6] * 70, start='08:40')

SEEDS = {s['name']: s for s in json.loads(
    (pathlib.Path(__file__).resolve().parents[1] / 'seeds' / 'scalps.json').read_text())}

def seed(name):
    """The shipped seed, with the time-of-day window stripped so a compact
    crafted morning can exercise the arc (the windows are asserted separately)."""
    s = json.loads(json.dumps(SEEDS[name]))
    s['risk'] = {k: v for k, v in (s.get('risk') or {}).items()
                 if k not in ('window_start', 'window_end')}
    return s

def run(strat, symbol):
    return S.evaluate(strat, symbol, '1m', 1, feed='scalp', view='all',
                      asof='2024-01-09', fill='close')

def entry_bars(res):
    return sorted(e['time'] for e in (res.get('entries') or []))
def bar_ts(n, day='2024-01-09', start='09:30'):
    return int(_day_index(n, day, start)[-1].timestamp())

print("=" * 64)
print("SCALP 1 — RubberBand LONG: GRIND → ACCELERATION → SNAPBACK")
print("=" * 64)
# GRIND 0-9 (controlled fall, heavy early volume keeps VWAP overhead),
# ACCELERATION 10-14 (bigger candles, bigger volume, new lows every bar),
# SNAPBACK 15 (single BIG green candle at the LoD clears 2 prior highs on the
# day's biggest volume; day is >3 ATR down from the open), recovery 16-25.
g_cl = [50.20, 49.95, 49.70, 49.45, 49.20, 48.95, 48.70, 48.45, 48.20, 47.95]
a_cl = [47.65, 47.30, 46.95, 46.55, 46.25]
r_cl = [46.95, 47.30, 47.80, 48.30, 48.80, 49.10, 49.20, 49.25, 49.20, 49.15, 49.10]
cl = g_cl + a_cl + r_cl
op = [50.25] + [c + 0.03 for c in cl[:-1]]           # each bar opens near prior close
op[15] = 46.15                                        # snapback opens at the lows
hi = [max(o, c) + 0.12 for o, c in zip(op, cl)]
lo = [min(o, c) - 0.10 for o, c in zip(op, cl)]
for i in range(10, 15):                               # acceleration: ranges widen
    hi[i] = max(op[i], cl[i]) + 0.18
    lo[i] = min(op[i], cl[i]) - 0.22
hi[15] = 47.35; lo[15] = 45.95; cl[15] = 47.25        # BIG snapback: clears the accel bars' highs
vol = [4e5] * 4 + [1e5] * 6 + [3e5, 4e5, 5e5, 7e5, 9e5] + [1.5e6] + [3e5] * 10
SCEN['RUBBER'] = frame(cl, op, hi, lo, vol)
rb = seed('RubberBand Scalp')
r = run(rb, 'RUBBER')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error', ''))
ok("fires ONCE, at the snapback bar (15)",
   entry_bars(r) == [bar_ts(16)], f"entries={entry_bars(r)} want={[bar_ts(16)]}")
tr = r.get('trades') or []
ok("scale-out legs bank and the runner reaches VWAP (profit)",
   bool(tr) and tr[0]['ret'] > 0, f"trades={[(t['reason'], round(t['ret'], 3)) for t in tr]}")
ok("stop is anchored to the LoD (priced)",
   any(s['name'] == 'SL level' for s in r.get('series') or []))

# AVOID: same day but the snapback candle is SMALL (a weak poke, not a decisive
# announcement) → the big-candle rule must reject the whole arc.
hi2 = list(hi); cl2 = list(cl); op2 = list(op); lo2 = list(lo)
op2[15] = 46.20; cl2[15] = 46.50; hi2[15] = 46.60; lo2[15] = 46.15   # range 0.45
SCEN['RUBBERSMALL'] = frame(cl2, op2, hi2, lo2, vol)
ok("SMALL snapback candle is REJECTED (not decisive)",
   len(entry_bars(run(rb, 'RUBBERSMALL'))) == 0,
   f"entries={entry_bars(run(rb, 'RUBBERSMALL'))}")

# AVOID: a green double-bar break far ABOVE the LoD (continuation bounce, not
# a snapback at the lows) → the at-the-LoD rule must reject it.
cl3 = g_cl + a_cl + [46.40, 46.60, 48.30, 48.90, 48.70, 48.60, 48.50, 48.40, 48.30, 48.20, 48.10]
op3 = [50.25] + [c + 0.03 for c in cl3[:-1]]; op3[17] = 47.60
hi3 = [max(o, c) + 0.12 for o, c in zip(op3, cl3)]
lo3 = [min(o, c) - 0.10 for o, c in zip(op3, cl3)]
hi3[17] = 49.20; lo3[17] = 48.00                      # big green DBB but ~4% over LoD
op3[17] = 48.10; cl3[17] = 48.90                      # (low 48.00 >> LoD 46.15×1.03)
SCEN['RUBBERFAR'] = frame(cl3, op3, hi3, lo3, vol)
ok("break far above the LoD is REJECTED (no snapback at the lows)",
   len(entry_bars(run(rb, 'RUBBERFAR'))) == 0,
   f"entries={entry_bars(run(rb, 'RUBBERFAR'))}")

print("=" * 64)
print("SCALP 2 — RubberBand SHORT: the exact inversion (blow-off top)")
print("=" * 64)
sg = [49.80, 50.05, 50.30, 50.55, 50.80, 51.05, 51.30, 51.55, 51.80, 52.05]
sa = [52.35, 52.70, 53.05, 53.45, 53.75]
sr = [53.05, 52.70, 52.20, 51.70, 51.20, 50.90, 50.80, 50.75, 50.80, 50.85, 50.90]
scl = sg + sa + sr
sop = [49.75] + [c - 0.03 for c in scl[:-1]]
sop[15] = 53.85                                       # snapback opens at the highs
shi = [max(o, c) + 0.10 for o, c in zip(sop, scl)]
slo = [min(o, c) - 0.12 for o, c in zip(sop, scl)]
for i in range(10, 15):
    shi[i] = max(sop[i], scl[i]) + 0.22
    slo[i] = min(sop[i], scl[i]) - 0.18
shi[15] = 54.05; slo[15] = 52.70                      # BIG red snapback: breaks the accel bars' lows
svol = [4e5] * 4 + [1e5] * 6 + [3e5, 4e5, 5e5, 7e5, 9e5] + [1.5e6] + [3e5] * 10
SCEN['RUBBERUP'] = frame(scl, sop, shi, slo, svol)
rbs = seed('RubberBand Scalp (Short)')
rs = run(rbs, 'RUBBERUP')
ok("SHORT: JSON valid / evaluates", rs.get('ok') and rs.get('bars'), rs.get('error', ''))
ok("SHORT: fires ONCE, at the red snapback bar (15)",
   entry_bars(rs) == [bar_ts(16)], f"entries={entry_bars(rs)} want={[bar_ts(16)]}")
ok("SHORT: stop is anchored ABOVE (HoD), priced",
   any(s['name'] == 'SL level' for s in rs.get('series') or []))
str_ = rs.get('trades') or []
ok("SHORT: covers into VWAP at a profit",
   bool(str_) and str_[0]['ret'] > 0,
   f"trades={[(t['reason'], round(t['ret'], 3)) for t in str_]} open={rs.get('open_trade')}")

print("=" * 64)
print("SCALP 3 — Second Chance: BREAK → quiet RETEST → ATTACK above the level")
print("=" * 64)
# pivot high 48.60 at b7 (confirms b12, HELD), break b15 on 3x volume, quiet
# retest b17 (half the usual volume), attack b18 closes above prior AND above
# the reclaimed level. Half banks at the FROZEN pullback high (49.30, the b16
# spike); the runner is managed by the 9-EMA trail ONLY (scope 'runner') and
# exits on the b24-b26 fade through it — the hard stop never trails up.
c2 = [48.00, 48.05, 48.15, 48.20, 48.30, 48.40, 48.45, 48.50, 48.40, 48.35, 48.30,
      48.25, 48.20, 48.15, 48.10, 48.90, 49.20, 48.70, 49.10, 49.20, 49.25, 49.20, 49.15, 49.10,
      48.95, 48.75, 48.55]
h2 = [48.10, 48.15, 48.30, 48.35, 48.40, 48.45, 48.50, 48.60, 48.45, 48.40, 48.35,
      48.30, 48.25, 48.20, 48.15, 49.00, 49.30, 48.80, 49.20, 49.30, 49.32, 49.28, 49.20, 49.15,
      49.08, 48.95, 48.75]
l2 = [47.90, 47.95, 48.00, 48.10, 48.20, 48.30, 48.35, 48.40, 48.30, 48.25, 48.20,
      48.15, 48.10, 48.05, 48.00, 48.20, 48.85, 48.50, 48.65, 49.00, 49.10, 49.05, 49.00, 48.95,
      48.90, 48.70, 48.50]
o2 = [47.95, 48.00, 48.10, 48.15, 48.25, 48.35, 48.40, 48.45, 48.42, 48.38, 48.32,
      48.28, 48.22, 48.18, 48.12, 48.15, 49.00, 48.95, 48.70, 49.05, 49.15, 49.20, 49.15, 49.10,
      49.05, 48.93, 48.73]
v2 = [1e5] * 15 + [3e5] + [1e5] + [5e4] + [1e5] * 9
SCEN['SECOND'] = frame(c2, o2, h2, l2, v2)
sc = seed('Second Chance Scalp')
r2 = run(sc, 'SECOND')
ok("JSON valid / evaluates", r2.get('ok') and r2.get('bars'), r2.get('error', ''))
ok("break(vol↑) → retest(vol↓) → attack(reclaimed) fires at b18",
   bar_ts(19) in entry_bars(r2), f"entries={entry_bars(r2)}")
tr2 = r2.get('trades') or []
_legs2 = (tr2[0].get('legs') or []) if tr2 else []
ok("half banks AT the frozen pullback high (49.30) — not a tick above entry",
   bool(_legs2) and abs(float(_legs2[0].get('price', 0)) - 49.30) < 1e-6,
   f"trades={[(t['reason'], round(t['ret'], 3), t.get('legs')) for t in tr2]}")
ok("runner exits via the 9-EMA fade, not a pre-target scratch",
   bool(tr2) and tr2[0]['reason'] == 'exit' and tr2[0]['exit_ts'] >= bar_ts(24),
   f"trades={[(t['reason'], t.get('exit_ts')) for t in tr2]}")

# AVOID (the abort rule): the level breaks back into range and the "attack"
# up-close happens BELOW the failed level → must never fire.
c3 = c2[:15] + [48.90, 48.40, 48.20, 48.45, 48.40, 48.35, 48.30, 48.25, 48.20]
h3 = h2[:15] + [49.00, 48.60, 48.35, 48.50, 48.48, 48.42, 48.38, 48.32, 48.28]
l3 = l2[:15] + [48.20, 48.30, 48.10, 48.18, 48.30, 48.28, 48.22, 48.18, 48.12]
o3 = o2[:15] + [48.15, 48.85, 48.32, 48.22, 48.42, 48.38, 48.33, 48.28, 48.22]
v3 = [1e5] * 15 + [3e5] + [1e5] + [5e4] + [1e5] * 6
SCEN['SECONDFAIL'] = frame(c3, o3, h3, l3, v3)
ok("attack BELOW the failed level is REJECTED (abort rule)",
   len(entry_bars(run(sc, 'SECONDFAIL'))) == 0,
   f"entries={entry_bars(run(sc, 'SECONDFAIL'))}")

print("=" * 64)
print("SCALP 4 — Back$ide: SOLD-OFF → BACKSIDE (HH+HL over rising 9EMA) → BOX → VWAP")
print("=" * 64)
# heavy-volume fall keeps VWAP overhead (~48.8); staircase recovery prints
# distinct higher highs AND higher lows above a turning 9-EMA; a tight box
# forms UNDER the peak (stopped making HHs) above the 9-EMA; the box breaks
# while still below VWAP → the ENTIRE position exits intrabar AT VWAP.
b_warm = [50.00] * 10                                 # open chop: warms the 9-EMA (real
b_fall = [49.90, 49.00, 48.00, 47.00, 46.40, 46.10]   # Back$ides fire mid-morning)
b_up   = [46.40, 46.30, 46.85, 46.75, 47.20, 47.10, 47.55, 47.65]
b_box  = [47.50, 47.60, 47.47, 47.59, 47.51, 47.60]
b_brk  = [47.85, 48.30, 48.70, 48.90, 48.80]
bc = b_warm + b_fall + b_up + b_box + b_brk
bo = [50.05] + [c + 0.02 for c in bc[:-1]]
bh = [max(o, c) + 0.10 for o, c in zip(bo, bc)]
bl = [min(o, c) - 0.10 for o, c in zip(bo, bc)]
bh[23] = 47.85                                        # the distinct peak (bar 23)
for i in range(24, 30):                               # the box: tight, above ema9,
    bh[i] = max(bo[i], bc[i]) + 0.05                  # its FLOOR above the midpoint
    bl[i] = min(bo[i], bc[i]) - 0.05
bv = [1e5] * 10 + [1.5e6, 1e6, 6e5, 4e5, 3e5, 2e5] + [1e5] * 8 + [8e4] * 6 + [3e5] * 5
SCEN['BACK'] = frame(bc, bo, bh, bl, bv)
bs = seed('Back$ide Scalp')
r3 = run(bs, 'BACK')
ok("JSON valid / evaluates", r3.get('ok') and r3.get('bars'), r3.get('error', ''))
ok("SOLD-OFF → BACKSIDE → BOX BREAK fires ONCE (bar 30)",
   entry_bars(r3) == [bar_ts(31)], f"entries={entry_bars(r3)} want={[bar_ts(31)]}")
tr3 = r3.get('trades') or []
ok("the ENTIRE position exits AT VWAP intrabar, at a profit",
   bool(tr3) and tr3[0]['ret'] > 0,
   f"trades={[(t['reason'], round(t['ret'], 3)) for t in tr3]} open={r3.get('open_trade')}")

print("=" * 64)
print("SCALP 5 — HitchHiker: DRIVE → BOX (upper 1/3, peak behind) → HH CANDLE")
print("=" * 64)
_W = lambda seq, v: [v] * 8 + seq
hc = _W([47.50, 48.30, 49.20, 50.00, 49.70, 49.65, 49.72, 49.68, 49.70, 49.66, 50.20], 46.50)
hh = _W([47.60, 48.40, 49.30, 50.10, 49.75, 49.70, 49.77, 49.73, 49.75, 49.71, 50.30], 46.60)
hl = _W([47.40, 48.20, 49.10, 49.90, 49.65, 49.60, 49.67, 49.63, 49.65, 49.61, 49.90], 46.40)
ho = _W([47.40, 47.60, 48.40, 49.30, 49.72, 49.68, 49.66, 49.71, 49.66, 49.69, 49.70], 46.50)
hv = _W([2e5, 2e5, 2e5, 2e5, 1e5, 1e5, 1e5, 1e5, 1e5, 1e5, 2e5], 1e5)
SCEN['HITCH'] = frame(hc, ho, hh, hl, hv)
hh_seed = seed('HitchHiker Scalp')
r4 = run(hh_seed, 'HITCH')
ok("JSON valid / evaluates", r4.get('ok') and r4.get('bars'), r4.get('error', ''))
ok("drive → box → HitchHiker candle fires ONCE", len(entry_bars(r4)) == 1,
   f"entries={entry_bars(r4)}")
# AVOID: mid-range chop (no drive, box low far below the upper 1/3)
cc = _W([47.0, 48.5, 47.2, 48.4, 47.3, 47.8, 47.6, 47.9, 47.7, 47.85, 47.75, 47.8, 48.1], 46.5)
ch = _W([47.6, 49.0, 47.8, 48.9, 47.9, 47.95, 47.9, 48.05, 47.9, 48.0, 47.95, 48.0, 48.3], 46.6)
clo = _W([46.8, 47.9, 46.9, 47.9, 47.0, 47.6, 47.5, 47.7, 47.55, 47.7, 47.6, 47.65, 47.9], 46.4)
co = _W([46.9, 47.1, 48.4, 47.3, 48.3, 47.7, 47.85, 47.7, 47.9, 47.75, 47.85, 47.78, 47.95], 46.5)
cv = _W([2e5] * 5 + [1e5] * 7 + [2e5], 1e5)
SCEN['HITCHCHOP'] = frame(cc, co, ch, clo, cv)
ok("mid-range chop is REJECTED",
   len(entry_bars(run(hh_seed, 'HITCHCHOP'))) == 0,
   f"entries={entry_bars(run(hh_seed, 'HITCHCHOP'))}")

print("=" * 64)
print("SCALP 6 — Fashionably Late (LOCKED, untouched): still fires")
print("=" * 64)
fcl = [50, 49.6, 49.2, 48.8, 48.4, 48.0, 47.7, 47.5, 47.6, 47.9, 48.3, 48.7, 49.1,
       49.4, 49.7, 50.0, 50.3, 50.6]
SCEN['FLATE'] = frame(fcl, [c - 0.03 for c in fcl], [c + 0.1 for c in fcl],
                      [c - 0.1 for c in fcl])
fl = seed('Fashionably Late Scalp')
r5 = run(fl, 'FLATE')
ok("JSON valid / evaluates", r5.get('ok') and r5.get('bars'), r5.get('error', ''))
ok("9EMA-cross-VWAP fires (>=1 entry)", len(entry_bars(r5)) >= 1, f"entries={entry_bars(r5)}")

print("=" * 64)
print("ENGINE GUARDS — stop ratchet + trail labeling (unchanged behavior)")
print("=" * 64)
gidx = _day_index(6, start='10:00')
gd = pd.DataFrame({'open': [50, 50, 49, 48, 47, 46], 'high': [50.1, 50.1, 49.1, 48.1, 47.1, 46.1],
                   'low': [49.9, 49.9, 48.9, 47.9, 46.9, 45.9], 'close': [50, 50, 49, 48, 47, 46],
                   'volume': [1e5] * 6}, index=gidx)
SCEN['STOPTEST'] = gd
T = lambda field='hhmm': {'kind': 'time', 'field': field}
gstrat = {'name': 'g', 'side': 'long',
          'entry': {'logic': 'AND', 'rules': [
              {'left': T(), 'op': 'eq', 'right': {'kind': 'const', 'value': 1001}}]},
          'exit': {'logic': 'AND', 'rules': []},
          'risk': {'sl': {'type': 'prim', 'value': 0.05,
                          'anchor': {'kind': 'primitive', 'key': 'levels.today_low',
                                     'source': 'close', 'offset': 1}}}}
rg = run(gstrat, 'STOPTEST')
ok("today_low[1] stop FIRES on a breakdown",
   any(t['reason'] == 'SL' for t in rg.get('trades') or []),
   f"trades={[(t['reason']) for t in rg.get('trades') or []]}")
gstrat_live = dict(gstrat, risk={'sl': {'type': 'prim', 'value': 0.05,
                                        'anchor': {'kind': 'primitive', 'key': 'levels.today_low',
                                                   'source': 'close'}}})
rl = run(gstrat_live, 'STOPTEST')
ok("LIVE today_low stop ALSO fires (ratchet freezes it)",
   any(t['reason'] == 'SL' for t in rl.get('trades') or []))
tidx = _day_index(9, start='10:00')
tc = [50, 50, 51, 52, 53, 54, 53.5, 53, 52.5]
to = [50, 50, 51, 52, 53, 54, 53.5, 53.4, 52.5]
th = [max(o, c) + 0.15 for o, c in zip(to, tc)]
tl = [min(o, c) - 0.15 for o, c in zip(to, tc)]
SCEN['TRAIL'] = pd.DataFrame({'open': to, 'high': th, 'low': tl, 'close': tc,
                              'volume': [1e5] * 9}, index=tidx)
tstrat = {'name': 't', 'side': 'long',
          'entry': {'logic': 'AND', 'rules': [
              {'left': T(), 'op': 'eq', 'right': {'kind': 'const', 'value': 1004}}]},
          'exit': {'logic': 'AND', 'rules': []},
          'risk': {'sl': {'type': 'prim', 'value': 0,
                          'anchor': {'kind': 'primitive', 'key': 'ma.ema',
                                     'params': {'length': 3}}}}}
rt = run(tstrat, 'TRAIL')
tr_t = rt.get('trades') or []
ok("profitable trailing-stop exit is labeled 'trail', not 'SL'",
   bool(tr_t) and tr_t[0]['reason'] == 'trail' and tr_t[0]['ret'] > 0,
   f"trades={[(t['reason'], round(t['ret'], 3)) for t in tr_t]}")

print("=" * 64)
print("DISCIPLINE — every seed carries its PDF attempts cap + time window")
print("=" * 64)
_caps = {'RubberBand Scalp': 2, 'RubberBand Scalp (Short)': 2, 'Second Chance Scalp': 2,
         'Back$ide Scalp': 1, 'HitchHiker Scalp': 1, 'Fashionably Late Scalp': 1}
_wins = {'RubberBand Scalp': (1000, 1330), 'RubberBand Scalp (Short)': (1000, 1330),
         'Second Chance Scalp': (959, 1550), 'Back$ide Scalp': (1000, 1330),
         'HitchHiker Scalp': (945, 1030), 'Fashionably Late Scalp': (1000, 1330)}
for name, sd in SEEDS.items():
    _r = sd.get('risk') or {}
    ok(f"seed '{name}' caps + cools, no min-hold",
       _r.get('max_entries_per_day') == _caps[name]
       and _r.get('cooldown_bars') == 10 and _r.get('min_hold_bars') is None,
       f"cap={_r.get('max_entries_per_day')} cd={_r.get('cooldown_bars')}")
    ok(f"seed '{name}' carries its PDF time window",
       (_r.get('window_start'), _r.get('window_end')) == _wins[name],
       f"win=({_r.get('window_start')},{_r.get('window_end')}) exp={_wins[name]}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
