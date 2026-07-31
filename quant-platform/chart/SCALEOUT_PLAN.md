# Scale-out (partial exits) — build plan

Goal: model the PDF scalps' real exits — take a fraction off at a target, let
the rest run — in the BACKTEST engine, so win rate / R multiples become
comparable to the book. Live execution of the legs (bracket orders) stays in
the trading tool; MODELING them is this phase.

## Schema (backward compatible)
`risk` gains an optional `targets` list; `sl` (protective, ratcheting) and the
exit-rule/eod close whatever fraction remains. Existing single `tp` still works.

```
risk: {
  sl: {...},                 # protective stop on the REMAINING position (exists)
  targets: [                 # NEW ordered scale-out legs (optional)
    {fraction: 0.33, r_multiple: 1.0},   # take 1/3 at 1R (entry + 1×risk)
    {fraction: 0.33, r_multiple: 2.0},   # take 1/3 at 2R
    # remainder (1 - Σfraction) rides to SL / exit-rule / eod  (the "runner")
  ]
}
```
- `r_multiple` target = entry + R×(entry − initial_stop) for long (mirror short).
  Requires an SL (that's what defines 1R). Σfraction must be ≤ 1.
- Step 2 adds non-R triggers per leg (fixed pct / ATR / anchored line / at a
  price level) for "½ at the pullback high", wave exits, etc.

## Trade record
One trade per entry. `ret` = weighted total
`Σ(fraction_i·ret_i) + remaining·ret_final`. `exit`/`reason`/`xi` = the FINAL
close of the runner. New `legs: [{xi, price, fraction, ret, reason:'T1'…}]`
for the partials (drawn on the chart; the stored weighted `ret` keeps CSV /
summary correct).

## Intrabar convention (honest-conservative)
Each bar: check the SL on the remainder FIRST (worst-case fill), then fill any
target legs the bar reached, then the exit-rule/eod on what's left. So on a bar
that touches both the stop and a target, the stop wins (pessimistic). Documented;
a finer intrabar-path model can come later.

## Steps (commit + test each)
- [x] 1. Engine: R-multiple scale-out legs in _pair_trades + weighted return +
      leg records. Part 18 (16 hand-computed cases). No UI yet. Backward compat
      proven: no `targets` ⇒ byte-identical single-exit path (suite green).
- [x] 2. Engine: per-leg non-R triggers — fixed pct/atr/points + prim-anchored (trails). Over-banking clamp. Part 18 -> 25 cases.
- [x] 3. Surface: teal T1/T2 leg markers on the chart (evaluate); backtest summary counts scaleout_legs/trades; report shows a scale-out KPI. Part 18 -> 28 cases.
      show scale-out; CSV unchanged (weighted ret) + optional legs column.
- [x] 4. UI: scale-out targets editor (fraction + R×/%/ATR×/pts) in the builder header, live "% scaled / runner" readout, survives read+save. Headless verified.
- [x] 5. Seeds: RubberBand (1R+2R+VWAP runner), Second Chance (2R + 9EMA trail), HitchHiker (1R + 9EMA trail) carry PDF scale-out; Back$ide/Fashionably Late single-exit. Part 17 + SCALPS.md updated.
      re-run, compare to PDF win/R.

## STATE: ALL 5 STEPS DONE. Scale-out modeled end-to-end (engine, chart, report, UI, seeds). Next real work: user re-runs seeds on real data to compare vs PDF win/R.
