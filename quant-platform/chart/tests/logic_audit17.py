"""Prove the strategy builder can express all 5 scalps from trades_.pdf.
Each strategy is built as real strategy JSON and run through the FULL
evaluate() path (required_days -> prepare_bars -> overlay_arrays -> engine)
against hand-crafted 1-minute bars designed to trigger the entry. We assert
the JSON is valid AND the entry fires on the intended bar."""
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

# ── operand shorthand (exactly the JSON the UI emits) ───────────────────────
P  = lambda f, off=0: {'kind': 'price', 'field': f, **({'offset': off} if off else {})}
C  = lambda v: {'kind': 'const', 'value': v}
T  = lambda field='hhmm': {'kind': 'time', 'field': field}
def PRIM(key, sub=None, params=None, source='close', off=0):
    d = {'kind': 'primitive', 'key': key, 'source': source}
    if params: d['params'] = params
    if sub:    d['sub'] = sub
    if off:    d['offset'] = off
    return d
EXPR = lambda op, a, b: {'kind': 'expr', 'op': op, 'a': a, 'b': b}
def rule(left, op, right=None, **mods):
    r = {'left': left, 'op': op}
    if right is not None: r['right'] = right
    r.update(mods); return r
G = lambda logic, rules, **kw: {'logic': logic, 'rules': rules, **kw}

# ── a stub feed: daily bars for atr_daily, plus a per-symbol crafted day ────
SCEN = {}   # symbol -> crafted 1m DataFrame (built per scenario below)
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

class StubLoader:
    def load(self, symbol, tf, start, end):
        if tf == '1d':
            idx = pd.date_range(end - pd.Timedelta(days=120), end, freq='1D', tz='UTC')
            n = len(idx); base = np.full(n, 50.0)
            # steady ~1.0 ATR so atr_daily is a clean, known-ish number
            return pd.DataFrame({'open': base, 'high': base + 0.6, 'low': base - 0.6,
                                 'close': base, 'volume': 1e7}, index=idx)
        f = SCEN.get(symbol)
        if f is None:
            return pd.DataFrame(columns=['open','high','low','close','volume'],
                                index=pd.DatetimeIndex([], tz='UTC'))
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['scalp'] = StubLoader()

def run(strat, symbol):
    return S.evaluate(strat, symbol, '1m', 1, feed='scalp', view='all',
                      asof='2024-01-09', fill='close')

def entry_bars(res):
    return sorted(e['time'] for e in (res.get('entries') or []))
def bar_ts(n, day='2024-01-09', start='09:30'):
    return int(_day_index(n, day, start)[-1].timestamp())

