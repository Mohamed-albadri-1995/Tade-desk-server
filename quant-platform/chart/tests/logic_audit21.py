"""Exit-side execution fidelity: frozen anchors + runner-scoped exit rule.

Backtest #126 (Second Chance, 78 trades, 29.5% win) exposed two execution
defects that live in the ENGINE's exit semantics, provable from the trade
math alone:

1. A prim-anchored leg TARGET is re-evaluated per bar. With a rolling anchor
   (highest(8,high)[1]) any new 8-bar high "reaches" the target a tick above
   entry — JEM 07/01 banked T1 at +0.79% while the runner ran +31%. The PDF's
   target ("the high of the initial pullback that set up the scalp") is a
   level FIXED before entry. → `freeze: true` on the tp spec evaluates the
   anchor ONCE at the signal bar.
2. A prim-anchored SL with a rolling anchor (lowest(3,low)[1]) ratchets up
   bar after bar — an unintended trailing stop. The PDF's stop (".02 below
   the low of the turn candle") is FIXED at entry. → `freeze: true` on sl.
3. The exit RULE closed the whole position from the entry bar (43 of 78 rows
   were ema9 scratches at a median 4-minute hold). The PDF's "Half and
   Trail" applies the 9-EMA close-below to the REMAINING ½ after the target
   banks. → exit `scope: "runner"` arms the rule only once a leg has banked.

PART A — frozen SL survives a pullback the ratcheting rolling low stops out.
PART B — frozen leg target fills AT the pre-entry spike; trailing control
         self-fills far below it.
PART C — runner-scoped exit ignores a pre-T1 exit signal, honors a post-T1 one.
PART D — the Second Chance seed carries the three fixes; frozen seeds do not.
"""
import sys, pathlib, json
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

def frame(cl, hi=None, lo=None, vol=None):
    cl = np.array(cl, float); n = len(cl)
    hi = np.array(hi, float) if hi is not None else cl + 0.05
    lo = np.array(lo, float) if lo is not None else cl - 0.05
    vol = np.array(vol, float) if vol is not None else np.full(n, 1e5)
    idx = pd.DatetimeIndex(
        [pd.Timestamp('2024-01-09 10:00', tz='America/New_York') + pd.Timedelta(minutes=i)
         for i in range(n)]).tz_convert('UTC')
    return pd.DataFrame({'open': np.r_[cl[0], cl[:-1]], 'high': hi,
                         'low': lo, 'close': cl, 'volume': vol}, index=idx)

def mask(n, *true_at):
    m = np.zeros(n, dtype=bool)
    for i in true_at: m[i] = True
    return m

print("=" * 64)
print("PART A — frozen prim SL: the turn-candle low does NOT trail up")
print("=" * 64)
# entry b4 @10.10; lowest(3,low)[1] there = 9.95. The grind up lifts the
# rolling 3-bar low to 10.25 by b8; the b8 pullback (low 10.15) tags the
# RATCHETED stop but sits far above the frozen turn-candle level.
ca = [10.00, 10.00, 10.00, 10.00, 10.10, 10.30, 10.60, 11.00, 10.70, 11.20, 11.40]
la = [9.95, 9.95, 9.95, 10.05, 10.05, 10.25, 10.55, 10.95, 10.15, 10.65, 11.35]
ba = frame(ca, lo=la)
risk_roll = {'sl': {'type': 'prim', 'value': 0.0,
                    'anchor': {'kind': 'primitive', 'key': 'extremes.lowest',
                               'source': 'low', 'params': {'length': 3}, 'offset': 1}}}
risk_frz = json.loads(json.dumps(risk_roll)); risk_frz['sl']['freeze'] = True
tr, slv, _, op = S._pair_trades(ba, list(range(11)), mask(11, 4), np.zeros(11, bool),
                                'long', risk_roll, None)
ok("control (rolling): ratcheted stop tags the b8 pullback in profit ('trail')",
   len(tr) == 1 and tr[0]['reason'] == 'trail' and tr[0]['xi'] == 8
   and abs(tr[0]['exit'] - 10.25) < 1e-9,
   f"tr={[(t['reason'], t['xi'], t['exit']) for t in tr]}")
trF, slvF, _, opF = S._pair_trades(ba, list(range(11)), mask(11, 4), np.zeros(11, bool),
                                   'long', risk_frz, None)
ok("frozen: stop stays at the entry-time 9.95 — the pullback is SURVIVED",
   len(trF) == 0 and opF is not None and opF['ret'] > 0.10,
   f"tr={trF} op={opF}")
