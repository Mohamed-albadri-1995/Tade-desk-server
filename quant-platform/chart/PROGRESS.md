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