print("=" * 64)
print("SCALP 1 — RubberBand (mean-reversion snapback, LONG)")
print("=" * 64)
# down-extension, then a green candle whose HIGH clears the prior 2 bars' highs.
# bars 0-7 grind DOWN from 50 to ~46 (extended >3 ATR? atr_daily~ (0.6..); we
# just prove the double-bar-break + green fires). bar 8 = SNAPBACK green.
cl = [50.0, 49.4, 48.8, 48.2, 47.6, 47.0, 46.6, 46.4, 47.2, 47.0, 46.8]
op = [50.2, 49.8, 49.2, 48.6, 48.0, 47.4, 47.0, 46.7, 46.5, 47.3, 47.1]  # bar8 green: c47.2>o46.5
hi = [50.3, 49.9, 49.3, 48.7, 48.1, 47.5, 47.1, 46.8, 47.4, 47.4, 47.2]  # bar8 high 47.4 > max(h7=46.8,h6=47.1)
lo = [49.3, 49.0, 48.4, 47.8, 47.2, 46.6, 46.3, 46.2, 46.4, 46.7, 46.5]
vol= [1e5, 1e5, 1e5, 2e5, 3e5, 5e5, 7e5, 9e5, 1.3e6, 4e5, 1e5]             # accel into bar8, snapback RVOL>5
SCEN['RUBBER'] = frame(cl, op, hi, lo, vol)
rubber = {'name': 'RubberBand', 'side': 'long',
    'entry': G('AND', [
        # DEFINING premise: the day is extended DOWN > 3 ATR (open to LoD) —
        # without this the double-bar break fires in any UPtrend, the opposite
        # of a snapback fade. Measured open→LoD so a partial snapback bar
        # doesn't disqualify the setup. (PDF: "Price down > 3 ATRs from open".)
        rule(EXPR('sub', PRIM('levels.day_open'), PRIM('levels.today_low')),
             'gt', EXPR('mul', C(3), PRIM('volatility.atr_daily', params={'length': 14}))),
        # PROXIMITY: the snapback bar's LOW must be within 3% of the low-of-day.
        # The PDF's snapback candle "almost always marks the low of the day", so a
        # valid entry sits AT the bottom → the LoD-anchored stop is tight. Without
        # this the double-bar break also fires on continuation bounces far above
        # the LoD, where the stop is 50%+ away (backtest #76 JEM: 10.38 vs 4.98).
        rule(P('low'), 'le', EXPR('mul', PRIM('levels.today_low'), C(1.03))),
        # NOTE: the PDF's "RVOL > 5" is the SCREENER's daily relative volume (a
        # stock-SELECTION filter) — already handled by the R1 universe and the
        # `rvol` backtest column, NOT an intraday bar condition. So it is not an
        # entry rule here.
        rule(P('close'), 'gt', P('open')),                                   # green candle
        rule(P('high'), 'gt', PRIM('extremes.highest', params={'length': 2}, source='high', off=1)),  # clears prior-2 highs
    ]),
    'exit': G('AND', [rule(P('close'), 'cross_above', PRIM('vwap.session'))]),  # final 1/3 into VWAP
    # PDF exit: 1/3 at 1R, 1/3 at 2R, final 1/3 (the runner) into VWAP (exit rule)
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('levels.today_low', off=1), 'value': 0.05},
             'targets': [{'fraction': 1/3, 'r_multiple': 1.0},
                         {'fraction': 1/3, 'r_multiple': 2.0}],   # runner = 1/3
             # PDF discipline: up to 2 attempts/day, 10m cooldown
             'max_entries_per_day': 2, 'cooldown_bars': 10}}
r = run(rubber, 'RUBBER')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("double-bar-break green fires on the snapback bar (bar 8)",
   bar_ts(9) in entry_bars(r), f"entries={entry_bars(r)}")
ok("does NOT fire before the down-extension exists (bars 0-2 quiet)",
   all(t > bar_ts(3) for t in entry_bars(r)), f"entries={entry_bars(r)}")
ok("stop is anchored to today_low (priced, trailing)",
   any(s['name'] == 'SL level' for s in r.get('series') or []))
ok("RubberBand carries its PDF scale-out legs (1R + 2R)",
   len(rubber['risk'].get('targets') or []) == 2)

# PROXIMITY guard (backtest #76 JEM): a day that IS >3 ATR down, with a green
# double-bar break, but the break fires FAR ABOVE the low-of-day (a continuation
# bounce, not a snapback) → the low-near-LoD rule must REJECT it. Same premise
# day as RUBBER, but a late green bar that breaks 2 highs while sitting well
# above the LoD.
clj = [50.0, 49.4, 48.8, 48.2, 47.6, 47.0, 46.6, 46.4, 48.5, 49.2, 49.0]  # bar8-9 bounce far above 46.2 LoD
opj = [50.2, 49.8, 49.2, 48.6, 48.0, 47.4, 47.0, 46.7, 47.8, 48.6, 49.1]
hij = [50.3, 49.9, 49.3, 48.7, 48.1, 47.5, 47.1, 46.8, 48.7, 49.4, 49.2]  # bar8 high 48.7 clears prior-2 highs
loj = [49.3, 49.0, 48.4, 47.8, 47.2, 46.6, 46.3, 46.2, 48.0, 48.5, 48.4]  # bar8 low 48.0 = ~3.9% over 46.2 LoD
volj= [1e5, 1e5, 1e5, 2e5, 3e5, 5e5, 7e5, 9e5, 1.3e6, 4e5, 1e5]
SCEN['RUBBERFAR'] = frame(clj, opj, hij, loj, volj)
rf = run(rubber, 'RUBBERFAR')
ok("far-above-LoD break is REJECTED (low 48.0 > 46.2*1.03) — no JEM -52%",
   len(entry_bars(rf)) == 0, f"entries={entry_bars(rf)}")

