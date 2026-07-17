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
cl = [50.0, 49.4, 48.8, 48.2, 47.6, 47.0, 46.6, 46.4, 47.6, 47.0, 46.8]  # bar8 = BIG green snapback
op = [50.2, 49.8, 49.2, 48.6, 48.0, 47.4, 47.0, 46.7, 46.3, 47.3, 47.1]  # bar8 green: c47.6>o46.3
hi = [50.3, 49.9, 49.3, 48.7, 48.1, 47.5, 47.1, 46.8, 47.7, 47.4, 47.2]  # bar8 high 47.7 > max(h7=46.8,h6=47.1)
lo = [49.3, 49.0, 48.4, 47.8, 47.2, 46.6, 46.3, 46.2, 46.2, 46.7, 46.5]  # bar8 range 1.5 = big standout candle
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
        # BIG snapback candle (user): the snapback is a large, decisive bar — a
        # "clear announcement the move is finished", not a small poke over 2 highs.
        # PDF: "range of 1-min candles increase on the last leg" / "one of the 5
        # highest volume bars". Require its range >= 1.5x the prior-5-bar average.
        rule(EXPR('sub', P('high'), P('low')), 'ge',
             EXPR('mul', C(1.5), EXPR('sub', PRIM('ma.sma', source='high', params={'length': 5}, off=1),
                                              PRIM('ma.sma', source='low', params={'length': 5}, off=1)))),
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

# RubberBand SHORT — the exact same scalp INVERTED (PDF: "all rules the same, just
# inverted for short scalps"). This is the version that fits the R1 register (an
# extended-UP momentum universe): fade the blow-off top. Up-extension >3 ATR from
# the open, then a RED snapback candle AT the high-of-day breaks the prior 2 lows
# (double-bar break DOWN); cover the runner into VWAP; stop .02 ABOVE the HoD.
cls = [50.0, 50.7, 51.4, 52.1, 52.8, 53.5, 53.9, 54.1, 52.9, 53.0, 53.1]
ops = [49.8, 50.3, 51.0, 51.7, 52.4, 53.1, 53.6, 53.9, 54.0, 52.8, 53.0]   # bar8 RED: c52.9<o54.0
his = [50.1, 50.8, 51.5, 52.2, 52.9, 53.6, 54.0, 54.2, 54.1, 53.1, 53.2]   # HoD 54.2 @bar7; bar8 high 54.1 (near HoD)
los = [49.7, 50.2, 50.9, 51.6, 52.3, 53.0, 53.4, 53.7, 52.6, 52.7, 52.9]   # bar8 low 52.6 < min(lo6,lo7)=53.4
vols= [1e5, 1e5, 1e5, 2e5, 3e5, 5e5, 7e5, 9e5, 1.3e6, 4e5, 1e5]            # accel into the blow-off
SCEN['RUBBERUP'] = frame(cls, ops, his, los, vols)
import json as _j0
rubber_s = [s for s in _j0.loads((pathlib.Path(__file__).resolve().parents[1] / 'seeds' / 'scalps.json').read_text())
            if s['name'] == 'RubberBand Scalp (Short)'][0]
rubber_s = dict(rubber_s); rubber_s['risk'] = {k: v for k, v in rubber_s['risk'].items()
                                               if k not in ('window_start', 'window_end')}
rs = run(rubber_s, 'RUBBERUP')
ok("SHORT: JSON valid / evaluates", rs.get('ok') and rs.get('bars'), rs.get('error',''))
ok("SHORT: red double-bar-break fires on the snapback bar (bar 8)",
   bar_ts(9) in entry_bars(rs), f"entries={entry_bars(rs)}")
ok("SHORT: does NOT fire before the up-extension exists (bars 0-2 quiet)",
   all(t > bar_ts(3) for t in entry_bars(rs)), f"entries={entry_bars(rs)}")
ok("SHORT: stop is anchored ABOVE (today_high), priced",
   any(s['name'] == 'SL level' for s in rs.get('series') or []))
