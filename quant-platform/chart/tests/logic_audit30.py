"""Warm-up sufficiency for EVERY primitive — the long-anchor sweep.

After the 5-day MA was found starting part-way across a chart, the same
question was asked of the rest: weekly VWAP, monthly VWAP, gap VWAP, the
month/year anchored levels, rvol.

The requirements below were MEASURED, not reasoned about: compute a primitive
over a long history to get the reference value on the last RTH bars, then
recompute over shrinking histories; the shortest history whose value still
matches is the warm-up it genuinely needs. (Sampling RTH bars matters — every
vwap.*, today_high and rel_volume is NaN outside 09:30-16:00 by design, so
sampling the tail of a 04:00-20:00 frame would report a healthy primitive as
producing nothing.) The probe lives in the commit that added this file.

What it caught, all fixed here:
  volume.rel_volume       needed 30d, granted 3d. Its `length` counts SESSIONS
                          (20 = twenty prior RTH days ≈ 28 calendar days), and
                          it was being read as a BAR count. The rvol on screen
                          — and behind the In-Play filter and the register
                          cards — was computed against a handful of days.
  levels.prev_month_open  needed 60d, granted 40d: the previous month's first
                          session is up to two calendar months back.
  levels.yearly_open      needed ~300d, granted 40d.
  levels.prev_year_open   ditto.
  candle.* / true_range   needed the bar BEFORE the window; granted 0, so the
                          first visible bar was blank.

PART A — the measured floor per primitive is granted.
PART B — the VWAP family (the question asked) is covered by the group floor.
PART C — year anchors exceed what an intraday fetch can hold; the chart WARNS
         instead of drawing a level off the wrong anchor.
PART D — end-to-end: rel_volume over a stub feed is right at the first bar.
"""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

from chart import data_manager as dm
from chart import server as srv
import tools.compare_server as cs
import qp
from qp.registry import REGISTRY

def grant(key, tf='5m', base=0, params=None):
    return dm.required_days([{'key': key, 'params': params or {}}], tf, base)

# MEASURED days of history each primitive needs for today's value to be right,
# on a 5m chart with default params. Raise a number here only with a new
# measurement, never to make a test pass.
MEASURED = {
    'candle.body': 1, 'candle.bar_range': 1, 'candle.upper_wick': 1,
    'candle.lower_wick': 1, 'volatility.true_range': 1,
    'extremes.highest': 1, 'extremes.lowest': 1,
    'ma.sma': 1, 'ma.ema': 1, 'ma.wma': 1, 'ma.hma': 1, 'ma.rma': 2,
    'ma.vwma': 1, 'ma.pine_5day': 1, 'osc.rsi': 2, 'trend.slope': 1,
    'volatility.atr': 2, 'volatility.atr_daily': 7, 'volatility.bb': 1,
    'volatility.bb_ema': 2, 'volatility.stdev': 1,
    'volume.avg_volume': 1, 'volume.rel_volume': 30,
    'levels.day_open': 1, 'levels.pm_high': 1, 'levels.pm_low': 1,
    'levels.prev_day_open': 2, 'levels.prev_day_close': 2,
    'levels.prev_day_high': 2, 'levels.prev_day_low': 2,
    'levels.weekly_open': 5, 'levels.weekly_high': 2, 'levels.weekly_low': 3,
    'levels.prev_week_open': 14, 'levels.monday_high': 5, 'levels.monday_low': 5,
    'levels.monthly_open': 30, 'levels.monthly_high': 10, 'levels.monthly_low': 3,
    'levels.prev_month_open': 60,
    'levels.postmarket_high': 1, 'levels.postmarket_low': 1,
    'levels.postpre_high': 1, 'levels.postpre_low': 1,
    'levels.window_high': 1, 'levels.window_low': 1, 'levels.today_vol_max': 1,
    'levels.today_high': 1, 'levels.today_low': 1,
    'levels.dynamic_sr': 2, 'pivots.floor': 2,
    'structure.pivot_high': 1, 'structure.pivot_low': 1,
    'vwap.session': 1, 'vwap.weekly': 5, 'vwap.monthly': 30, 'vwap.gap': 3,
    'vwap.nday_block': 2, 'vwap.nday_rolling': 2, 'vwap.stdev_bands': 1,
    'vwap.today_hh': 1, 'vwap.today_ll': 1, 'vwap.week_hh': 2, 'vwap.week_ll': 3,
    'vwap.swing_hh': 2, 'vwap.swing_ll': 2,
    'vwap.last_hour_hh': 2, 'vwap.last_hour_ll': 2,
}
# Year anchors need more history than an intraday fetch can hold — PART C.
YEARLY = {'levels.yearly_open': 300, 'levels.prev_year_open': 300}

print("=" * 64)
print("PART A — every primitive is granted at least what it measurably needs")
print("=" * 64)
short = []
for key, need in sorted(MEASURED.items()):
    if key not in REGISTRY:
        continue
    g = grant(key)
    if g < need:
        short.append(f'{key} needs {need}d, granted {g}d')