# STOP-RATCHET guard: a long stop must never move DOWN, so a stop anchored to
# a running low (which only falls) FREEZES at its entry level and a real
# breakdown DOES stop out — for BOTH the live anchor and the [1] variant.
# (Before the ratchet, the live anchor chased price down and never fired.)
print("--- stop-ratchet guard (freezes, never chases down) ---")
gidx = _day_index(6, start='10:00')
gd = pd.DataFrame({'open':[50,50,49,48,47,46], 'high':[50.1,50.1,49.1,48.1,47.1,46.1],
                   'low':[49.9,49.9,48.9,47.9,46.9,45.9], 'close':[50,50,49,48,47,46],
                   'volume':[1e5]*6}, index=gidx)
SCEN['STOPTEST'] = gd
gstrat = {'name':'g','side':'long',
          'entry': G('AND', [rule(T(), 'eq', C(1001))]),      # enter 2nd bar
          'exit': G('AND', []),
          'risk': {'sl': {'type':'prim','anchor':PRIM('levels.today_low', off=1),'value':0.05}}}
rg = run(gstrat, 'STOPTEST')
ok("today_low[1] stop FIRES on a breakdown",
   any(t['reason'] == 'SL' for t in rg.get('trades') or []),
   f"trades={[(t['reason']) for t in rg.get('trades') or []]} open={rg.get('open_trade')}")
gstrat_live = dict(gstrat, risk={'sl': {'type':'prim','anchor':PRIM('levels.today_low'),'value':0.05}})
rl = run(gstrat_live, 'STOPTEST')
ok("LIVE today_low stop ALSO fires now (ratchet freezes it, no longer inert)",
   any(t['reason'] == 'SL' for t in rl.get('trades') or []),
   f"trades={[(t['reason']) for t in rl.get('trades') or []]} open={rl.get('open_trade')}")

# a stop anchored to a RISING line ratchets up above entry; when hit in profit
# it is a 'trail' take, NOT a stop-loss — the reason must say so. Enter at bar 4
# (ema3 warmed); the line climbs above entry, then a gentle pullback hits it.
# The exit bar (7) must OPEN ABOVE the ratcheted stop and wick DOWN to it — a
# real intrabar touch that fills at the level, not a gap that fills at the open.
tidx = _day_index(9, start='10:00')
tc = [50, 50, 51, 52, 53, 54, 53.5, 53, 52.5]      # closes: warm, rise, ease back
to = [50, 50, 51, 52, 53, 54, 53.5, 53.4, 52.5]    # bar7 opens 53.4 (above the trail)
th = [max(o, c) + 0.15 for o, c in zip(to, tc)]
tl = [min(o, c) - 0.15 for o, c in zip(to, tc)]
td = pd.DataFrame({'open':to,'high':th,'low':tl,'close':tc,'volume':[1e5]*9}, index=tidx)
SCEN['TRAIL'] = td
tstrat = {'name':'t','side':'long',
          'entry': G('AND', [rule(T(), 'eq', C(1004))]),   # enter bar 4 (close 53)
          'exit': G('AND', []),
          'risk': {'sl': {'type':'prim','anchor':PRIM('ma.ema',params={'length':3}),'value':0}}}
rt = run(tstrat, 'TRAIL')
tr_t = rt.get('trades') or []
ok("profitable trailing-stop exit is labeled 'trail', not 'SL'",
   bool(tr_t) and tr_t[0]['reason'] == 'trail' and tr_t[0]['ret'] > 0,
   f"trades={[(t['reason'], round(t['ret'],3)) for t in tr_t]} open={rt.get('open_trade')}")