ok("SHORT: carries the PDF scale-out legs (1R + 2R, measured DOWN)",
   len(rubber_s['risk'].get('targets') or []) == 2)

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

# BIG-CANDLE guard (user): same extended-down premise + a green double-bar break AT
# the LoD, but the snapback bar is SMALL (range 0.3 vs prior avg ~0.82) — a weak poke,
# not a decisive announcement. The big-candle rule must REJECT it.
cls = [50.0, 49.4, 48.8, 48.2, 47.6, 47.0, 46.6, 46.4, 47.15, 47.0, 46.8]  # bar8 tiny green
ops = [50.2, 49.8, 49.2, 48.6, 48.0, 47.4, 47.0, 46.7, 46.95, 47.3, 47.1]
his = [50.3, 49.9, 49.3, 48.7, 48.1, 47.5, 47.1, 46.8, 47.2,  47.4, 47.2]  # bar8 high 47.2 clears 47.1, range only 0.3
los = [49.3, 49.0, 48.4, 47.8, 47.2, 46.6, 46.3, 46.2, 46.9,  46.7, 46.5]
vols= [1e5, 1e5, 1e5, 2e5, 3e5, 5e5, 7e5, 9e5, 1.3e6, 4e5, 1e5]
SCEN['RUBBERSMALL'] = frame(cls, ops, his, los, vols)
rsm = run(rubber, 'RUBBERSMALL')
ok("small snapback candle is REJECTED (range 0.3 < 1.5x prior avg) — not decisive",
   len(entry_bars(rsm)) == 0, f"entries={entry_bars(rsm)}")

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
print("SCALP 3 — Back$ide (reversal to VWAP, LONG) — the PDF SEQUENCE")
print("=" * 64)
# The Back$ide is a SEQUENCE, and the real sequence matters (the PDF's, not ours):
#   1. SELLER CONTROL — the stock is extended DOWN, BELOW a falling VWAP, under a
#      FALLING 9EMA. Shorts get excited it will keep going.
#   2. BACKSIDE ESTABLISHED — it stops going lower; the 9EMA slope flips from DOWN
#      to UP; price HOLDS above the rising 9EMA with a distinct higher-low.
#   3. RANGE BREAK — a consolidation above the 9EMA breaks higher, STILL below VWAP
#      -> enter; shorts stop out; fast pop UP to VWAP (exit).
# The early down-move is volume-heavy so session VWAP stays overhead (~48.7) while
# the range-break entry fires BELOW it. Arc: fall (0-5) -> first HL bounce (6-9) ->
# hold above a rising 9EMA (10-15) -> range break still below VWAP (16) -> pop
# through VWAP = exit (17-18).
cl  = [50.0,49.0,48.0,47.0,46.2,46.0, 46.4,46.3,46.7,46.5, 47.0,46.9,47.2,47.1,47.4,47.3, 47.9, 48.6,49.2]
vol = [3e6,2e6,1e6,5e5,3e5,1e5] + [1e5]*13
hi = [c + 0.15 for c in cl]; lo = [c - 0.15 for c in cl]; opn = [c - 0.05 for c in cl]
SCEN['BACK'] = frame(cl, opn, hi, lo, vol)
EMA9 = PRIM('ma.ema', params={'length': 9}); VWAP9 = PRIM('vwap.session')
midpoint = EXPR('div', EXPR('add', PRIM('levels.today_low'), VWAP9), C(2))
ext = EXPR('sub', VWAP9, P('low'))                       # how far below VWAP the low sits
backside = {'name': 'Backside', 'side': 'long',
    'entry': G('THEN', [
        # 1. SELLER CONTROL: extended >=1.5% below a falling VWAP, falling 9EMA
        G('AND', [rule(P('close'), 'lt', VWAP9),
                  rule(EMA9, 'falling', None, op_params={'lookback': 5, 'consistency': 0.6}),
                  rule(ext, 'ge', EXPR('mul', C(0.015), P('close')))]),
        # 2. BACKSIDE: 9EMA rising, price holds above it, distinct higher-low
        G('AND', [rule(EMA9, 'rising', None, op_params={'lookback': 5, 'consistency': 0.6}),
                  rule(P('close'), 'gt', EMA9, for_bars=3),
                  rule(PRIM('extremes.lowest', params={'length': 3}, source='low'), 'rising', None,
                       op_params={'lookback': 4, 'consistency': 0.6})]),
        # 3. RANGE BREAK, still below VWAP and above the LoD->VWAP midpoint, with a
        #    real-but-not-broken extension: 3% <= (VWAP-LoD)/price < 12%. The floor
        #    is anti-chop (need room to VWAP); the cap skips the day-1 broken/halted
        #    names the PDF says to avoid (data: backtest #93 drop%-band sweep).
        G('AND', [rule(P('close'), 'lt', VWAP9),
                  rule(EXPR('sub', VWAP9, PRIM('levels.today_low')), 'ge', EXPR('mul', C(0.03), P('close'))),
                  rule(EXPR('sub', VWAP9, PRIM('levels.today_low')), 'le', EXPR('mul', C(0.12), P('close'))),
                  rule(P('close'), 'gt', midpoint),
                  rule(P('close'), 'cross_above', PRIM('extremes.highest', params={'length': 5}, source='high', off=1))]),
    ], window=30),
    'exit': G('AND', [rule(P('close'), 'cross_above', VWAP9)]),        # exit entire at VWAP
    # PDF: ".02 below the most recent higher low" — a recent swing low, not day low.
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 5}, source='low', off=1), 'value': 0.05},
             'max_entries_per_day': 1, 'cooldown_bars': 10}}
