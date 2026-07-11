# Charting platform — autonomous hardening loop (Opus 4.8)

## Goal (accurate, self-set)
Make the qp charting platform's strategy builder able to express **arbitrarily
complex** strategies using **only basic irreducible primitives + maximally
flexible combining logic** — with correct calculations, correct drawing,
correct timeframe/session behavior, and a chart experience on par with
mainstream platforms. The verified qp library math is FROZEN (never touched);
all new power comes from composition and from the platform layer.

## Hard rules
- Do NOT modify the agreed qp primitive math. Only the platform (chart/, tools
  glue, builder engine) may change.
- No "convenience" primitives that are two existing primitives combined. If it's
  derivable, it must be built via combining logic (Expr / groups / operators).
- Every iteration: change → commit → note (here + to user) → re-verify → next.

## Exit door (so I don't loop forever)
Stop when ANY holds:
1. A full audit pass (calc / logic / drawing / chart / tf+session / expressiveness)
   surfaces no material bug and no high-value missing capability; OR
2. Remaining ideas are cosmetic / subjective only; OR
3. A blocker needs a user decision (e.g. truncated Script 1).
Then tell the user: "as Opus 4.8 I can't meaningfully do better — stopping."
Iteration budget target: ~10. Each must produce a real, verified improvement or
it doesn't count.

## Iteration log
(newest last)

### It.1 — Expr operand + remove reducible primitives  [DONE]
- Removed candle.body_pct / upper_wick_pct / lower_wick_pct (derivable). Kept
  trend.slope (irreducible). Registry back to 67 (66 agreed + slope).
- Added `expr` operand {kind:'expr', a, op:add|sub|mul|div, b}, recursive +
  offsettable + NaN/÷0-safe. Walkers recurse into a/b (warm-up + drawing).
- Tester returns left_now/right_now and draws composed expr values.
- Verified: body% via nested expr = 25.0; ÷0 → NaN; nested editor renders +
  save/reload roundtrips the shape; no JS errors.
- Result: any derived quantity (body%, wick%, move-in-ATR, distance-to-level,
  ratios) is now COMPOSED, per the "basic primitives + flexible logic" rule.

### It.2 — calculation & logic bug audit  [DONE]
- Kitchen-sink integration test (nested AND/OR, expr, offset, for_bars,
  ATLEAST, THEN, bounce, slope, SL/TP by ATR/%) → runs clean; exits split
  {exit,SL,TP} correctly.
- BUG FOUND + FIXED: a strategy with entry signals but no exit/SL/TP produced
  ZERO chart markers (markers came only from *closed* trades) — you'd think
  nothing fired. Now: mark every entry-condition edge + each taken trade's exit
  by reason. Frontend shows "N entry signals · M trades".
- HARDENING: _merge_defaults now drops params not in a primitive's signature,
  so a stale/extra key from an old saved strategy can't crash the call.
- Verified: entry-only strategy shows 17 markers = 17 signals; bogus param no
  longer crashes.

### It.3 — chart-view audit + live crosshair legend  [DONE]
- Added a TradingView-style **crosshair legend** (top-left): hover any bar →
  symbol + O/H/L/C coloured up/down + Volume + the value of every drawn
  indicator AND strategy line at that bar. Falls back to the last bar when not
  hovering. Directly serves "see the number".
- Overlay-load errors moved from the legend to the status line (⚠) so the
  legend stays clean for values.
- Verified in headless: legend renders "SPY O H L C V ema(9) …" from real
  series data; no JS errors.
- Remaining audit areas (next iterations): timeframe/session adaptability pass;
  strategy expressiveness vs known public strategies; drawing polish (marker
  density, price-line labels); then final sweep.

### It.4 — expressiveness stress test + opening-range primitive  [DONE]
- Encoded 6 known strategies as JSON and ran them: EMA-cross, VWAP-reclaim,
  RSI-reversion, inside-bar breakout, 3-red+rising-vol all express + evaluate
  cleanly. ORB was the gap — no "opening-range high", and today_high (running)
  can't work for it.
- Added basic irreducible primitives `levels.window_high` / `window_low`:
  high/low of an intraday ET window [start,end) in hhmm, default 930–945 (the
  opening range), FROZEN for the rest of the day; set 1500–1600 for power hour,
  etc. Not derivable from existing primitives → legit basic addition. 69 total.
- Verified: OR-high == max of the first-3-bars' highs and holds flat after; per
  ET-day reset in code.
- FOUND (next): the strategy operand editor only exposes ONE length-like param,
  so window start/end (and bb mult, dynamic_sr strength) can't be set inline —
  they fall back to defaults. Fix in It.5: expose ALL params of a primitive
  operand.