ok("frozen: armed stop level drawn flat at 9.95 on the pullback bar",
   abs(slvF[8] - 9.95) < 1e-9, f"slv[8]={slvF[8]}")

print("=" * 64)
print("PART B — frozen leg target: fills AT the pre-entry spike high")
print("=" * 64)
# spike high 12.00 (b1 wick), entry b8 @10.60 (the 8-bar anchor is FORMED at
# the signal). Frozen highest(8,high)[1] = 12.00 → fills on b12 (high 12.10)
# AT 12.00. The trailing control loses the spike from its window by b10 and
# self-fills at 10.75 — the target slid BELOW the real prior high.
cb = [10.20, 10.40, 10.50, 10.45, 10.40, 10.35, 10.30, 10.25,
      10.60, 10.70, 10.90, 11.50, 11.90]
hb = [c + 0.05 for c in cb]; hb[1] = 12.00; hb[12] = 12.10
bb = frame(cb, hi=hb)
tgt_roll = {'targets': [{'fraction': 0.5, 'tp': {
    'type': 'prim', 'value': 0.0,
    'anchor': {'kind': 'primitive', 'key': 'extremes.highest',
               'source': 'high', 'params': {'length': 8}, 'offset': 1}}}]}
tgt_frz = json.loads(json.dumps(tgt_roll)); tgt_frz['targets'][0]['tp']['freeze'] = True
tr, _, _, op = S._pair_trades(bb, list(range(13)), mask(13, 8), np.zeros(13, bool),
                              'long', tgt_roll, None)
lg = (op or {}).get('legs') or []
ok("control (trailing): target slides DOWN off the spike, self-fills at 10.75 (b10)",
   len(lg) == 1 and lg[0]['xi'] == 10 and abs(lg[0]['price'] - 10.75) < 1e-9,
   f"legs={lg}")
trF, _, _, opF = S._pair_trades(bb, list(range(13)), mask(13, 8), np.zeros(13, bool),
                                'long', tgt_frz, None)
lgF = (opF or {}).get('legs') or []
ok("frozen: half banks AT the 12.00 spike (b12), +13.2% on the leg",
   len(lgF) == 1 and lgF[0]['xi'] == 12 and abs(lgF[0]['price'] - 12.00) < 1e-9
   and lgF[0]['ret'] > 0.13, f"legs={lgF}")

print("=" * 64)
print("PART C — exit scope 'runner': armed only after a leg banks")
print("=" * 64)
# entry b4 @10.00; exit signal (close<9.95) fires b5 PRE-target — must be
# ignored; T1 (frozen prim = the 10.50 spike) banks b7; the b8 signal then
# closes the runner. Without the scope the b5 signal scratches the trade.
cc = [9.80, 9.85, 9.90, 9.95, 10.00, 9.90, 10.20, 10.30, 9.90, 9.90]
hc = [c + 0.05 for c in cc]; hc[2] = 10.50; hc[7] = 10.55
bc = frame(cc, hi=hc)
em = np.array([c < 9.95 for c in cc])
risk_c = {'targets': [{'fraction': 0.5, 'tp': {
    'type': 'prim', 'value': 0.0, 'freeze': True,
    'anchor': {'kind': 'primitive', 'key': 'extremes.highest',
               'source': 'high', 'params': {'length': 4}, 'offset': 1}}}]}
tr, _, _, op = S._pair_trades(bc, list(range(10)), mask(10, 4), em,
                              'long', risk_c, None, exit_scope='runner')
ok("scoped: pre-T1 exit signal (b5) ignored, T1 banks b7, runner exits b8",
   len(tr) == 1 and tr[0]['reason'] == 'exit' and tr[0]['xi'] == 8
   and len(tr[0]['legs']) == 1 and abs(tr[0]['ret'] - 0.02) < 1e-3,
   f"tr={[(t['reason'], t['xi'], round(t['ret'], 4), len(t['legs'])) for t in tr]}")
trC, _, _, _ = S._pair_trades(bc, list(range(10)), mask(10, 4), em,
                              'long', risk_c, None)
ok("control (unscoped): the b5 signal scratches the whole position at -1%",
   len(trC) == 1 and trC[0]['reason'] == 'exit' and trC[0]['xi'] == 5
   and not trC[0]['legs'] and trC[0]['ret'] < 0,
   f"tr={[(t['reason'], t['xi'], round(t['ret'], 4)) for t in trC]}")