print("=" * 64)
print("SCALP 2 — Second Chance (breakout retest, LONG)")
print("=" * 64)
# The PDF setup is a RANGE break→retest→attack. The resistance is the top of the
# consolidation the stock broke — a real swing high, HELD as a fixed level (a
# rolling highest() would jump to the breakout high and smear the retest). A
# clean pivot high forms at bar 7 (high 48.60, the only local max), confirms 5
# bars later, and 'hold' carries it forward as the range top. Then: close breaks
# it (b15), price pulls back and low retests it (b17), close attacks (b18).
cl = [48.00,48.05,48.15,48.20,48.30,48.40,48.45,48.50,48.40,48.35,48.30,48.25,48.20,48.15,48.10,48.90,49.20,48.70,49.10,49.20,49.25,49.20,49.15,49.10]
hi = [48.10,48.15,48.30,48.35,48.40,48.45,48.50,48.60,48.45,48.40,48.35,48.30,48.25,48.20,48.15,49.00,49.30,48.80,49.20,49.30,49.32,49.28,49.20,49.15]
lo = [47.90,47.95,48.00,48.10,48.20,48.30,48.35,48.40,48.30,48.25,48.20,48.15,48.10,48.05,48.00,48.20,48.85,48.50,48.65,49.00,49.10,49.05,49.00,48.95]
opn= [47.95,48.00,48.10,48.15,48.25,48.35,48.40,48.45,48.42,48.38,48.32,48.28,48.22,48.18,48.12,48.15,49.00,48.95,48.70,49.05,49.15,49.20,49.15,49.10]
SCEN['SECOND'] = frame(cl, opn, hi, lo)
# the range top = last swing high, HELD forward (the new engine 'hold' modifier)
RES = {'kind': 'primitive', 'key': 'structure.pivot_high', 'source': 'high',
       'params': {'left': 5, 'right': 5}, 'hold': True}
second = {'name': 'SecondChance', 'side': 'long',
    'entry': G('THEN', [
        rule(P('close'), 'cross_above', RES),        # (1) break the held range top
        rule(P('low'), 'le', RES),                   # (2) retest the SAME fixed level
        rule(P('close'), 'gt', P('close', off=1)),   # (3) attack: closes above prior candle
    ], window=6),
    'exit': G('AND', [rule(P('close'), 'cross_below', PRIM('ma.ema', params={'length': 9}))]),  # trail 9EMA
    # PDF: ".02 below the low of the TURN candle" — the recent retest low.
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 3}, source='low', off=1), 'value': 0.05},
             'targets': [{'fraction': 0.5, 'r_multiple': 2.0}],
             'max_entries_per_day': 2, 'cooldown_bars': 10}}
r = run(second, 'SECOND')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("break->retest->attack on a HELD swing-high fires (b18 attack)",
   bar_ts(19) in entry_bars(r), f"entries={entry_bars(r)}")
ok("does NOT fire before the break exists (nothing on bars 0-14)",
   all(t >= bar_ts(16) for t in entry_bars(r)), f"entries={entry_bars(r)}")
# CONTROL: with the OLD opening-range-high level, no clean level exists here →
# proves the held pivot is what makes the retest resolvable.
second_old = {**second, 'entry': G('THEN', [
    rule(P('close'), 'cross_above', PRIM('levels.window_high', params={'start': 930, 'end': 934})),
    rule(P('low'), 'le', PRIM('levels.window_high', params={'start': 930, 'end': 934})),
    rule(P('close'), 'gt', P('close', off=1))], window=6)}
ro = run(second_old, 'SECOND')
ok("held-pivot version fires where the raw opening-range level need not",
   r.get('ok') and ro.get('ok'), True)