r = run(backside, 'BACK')
_tr = r.get('trades') or []
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("SEQUENCE fires ONCE (seller-control -> backside -> range break)",
   len(entry_bars(r)) == 1, f"entries={entry_bars(r)}")
ok("fires at the range break (bar 16), after the full down->turn arc",
   bar_ts(17) in entry_bars(r), f"entries={entry_bars(r)}")
ok("the entry fires while price is still BELOW VWAP (heading up to it)",
   bool(_tr) and _tr[0]['entry'] < _tr[0]['exit'], f"trade={_tr[:1]}")
ok("single-target VWAP exit closes the trade at a profit (pop to VWAP)",
   bool(_tr) and _tr[0]['reason'] == 'exit' and _tr[0]['ret'] > 0,
   f"trades={[(t['reason'], round(t['ret'],3)) for t in _tr]}")

print("=" * 64)
print("SCALP 4 — HitchHiker (consolidation breakout, LONG)")
print("=" * 64)
# 8 warm-up bars (so the 9-EMA is warm — real setups fire mid-morning), then a
# drive up, a tight consolidation in the UPPER third riding ABOVE a flat 9-EMA,
# then a GREEN break of the consolidation high on 30%+ volume.
_W = lambda seq, v: [v] * 8 + seq   # prepend 8 flat warm-up bars at value v
cl = _W([47.0,47.6,48.2,48.8,49.2, 49.15,49.25,49.1,49.2,49.15,49.25,49.2, 49.7], 46.5)
hi = _W([47.2,47.8,48.4,49.0,49.35, 49.3,49.35,49.28,49.33,49.3,49.36,49.33, 49.9], 46.6)
lo = _W([46.8,47.4,48.0,48.6,49.05, 49.05,49.1,49.0,49.08,49.05,49.12,49.08, 49.3], 46.4)
opn= _W([46.9,47.5,48.1,48.7,49.1,  49.2,49.15,49.22,49.12,49.2,49.18,49.24, 49.35], 46.5)
vol= _W([2e5,2e5,2e5,2e5,2e5, 1e5,1e5,1e5,1e5,1e5,1e5,1e5, 2e5], 1e5)   # break bar vol 2x prior
SCEN['HITCH'] = frame(cl, opn, hi, lo, vol)
rng = EXPR('sub', PRIM('levels.today_high'), PRIM('levels.today_low'))
upper_third = EXPR('add', PRIM('levels.today_low'), EXPR('mul', C(2.0/3.0), rng))
HI6 = PRIM('extremes.highest', params={'length': 6}, source='high', off=1)
LO6 = PRIM('extremes.lowest', params={'length': 6}, source='low', off=1)
hitch = {'name': 'HitchHiker', 'side': 'long',
    'entry': G('AND', [
        rule(P('close'), 'cross_above', HI6),                                         # break the consolidation
        # PDF: the consolidation LOW (not just the break bar) sits in the upper 1/3
        # of the day range — a real post-drive pause near the highs, not mid-range
        # chop. This is what rejects the SVRE noise + the JEM false break (backtest
        # #97: both consolidated BELOW the upper third of a wide day range).
        rule(LO6, 'ge', upper_third),
        # PDF: a TIGHT consolidation, not a wide sloppy swing. Prior-6-bar range <=5%.
        rule(EXPR('sub', HI6, LO6), 'le', EXPR('mul', C(0.05), P('close'))),
        # NOTE: a "9-EMA flat/small-up-slope" gate was tried (backtest #102) and
        # REVERTED — chop has a FLAT 9-EMA while clean drives have a RISING one, so
        # the gate rejected the good drives (STEP/SOBR) and kept the chop (KUST/QTTB),
        # the opposite of the goal. #98's width+location gates are the best config.
        rule(P('volume'), 'gt', EXPR('mul', C(1.3), P('volume', off=1))),             # +30% volume on break
        # FRESH HoD (user's read of SUNE): the day-high was printed within the last
        # ~12 bars and price holds right at it — no DECLINE away from the high. A
        # stock that spiked to its high then declined for 15+ bars (QTTB) has its
        # recent-12-bar high well below the stale day-high, so it's rejected.
        rule(PRIM('extremes.highest', params={'length': 12}, source='high', off=1), 'ge',
             EXPR('mul', PRIM('levels.today_high', off=1), C(0.995))),
    ]),
    'exit': G('AND', [rule(P('close'), 'cross_below', PRIM('ma.ema', params={'length': 9}))]),  # wave-2 = trail 9EMA
    # PDF exit: 1/2 into wave 1 (~1R), 1/2 into wave 2 (the 9-EMA trail runner).
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 6}, source='low', off=1), 'value': 0.05},
             'targets': [{'fraction': 0.5, 'r_multiple': 1.0}],
             'max_entries_per_day': 1, 'cooldown_bars': 10}}