ok("_exit_now: runner-scoped exit reports False while no leg has banked",
   S._exit_now(em, False, {'logic': 'AND', 'rules': [], 'scope': 'runner'},
               {'entry': 10.0, 'ei': 4, 'legs': []}, 'long', bc, None) is False)

print("=" * 64)
print("PART E — wrong-side guard: a 'profit target' below the fill never banks")
print("=" * 64)
# Backtest #127: a violent attack bar gapped the next-open fill ABOVE the
# frozen pullback-high target (JEM: fill 7.58, target 7.08) — the engine
# banked the leg instantly at a LOSS and called it T1. 21 of 77 trades were
# poisoned this way (-25.8% actual vs -15.1% without the phantom fills).
# E1: frozen target below a gapped next_open fill → leg NOT armed, and with
#     scope 'runner' the exit rule manages the FULL position immediately.
ce = [10.00, 10.10, 10.20, 10.15, 10.40, 11.50, 11.30, 11.60, 10.90, 10.80]
be = frame(ce)
be.iloc[5, be.columns.get_loc('open')] = 11.40      # the gap: fill far above
eme = np.array([c < 11.0 for c in ce])              # runner trail stand-in
risk_e = {'targets': [{'fraction': 0.5, 'tp': {
    'type': 'prim', 'value': 0.0, 'freeze': True,
    'anchor': {'kind': 'primitive', 'key': 'extremes.highest',
               'source': 'high', 'params': {'length': 4}, 'offset': 1}}}]}
tr, _, _, op = S._pair_trades(be, list(range(10)), mask(10, 4), eme,
                              'long', risk_e, None, fill='next_open',
                              exit_scope='runner')
ok("gapped fill above the frozen target: NO leg banks, full position exits "
   "on the rule (fallback: no half to wait for)",
   len(tr) == 1 and not tr[0]['legs'] and tr[0]['reason'] == 'exit'
   and tr[0]['xi'] == 9 and tr[0]['ret'] < 0,
   f"tr={[(t['reason'], t['xi'], round(t['ret'], 4), len(t['legs'])) for t in tr]} op={op}")
# E2: a TRAILING leg whose rolling anchor sinks below the entry is skipped —
#     the old engine booked the sub-entry level as a 'target' fill.
cf = [10.20, 10.30, 10.40, 10.30, 9.80, 9.60, 9.90, 10.00]
bf = frame(cf)
risk_f = {'targets': [{'fraction': 0.5, 'tp': {
    'type': 'prim', 'value': 0.0,
    'anchor': {'kind': 'primitive', 'key': 'extremes.highest',
               'source': 'high', 'params': {'length': 3}, 'offset': 1}}}]}
trF2, _, _, opF2 = S._pair_trades(bf, list(range(8)), mask(8, 3), np.zeros(8, bool),
                                  'long', risk_f, None)
ok("trailing anchor sunk below entry: sub-entry level never fills as a leg",
   len(trF2) == 0 and opF2 is not None and not (opF2.get('legs') or []),
   f"tr={trF2} op={opF2}")

print("=" * 64)
print("PART D — seed drift: Second Chance carries the fixes, frozen seeds don't")
print("=" * 64)
seeds = {s['name']: s for s in json.load(
    open(pathlib.Path(__file__).resolve().parents[1] / 'seeds' / 'scalps.json'))}
sc = seeds['Second Chance Scalp']
ok("SC stop is frozen at the turn-candle low (freeze + abs .02)",
   sc['risk']['sl'].get('freeze') is True and sc['risk']['sl'].get('abs') == 0.02)
t1 = sc['risk']['targets'][0]['tp']
ok("SC half-target frozen, 13-bar lookback spans the full THEN window (6+6+1)",
   t1.get('freeze') is True and t1['anchor']['params']['length'] == 13,
   f"tp={t1}")
ok("SC exit rule scoped to the runner (PDF: trail 'the remaining ½')",
   sc['exit'].get('scope') == 'runner')
_s1 = sc['entry']['rules'][0]['rules']
ok("SC break step is cross+volume ONLY (capped-range rule REVERTED on #129 "
   "evidence — it blocked the JEM archetype; see SCALPS_SPEC provenance)",
   len(_s1) == 2, f"step1 has {len(_s1)} rules")
for nm in ('RubberBand Scalp', 'RubberBand Scalp (Short)', 'Back$ide Scalp',
           'Fashionably Late Scalp'):
    s = seeds[nm]
    ok(f"'{nm}' untouched: no freeze / no exit scope",
       not (s['risk'].get('sl') or {}).get('freeze')
       and not (s.get('exit') or {}).get('scope'))

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