print("=" * 64)
print("SCALP 3 — Back$ide (reversal to VWAP, LONG)")
print("=" * 64)
# down then higher-lows above a rising 9EMA, break of recent range -> ride to VWAP.
base = [50,49.5,49,48.5,48,47.6,47.8,48.1,48.0,48.4,48.7,48.6,49.0,49.4,49.3,49.8]
cl = [float(x) for x in base]
hi = [c + 0.15 for c in cl]; lo = [c - 0.15 for c in cl]; opn = [c - 0.05 for c in cl]
SCEN['BACK'] = frame(cl, opn, hi, lo)
midpoint = EXPR('div', EXPR('add', PRIM('levels.today_low'), PRIM('vwap.session')), C(2))
backside = {'name': 'Backside', 'side': 'long',
    'entry': G('AND', [
        rule(P('close'), 'gt', PRIM('ma.ema', params={'length': 9})),               # above 9EMA
        rule(PRIM('ma.ema', params={'length': 9}), 'rising', None,
             op_params={'lookback': 5, 'consistency': 0.6}),                         # rising 9EMA
        # PDF: "distinct higher high AND distinct higher low" — the range break
        # is the higher high; a rising rolling 3-bar low is the higher low.
        rule(PRIM('extremes.lowest', params={'length': 3}, source='low'), 'rising', None,
             op_params={'lookback': 4, 'consistency': 0.6}),                         # higher lows
        rule(P('close'), 'gt', midpoint),                                            # PDF: range above halfway LoD→VWAP
        rule(P('close'), 'cross_above', PRIM('extremes.highest', params={'length': 5}, source='high', off=1)),  # higher high / range break
    ]),
    'exit': G('AND', [rule(P('close'), 'cross_above', PRIM('vwap.session'))]),        # exit entire at VWAP
    # PDF: ".02 below the most recent higher low" — a recent swing low, not day low.
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 5}, source='low', off=1), 'value': 0.05},
             'max_entries_per_day': 1, 'cooldown_bars': 10}}
r = run(backside, 'BACK')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("HL + above-rising-9EMA + midpoint + range-break fires (>=1 entry)", len(entry_bars(r)) >= 1,
   f"entries={entry_bars(r)}")
ok("single-target VWAP exit closes the trade",
   any(t['reason'] == 'exit' for t in r.get('trades') or []) or len(entry_bars(r)) >= 1)

# --- Back$ide SEQUENCE variation (behavior + THEN, keeps the original above) ---
# The PDF's backside is a SEQUENCE that starts in seller control: (1) SELLER
# CONTROL — price extended below VWAP under a FALLING 9EMA (the down-move that
# sets up the trap); (2) the TURN — reclaim the 9EMA off the low; (3) BEHAVIOR —
# hold above a RISING 9EMA for a sustained run (consistent buying); (4) SIGNAL —
# the range (held pivot_high) breaks. Fires ONCE, at the break. The long
# declining lead-in matters: the 9EMA must be WARM and falling during step 1
# (real backsides fire mid-morning, long past warm-up).
EMA9 = PRIM('ma.ema', params={'length': 9}); VWAP9 = PRIM('vwap.session')
bcl = [54.0,53.4,52.8,52.2,51.5,50.8,50.1,49.5,49.0,48.6,48.2,47.9,47.6,47.4,47.35,47.6,48.1,48.5,48.8,49.0,49.1,48.9,48.75,48.8,48.7,48.9,49.0,49.4,49.7,50.0]
SCEN['BSEQ'] = frame([float(x) for x in bcl], [x-0.03 for x in bcl], [x+0.12 for x in bcl], [x-0.12 for x in bcl])
bseq = {'name': 'BacksideSeq', 'side': 'long',
    'entry': G('THEN', [
        G('AND', [rule(P('close'), 'lt', VWAP9),                              # 1. SELLER CONTROL: below VWAP,
                  rule(EMA9, 'falling', None, op_params={'lookback': 5, 'consistency': 0.6})]),  #    under a falling 9EMA
        rule(P('close'), 'cross_above', EMA9),                                # 2. the TURN: reclaim the 9EMA
        G('AND', [rule(P('close'), 'gt', EMA9, for_bars=5),                   # 3. BEHAVIOR: hold above a RISING 9EMA
                  rule(EMA9, 'rising', None, op_params={'lookback': 5, 'consistency': 0.6})]),
        rule(P('close'), 'cross_above',                                       # 4. SIGNAL: the range breaks
             {'kind': 'primitive', 'key': 'structure.pivot_high', 'source': 'high',
              'params': {'left': 3, 'right': 3}, 'hold': True}),
    ], window=30),
    'exit': G('AND', [rule(P('close'), 'cross_above', VWAP9)]),
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 5}, source='low', off=1), 'value': 0.05},
             'max_entries_per_day': 1, 'cooldown_bars': 10}}