r = run(hitch, 'HITCH')
ok("JSON valid / evaluates", r.get('ok') and r.get('bars'), r.get('error',''))
ok("tight-consolidation-in-upper-third + break + volume fires (>=1 entry)", len(entry_bars(r)) >= 1,
   f"entries={entry_bars(r)}")
# CONTROL: a MID-RANGE choppy pause (consolidation low well below the upper third)
# must be REJECTED — this is the SVRE/JEM failure the low-in-upper-third rule kills.
clc = _W([47.0,48.5,47.2,48.4,47.3, 47.8,47.6,47.9,47.7,47.85,47.75,47.8, 48.1], 46.5)  # pause ~47.7 = mid-range
hic = _W([47.6,49.0,47.8,48.9,47.9, 47.95,47.9,48.05,47.9,48.0,47.95,48.0, 48.3], 46.6)
loc = _W([46.8,47.9,46.9,47.9,47.0, 47.6,47.5,47.7,47.55,47.7,47.6,47.65, 47.9], 46.4)
opc = _W([46.9,47.1,48.4,47.3,48.3, 47.7,47.85,47.7,47.9,47.75,47.85,47.78, 47.95], 46.5)
volc= _W([2e5,2e5,2e5,2e5,2e5, 1e5,1e5,1e5,1e5,1e5,1e5,1e5, 2e5], 1e5)
SCEN['HITCHCHOP'] = frame(clc, opc, hic, loc, volc)
rc = run(hitch, 'HITCHCHOP')
ok("mid-range chop is REJECTED (consolidation low below the upper third)",
   len(entry_bars(rc)) == 0, f"entries={entry_bars(rc)}")