ok("no primitive is under-warmed on a 5m chart", not short, '; '.join(short))
ok("rvol counts SESSIONS, not bars (20 sessions ≈ 41 days, was 3)",
   grant('volume.rel_volume') >= 30, f"{grant('volume.rel_volume')}")
ok("...and it scales with the length you ask for",
   grant('volume.rel_volume', params={'length': 5})
   < grant('volume.rel_volume', params={'length': 20}))
ok("prev_month_open reaches back two calendar months",
   grant('levels.prev_month_open') >= 60, f"{grant('levels.prev_month_open')}")
ok("a single-bar primitive still gets the bar before the window",
   grant('candle.body') >= 1 and grant('volatility.true_range') >= 1)
ok("no overlays at all still means no extra fetch", dm.required_days([], '5m', 20) == 20)
# every registry primitive must be covered by the sweep or explicitly excepted
missing = sorted(set(REGISTRY) - set(MEASURED) - set(YEARLY)
                 - {'vwap.anchored'})   # needs an explicit anchor to produce anything
ok("every primitive in the registry is accounted for", not missing, f"{missing}")

print("=" * 64)
print("PART B — the VWAP family (weekly / monthly / gap) is covered")
print("=" * 64)
for k in ('vwap.weekly', 'vwap.monthly', 'vwap.gap', 'vwap.nday_block',
          'vwap.week_hh', 'vwap.swing_hh', 'vwap.stdev_bands'):
    ok(f"{k} gets its measured requirement",
       grant(k) >= MEASURED[k], f"{grant(k)} < {MEASURED[k]}")
ok("monthly VWAP is the longest of them, and still inside the group floor",
   MEASURED['vwap.monthly'] <= dm._HISTORY_FLOOR_DAYS)
ok("the group floor covers them on any timeframe",
   all(grant(k, tf) >= MEASURED[k] for k in ('vwap.weekly', 'vwap.monthly', 'vwap.gap')
       for tf in ('1m', '5m', '15m', '1h')))

print("=" * 64)
print("PART C — year anchors: granted in full, or the chart says it cannot")
print("=" * 64)
ok("a yearly anchor asks for a year of history",
   grant('levels.yearly_open', '1d') >= 365, f"{grant('levels.yearly_open', '1d')}")
ok("prev_year asks for two", grant('levels.prev_year_open', '1d') >= 730)
ok("on a DAILY chart that fits", grant('levels.yearly_open', '1d') <= dm._MAX_DAYS['1d'])
ok("on 1m it cannot — the fetch ceiling wins",
   grant('levels.yearly_open', '1m') == dm._MAX_DAYS['1m'])
# ...and that case must be reported, not drawn from the wrong anchor
src = (pathlib.Path(srv.__file__)).read_text()
ok("_snapshot warns when the ceiling cuts the warm-up short",
   'may start part-way in' in src)
ok("the warning names the timeframe as the fix", 'coarser timeframe' in src)

print("=" * 64)
print("PART D — end to end: rvol is right on the first visible bar")
print("=" * 64)
ET = 'America/New_York'
idx = []
d = pd.Timestamp('2026-05-01', tz=ET)
while d < pd.Timestamp('2026-07-15', tz=ET):
    if d.weekday() < 5:
        t = d.replace(hour=9, minute=30)
        while t.hour < 16:
            idx.append(t); t += pd.Timedelta(minutes=5)
    d += pd.Timedelta(days=1)
idx = pd.DatetimeIndex(idx).tz_convert('UTC')
rng = np.random.default_rng(3)
px = 20 + np.cumsum(rng.normal(0, .02, len(idx)))
FR = pd.DataFrame({'open': px, 'high': px + .05, 'low': px - .05, 'close': px,
                   'volume': np.full(len(idx), 5e4)}, index=idx)
class Stub:
    def load(self, sym, tf, start, end):
        return FR[(FR.index >= start) & (FR.index < end)]
cs._LOADERS['warm30'] = Stub()

RV = [{'id': 'r', 'key': 'volume.rel_volume', 'source': 'close',
       'params': {}, 'color': '#0f0'}]
snap = srv._snapshot('AAA', '5m', 3, 'warm30', 'all', RV, asof='2026-07-14')
bars, vals = snap['bars'], snap['series'][0]['values']
ok("rvol has a value on the FIRST visible bar",
   bool(vals) and vals[0]['time'] == bars[0]['time'],
   f"bar={bars[0]['time']} val={(vals or [{}])[0].get('time')}")
ok("...and the window shown is still the 3 days requested",
   (bars[-1]['time'] - bars[0]['time']) / 86400.0 <= 3.5)
ok("the warm-up actually fetched is reported", snap.get('warmup_days', 0) >= 30,
   f"{snap.get('warmup_days')}")
ok("constant volume every day → rvol ≈ 1.0 (a real baseline, not 1 day)",
   all(abs(v['value'] - 1.0) < 0.15 for v in vals[:20]),
   f"{[round(v['value'], 3) for v in vals[:4]]}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