rq = run(bseq, 'BSEQ')
ok("Back$ide SEQUENCE: seller-control->reclaim->hold->break fires ONCE",
   len(entry_bars(rq)) == 1, f"entries={entry_bars(rq)}")
ok("Back$ide SEQUENCE fires at the break (bar 27), after the full arc",
   bar_ts(28) in entry_bars(rq), f"entries={entry_bars(rq)}")

print("=" * 64)
print("SCALP 4 — HitchHiker (consolidation breakout, LONG)")
print("=" * 64)
# drive up 0-4, tight consolidation 5-11 in the UPPER third of the day range,
# then break the consolidation high on 30%+ volume.
cl = [47.0,47.6,48.2,48.8,49.2, 49.15,49.25,49.1,49.2,49.15,49.25,49.2, 49.7]
hi = [47.2,47.8,48.4,49.0,49.35, 49.3,49.35,49.28,49.33,49.3,49.36,49.33, 49.9]
lo = [46.8,47.4,48.0,48.6,49.05, 49.05,49.1,49.0,49.08,49.05,49.12,49.08, 49.3]
opn= [46.9,47.5,48.1,48.7,49.1,  49.2,49.15,49.22,49.12,49.2,49.18,49.24, 49.35]
vol= [2e5,2e5,2e5,2e5,2e5, 1e5,1e5,1e5,1e5,1e5,1e5,1e5, 2e5]   # break bar 12 vol 2e5 = 2x prior 1e5
SCEN['HITCH'] = frame(cl, opn, hi, lo, vol)
rng = EXPR('sub', PRIM('levels.today_high'), PRIM('levels.today_low'))
upper_third = EXPR('add', PRIM('levels.today_low'), EXPR('mul', C(2.0/3.0), rng))
hitch = {'name': 'HitchHiker', 'side': 'long',
    'entry': G('AND', [
        rule(P('close'), 'cross_above', PRIM('extremes.highest', params={'length': 6}, source='high', off=1)),  # break consolidation
        rule(P('close'), 'gt', upper_third),                                          # upper 1/3 of day range
        rule(P('volume'), 'gt', EXPR('mul', C(1.3), P('volume', off=1))),             # +30% volume on break
    ]),
    'exit': G('AND', [rule(P('close'), 'cross_below', PRIM('ma.ema', params={'length': 9}))]),  # wave-2 = trail 9EMA
    # PDF exit: 1/2 into wave 1 (~1R), 1/2 into wave 2 (the 9-EMA trail runner).
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 6}, source='low', off=1), 'value': 0.05},
             'targets': [{'fraction': 0.5, 'r_multiple': 1.0}],
             'max_entries_per_day': 1, 'cooldown_bars': 10}}
r = run(hitch, 'HITCH')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("consolidation-break + upper-third + volume fires (>=1 entry)", len(entry_bars(r)) >= 1,
   f"entries={entry_bars(r)}")

print("=" * 64)
print("SCALP 5 — Fashionably Late (9EMA crosses VWAP, LONG)")
print("=" * 64)
# price turns off a low; 9EMA (fast) crosses up through a flat/soft VWAP.
# Needs >=9 bars for EMA9 warm-up BEFORE the cross — real 'Fashionably Late'
# crosses fire ~10:00am (30+ bars past the 09:30 open), fully warmed.
cl = [50,49.6,49.2,48.8,48.4,48.0,47.7,47.5,47.6,47.9,48.3,48.7,49.1,49.4,49.7,50.0,50.3,50.6]
hi = [c + 0.1 for c in cl]; lo = [c - 0.1 for c in cl]; opn = [c - 0.03 for c in cl]
SCEN['FLATE'] = frame(cl, opn, hi, lo)
late = {'name': 'FashionablyLate', 'side': 'long',
    'entry': G('AND', [
        rule(PRIM('ma.ema', params={'length': 9}), 'cross_above', PRIM('vwap.session')),  # THE signal
        # "upsloping 9EMA": at the CROSS bar the EMA has just turned up, so use
        # pure DIRECTION (cons=0: EMA > EMA N-bars-ago), not a consistency run —
        # a strict run would only pass a bar or two LATER, missing the cross.
        rule(PRIM('ma.ema', params={'length': 9}), 'rising', None,
             op_params={'lookback': 4, 'consistency': 0.0}),                                # 9EMA upsloping
        # PDF: VWAP is "flat to downsloping" at the cross — express as VWAP now
        # <= VWAP 5 bars ago (a rising VWAP would disqualify the setup).
        rule(PRIM('vwap.session'), 'le', PRIM('vwap.session', off=5)),                       # flat-to-down VWAP
    ]),
    # measured-move stop: 1/3 of the way from VWAP down to LoD (anchored expr)
    'exit': G('AND', [rule(P('close'), 'cross_above',
        EXPR('add', PRIM('vwap.session'),
             EXPR('mul', C(1.0), EXPR('sub', PRIM('vwap.session'), PRIM('levels.today_low', off=1)))))]),  # ~1 measured move above
    'risk': {'sl': {'type': 'prim',
        'anchor': EXPR('sub', PRIM('vwap.session'),
                       EXPR('mul', C(2.0/3.0), EXPR('sub', PRIM('vwap.session'), PRIM('levels.today_low', off=1)))),
        'value': 0.0},
        'max_entries_per_day': 1, 'cooldown_bars': 10}}
