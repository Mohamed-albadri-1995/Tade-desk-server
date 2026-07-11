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

### It.5 — operand editor exposes ALL primitive params  [DONE]
- The rule operand editor now renders an input for every param of the chosen
  primitive (int/float → number, bool → checkbox, str → text), not just the
  length-like one. So window start/end (power hour 1500–1600), BB mult,
  dynamic_sr min_strength/pivot_period, vwap anchor_offset, etc. are all
  settable inline. Verified in headless: window_high shows start/end, bb shows
  length+mult, power-hour values captured; no JS errors.
- This makes every primitive fully configurable inside a condition — the last
  piece for "as complex as needed" using only basic primitives.

### It.6 — drawing polish (marker declutter, side-aware)  [DONE]
- Entry markers are now clean arrows (no repeated "Long"/"Short" text) so a
  dense chart stays readable; the exit marker carries the reason label
  (SL/TP/exit). Markers are side-aware: short entries point down, exits up.

### It.7 — final regression sweep  [DONE]
- Full sweep: short strategy (down-arrow entries, exits {TP:2,exit:1}); ORB via
  window_high/low (4 entries, 2 trades); composed move-in-ATR expr (52 entries,
  indicator drawn). All clean, server boots, 69 primitives.

### It.8 — full review & debug pass  [DONE]
- Re-read the refactored compute_data/prepare_bars/overlay_arrays: clean, no
  dangling refs, compare-tool path intact.
- Ran a 12-case edge battery on the engine. Two real bugs found + fixed:
  1. `_shift` (bar offset) — offset ≥ series length produced a WRONG-LENGTH
     array (`arr[:-off]` overshoots) → broadcast crash on any big offset / short
     window. Now returns an all-NaN array of the correct length.
  2. `store.save_strategy` — used `db.total_changes` (cumulative since connect,
     never 0 after the first write) to detect a stale-id update → a save with a
     non-existent id silently returned None instead of inserting. Now uses the
     UPDATE statement's `cursor.rowcount`.
- Verified: offsets 1/119/120/1000 all length-safe; store insert/update/stale-id
  all correct; save/list/delete endpoints; full complex strategy renders +
  round-trips save/reload with no JS errors.

### It.9 — second review pass  [DONE]
- required_days re-reviewed: window_high start/end (930/945) correctly NOT
  misread as bar/session counts; per-TF caps hold. Clean.
- Live WebSocket path reviewed: PRICE.update / line.update / setMarkers all
  wrapped in try/catch (a stale/out-of-order tick degrades silently, never
  crashes). refreshMarkers builds a fresh sorted copy — no mutation.
- FIXED (UX/correctness): the operand editor always drew the input-`source`
  dropdown, even for bars-input primitives (VWAPs, pivots, candle*, window_*)
  that ignore it — a dead control (and vwma showed two source fields). Now
  gated on `inputs` containing 'source'. Verified: ema shows source, vwap/floor
  don't; no JS errors.
- Nothing else material. Engine, store, refactor, live, and UI all reviewed.

## Status: approaching exit door
Combining logic is fully general (nested groups · Expr arithmetic · offset ·
sustained · K-of-N · sequence · SL/TP · all params exposed). Inspection loop
solid (plot any primitive · 🔍 with live values · crosshair OHLC). Expressiveness
verified against 6 canonical strategies incl. ORB. No material bug remains in
the swept areas.
Open items that need the USER, not more building:
  1. Full Script 1 ("VWAP Cluster Bounce") — upload was truncated; need the
     entry logic to reproduce it 1:1.
  2. New draft primitives (trend.slope, levels.window_high/low) await your
     TradingView verification before approval.
As Opus 4.8: further changes from here are cosmetic/subjective or need your
input — so this is a natural stop unless you point me at something specific.