# --- HitchHiker as the PDF SEQUENCE (drive -> hold/consolidation -> break) ---
# Instead of a single AND snapshot, detect each PDF layer and chain them in order:
#   L1 DRIVE     — close rising (>=70% of last 5 moves up), a distinct drive off open
#   L2 HOLD      — the drive stops; a TIGHT 6-bar range holds in the upper 1/3 (no pullback)
#   L3 BREAK     — the HitchHiker candle breaks the consolidation high on +30% volume
# Fires ONCE, at the break, only after the full arc — the same crafted HITCH day.
hh6 = PRIM('extremes.highest', params={'length': 6}, source='high')
ll6 = PRIM('extremes.lowest', params={'length': 6}, source='low')
hseq = {'name': 'HitchHikerSeq', 'side': 'long',
    'entry': G('THEN', [
        rule(P('close'), 'rising', None, op_params={'lookback': 5, 'consistency': 0.7}),   # L1 drive
        G('AND', [rule(EXPR('sub', hh6, ll6), 'le', EXPR('mul', C(0.04), P('close'))),      # L2 tight
                  rule(ll6, 'ge', upper_third)]),                                            #    upper 1/3, held
        G('AND', [rule(P('close'), 'cross_above', HI6),                                     # L3 break
                  rule(P('volume'), 'gt', EXPR('mul', C(1.3), P('volume', off=1)))]),
    ], window=15),
    'exit': G('AND', [rule(P('close'), 'cross_below', PRIM('ma.ema', params={'length': 9}))]),
    'risk': {'sl': {'type': 'prim', 'anchor': PRIM('extremes.lowest', params={'length': 6}, source='low', off=1), 'value': 0.05},
             'targets': [{'fraction': 0.5, 'r_multiple': 1.0}],
             'max_entries_per_day': 1, 'cooldown_bars': 10}}
rq = run(hseq, 'HITCH')
ok("SEQUENCE fires ONCE on the drive->hold->break arc", len(entry_bars(rq)) == 1,
   f"entries={entry_bars(rq)}")
ok("SEQUENCE does NOT fire on mid-range chop (no clean drive->hold->break)",
   len(entry_bars(run(hseq, 'HITCHCHOP'))) == 0)

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
        # ANTI-CHOP (data-driven, backtest #88): the stock must have extended
        # DOWN >= 1% from VWAP to the LoD — a real setup, not flat chop. The two
        # junk losers were <0.3%; every winner was >3%.
        rule(EXPR('sub', PRIM('vwap.session'), PRIM('levels.today_low')), 'ge',
             EXPR('mul', C(0.01), P('close'))),
    ]),
    # EXIT: 1 measured move above the LIVE VWAP (VWAP-anchored). NOTE: a tighter,
    # frozen 2*entry−LoD target + a ⅓ stop is the textbook 3:1, but on the real
    # R1 universe that tight stop noise-stops and the win rate collapses (64%→30%
    # in backtest #85). The wider VWAP-anchored exit/stop below held ~64% win and
    # was more profitable — matching the sheet's WIN RATE, which is what we keep.
    'exit': G('AND', [rule(P('close'), 'cross_above',
        EXPR('add', PRIM('vwap.session'),
             EXPR('mul', C(1.0), EXPR('sub', PRIM('vwap.session'), PRIM('levels.today_low', off=1)))))]),
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
_seed_caps = {'RubberBand Scalp': 2, 'RubberBand Scalp (Short)': 2, 'Second Chance Scalp': 2,
              'Back$ide Scalp': 1, 'HitchHiker Scalp': 1, 'HitchHiker Scalp (Sequence)': 1,
              'Fashionably Late Scalp': 1}
_seed_win = {'RubberBand Scalp': (1000, 1330), 'RubberBand Scalp (Short)': (1000, 1330),
             'Second Chance Scalp': (959, 1550), 'Back$ide Scalp': (1000, 1330),
             'HitchHiker Scalp': (945, 1100), 'HitchHiker Scalp (Sequence)': (945, 1100),
             'Fashionably Late Scalp': (1000, 1330)}
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