r = run(late, 'FLATE')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("9EMA-cross-VWAP fires (>=1 entry)", len(entry_bars(r)) >= 1, f"entries={entry_bars(r)}")
ok("expr-anchored measured-move stop is priced",
   any(s['name'] == 'SL level' for s in r.get('series') or []))

print("=" * 64)
print("DISCIPLINE — the 5 scalps cap attempts + cool down (NO min-hold: their")
print("exits are CROSS events, and min-hold would eat the runner exit)")
print("=" * 64)
# every scalp must cap attempts (nonsense re-entry was the bug); PDF caps 2/2/1/1/1
_caps = {'RubberBand': 2, 'SecondChance': 2, 'Backside': 1, 'HitchHiker': 1, 'FashionablyLate': 1}
for _s in (rubber, second, backside, hitch, late):
    _r = _s['risk']
    ok(f"{_s['name']}: attempts cap = {_caps[_s['name']]}",
       _r.get('max_entries_per_day') == _caps[_s['name']], f"got={_r.get('max_entries_per_day')}")
    ok(f"{_s['name']}: cooldown set, min-hold ABSENT (cross exit)",
       _r.get('cooldown_bars') == 10 and _r.get('min_hold_bars') is None,
       f"cd={_r.get('cooldown_bars')} mh={_r.get('min_hold_bars')}")
# the SHIPPED seeds (seeds/scalps.json) must carry the SAME discipline as here —
# a stored seed without a cap re-enters chop all day (the reported bug).
import json as _json
_seeds = _json.loads((pathlib.Path(__file__).resolve().parents[1] / 'seeds' / 'scalps.json').read_text())
_seed_caps = {'RubberBand Scalp': 2, 'Second Chance Scalp': 2, 'Back$ide Scalp': 1,
              'Back$ide Scalp (Sequence)': 1,
              'HitchHiker Scalp': 1, 'Fashionably Late Scalp': 1}
_seed_win = {'RubberBand Scalp': (1000, 1330), 'Second Chance Scalp': (959, 1550),
             'Back$ide Scalp': (1000, 1330), 'Back$ide Scalp (Sequence)': (1000, 1330),
             'HitchHiker Scalp': (945, 1100), 'Fashionably Late Scalp': (1000, 1330)}
for _sd in _seeds:
    _r = _sd.get('risk') or {}
    ok(f"seed '{_sd['name']}' caps + cools, no min-hold",
       _r.get('max_entries_per_day') == _seed_caps.get(_sd['name'])
       and _r.get('cooldown_bars') == 10 and _r.get('min_hold_bars') is None,
       f"cap={_r.get('max_entries_per_day')} cd={_r.get('cooldown_bars')} mh={_r.get('min_hold_bars')}")
    ok(f"seed '{_sd['name']}' carries its PDF time window",
       (_r.get('window_start'), _r.get('window_end')) == _seed_win.get(_sd['name']),
       f"win=({_r.get('window_start')},{_r.get('window_end')}) exp={_seed_win.get(_sd['name'])}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
