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

### It.10 — TradingView-parity chart proficiency  [DONE]
- Audited our chart vs TradingView's core charting. Added the high-value gaps
  that lightweight-charts supports:
  * Chart TYPES: Candles / Bars / Line / Area / **Heikin Ashi** (HA computed
    client-side from OHLC). Switchable live; persisted.
  * Price-scale MODE: Linear / **Log** / **Percentage**. Persisted.
  * **Fit view** button (timeScale.fitContent).
  * Symbol **watermark** behind the chart.
  * Live updates + crosshair legend handle line/area (value) vs OHLC series.
- Already had: crosshair OHLC+indicator legend, volume pane, oscillator subpane,
  session shading, ET axis, real-time streaming, multi-indicator overlays,
  historical replay (asof), zoom/pan (built-in).
- Verified in headless: all 5 types switch with no errors; Log mode applies;
  Fit works; watermark = symbol.
- Honest remaining gap vs TV: freehand DRAWING TOOLS (trendlines/fib/rect) —
  lightweight-charts has no built-in drawing layer; that's a large custom build
  and low priority for a strategy-first platform. Noted, not built.

### It.11 — mobile layout + stop levels compressing candles  [DONE]
Looked at the phone screenshot + the layout code together. Three real issues:
- Header used flex-wrap → ~7 stacked rows on a phone (~550px tall), eating the
  chart's height. Fixed: on ≤820px the header is a single horizontally-scrollable
  row (~40px).
- #side was a fixed 260px column → on a ~390px phone the chart got ~140px wide.
  Fixed: on mobile #side is an absolute overlay DRAWER (chart always full-width
  underneath) with a ☰ Panel toggle; hidden by default on phones. Toggle also
  works on desktop to reclaim the 260px.
- BUG: overlay/level lines were on the price scale and DROVE autoscale, so a far
  level (R3, monthly, prev-year-open) stretched the scale and compressed the
  candles ("more levels → more pressed chart"). Fixed: price-scale overlays get
  autoscaleInfoProvider:()=>null — the CANDLES alone drive the price scale;
  overlays draw where they are (far ones simply sit off-screen; drag the price
  axis or Fit to see them).
- Verified in headless (390px viewport): panel hidden, chart width 390, header
  40px, toggle works; a level at 700 leaves the scale hugging the ~100 candles.

### It.12 — mobile panels: closeable + drag-resizable  [DONE]
Phone feedback: "I am able to open panels but it's difficult to close them; I
am also not able to move them up and down / left and right to change their
space on chart." Fixed both, looking at the layout code + behaviour together:
- CLOSE: the side panel now has an explicit ✕ button (#sideClose) and, on
  mobile, a tap-anywhere-outside backdrop (#sideBackdrop, shown only while the
  drawer is open via body.side-open). The ☰ toggle now open/closes symmetrically
  and keeps body.side-open in sync. So on a phone you dismiss the panel with the
  ✕ or by tapping the dimmed chart — no more trapped drawer.
- RESIZE: two drag grips (mouse + touch), each via one `_resizable` helper:
  * #sideGrip — the side panel's left edge → drag to set its WIDTH
    (180px … 92vw). Clears the mobile max-width cap so it can actually widen.
  * #drawerGrip — the strategy drawer's top handle bar → drag to set its
    HEIGHT (110px … 85vh). The chart re-applies its size after every drag so it
    always fills the remaining space.
- Verified in headless (390px viewport): side width 300 → 359 on a leftward
  drag; drawer height 328 → 448 on an upward drag; ✕ and backdrop both close;
  no JS errors.

### It.13 — mobile: operand controls were rendering OFF-SCREEN  [DONE]
Bug from the phone ("I select floor, nothing changed — check all similars, it's
a general problem"). Reproduced headlessly: selecting a multi-output primitive
(floor → P/R1/R2/… picker, plus its `session` param box) DID add the controls,
but they rendered at x≈296–343 while the Entry column on a 360px phone was only
x≈21–165 — i.e. the added controls overflowed the ~160px column and sat
off-screen to the side (inColumn:false). Root cause = two things stacking:
  1. the strategy drawer split into TWO ~160px columns (Entry | Exit) on a
     phone, halving the width;
  2. `.opd` (an operand's control cluster) was `inline-flex; nowrap`, so when
     its controls exceeded the column width they spilled sideways instead of
     wrapping.
Fix (CSS only, no logic change):
  - `@media(max-width:820px){ #drawer .dbody{ flex-direction:column } }` — on a
    phone the Entry/Exit groups stack, so every rule row gets the FULL width.
  - `.opd{ flex-wrap:wrap; max-width:100% }` — operand controls now wrap to the
    next line instead of overflowing off the edge (helps every viewport).
Verified headless at 360 + 412px: the R1/R2/S… picker is now inColumn:true &
inViewport:true; screenshot shows `Indicator floor · session · R2` all visible.
This affected EVERY multi-output primitive (dynamic_sr sr1…, bollinger
upper/lower, all pivots) and any primitive with extra params on a phone — the
"general problem" the user suspected.

### It.14 — audit multi-output pickers; dynamic_sr tracks max_levels  [DONE]
User: "check all primitives — e.g. bb upper/lower/middle; dynamic_sr depends on
number of SR levels." Audited all 5 multi-output primitives against what they
actually return:
- pivots.floor → P/R1/R2/R3/S1/S2/S3 (fixed 7) — picker correct.
- volatility.bb, volatility.bb_ema, vwap.stdev_bands → middle/upper/lower
  (fixed 3). The `mult`/σ param MOVES upper & lower, it doesn't change the
  count, so 3 lines is right — picker correct.
- levels.dynamic_sr → BUG: it returns sr1..sr{max_levels} (dict built from the
  `max_levels` param, 1..10), but the picker used the STATIC registry outputs
  (sr1..sr6). So with max_levels=3 you could pick sr5/sr6 → server error
  "dynamic_sr has no output 'sr5'"; with max_levels=8 the picker capped at sr6
  so sr7/sr8 were unreachable.
Fix (frontend only — qp math/registry untouched): `effectiveOutputs(op,m)`
derives sr1..sr{max_levels} for dynamic_sr from the operand's current param;
the picker uses it, re-renders when max_levels changes (that param now triggers
onStruct), and resets a stale `sub` that falls out of range.
Verified headless: floor=7, bb/stdev=3, dynamic_sr default=6, max_levels=3→3
lines, max_levels=8→8 lines; no JS errors.

### It.15 — logic proof, user bug batch, %-ops, anchored SL/TP, slope v2  [DONE]
Deep logic audit FIRST (82 hand-computed cases, engine must match exactly):
every operator, AND/OR/ATLEAST/THEN + nesting, offset/_shift, expr (÷0, nested),
time operand, for/within, bounce, edges, SL/TP pairing incl. same-bar SL-beats-TP,
sub-line selection, _merge_defaults → ALL PASS. Then the reported issues:
- FIXED (semantics): `cross_above/below + held for N` could NEVER fire — a
  cross is a 1-bar event, so "the cross held 3 bars" is impossible. Now it
  means what you meant: crossed, AND the crossed STATE (above/below) held on
  every bar since → fires once, N-1 bars after the cross. Verified incl.
  broke/re-cross cases and via evaluate() over a stub feed (32 fires vs 95
  plain crosses).
- VERIFIED NOT A BUG: offset/_shift + `close-open > atr_daily/N` — full e2e
  through evaluate() with a stub loader (1m+1d): 752 entries/4321 bars; the 🔍
  tester reports left/right live values. The likely on-phone culprit: the expr
  middle op DEFAULTS to − (minus); atr_daily−30000 ≈ −29995 makes `>` always
  true (one edge at bar 0) and `<` never true — matching the report exactly.
  Error text in the status line lengthened 90→160 chars.
- VERIFIED NOT A BUG: editing a saved strategy (load → change → Save keeps the
  same id, updates in place; survives page reload). Full UI roundtrip test.
- NEW operators: `above by ≥%` / `below by ≥%` (gt_pct/lt_pct): L ≥ R×(1+pct/100)
  — "meaningfully above", not just above.
- NEW: SL/TP "@ line" — anchor the stop/target to ANY operand (9-EMA, session
  VWAP, S2, window_low=premarket low, even an expr), optional % beyond; the
  level TRAILS the line bar by bar. Long → shifted below the line, short →
  above (protective side), automatic. Priority protocol unchanged & explicit:
  SL first (wins same-bar ties), then TP, then exit-rule. NaN warm-up bars
  can't trigger. Anchors count toward warm-up AND get drawn on Evaluate.
- Slope v2 (draft primitive, not part of the agreed 66): strength is now net
  modelled move ÷ RESIDUAL noise around the fitted line (ddof=2), capped ±99,
  default length 12, threshold 2.0. v1 saturated ~3.3 in any clean trend (steep
  == shallow) and false-fired ~17-19% in chop; v2: chop <10% fires at 2.0,
  steep ≫ shallow (median 47 vs 3), pure noise reads ~0.9.
- UI: bounce rows dim the left operand (a bounce reads the price BAR; only the
  right-side level matters) with an explanatory tooltip.
All 82+28 audit cases green; headless UI verification green (pct box, anchor
editor, save/reload/edit roundtrip, no JS errors).

### It.16 — status-check pairing, bounce v3, volume via composition  [DONE]
User feedback round 2:
- STATUS, not signal-fire: conditions are state checks. _pair_trades now enters
  while FLAT on any bar the entry condition IS true (so it re-enters after a
  stop-out while the setup still holds) and exits on any bar the exit condition
  IS true — the old edge-based exit MISSED an exit condition that was already
  true before entry (no flip → no exit, position stuck). Verified: always-true
  exit closes next bar; re-entry after SL; one-shot signal = one trade.
  Re-entry bars that aren't fresh edges now also get entry arrows.
- BOUNCE v3, closing the two holes the user called out:
  1. slice-through: a bar that OPENS on the wrong side of the level and closes
     across it is a CROSS, not a bounce → the bar's open must be on the
     original side too (prev_close guard kept).
  2. doji touch: close>prev_close alone let a long-wick hover count → the bar
     must close in the top `close_pos` (default 60%) of its OWN range for
     bounce_up (bottom 60% for bounce_down) — touch-and-GO. Exposed as `pos≥`
     in the rule row. Verified with explicit attack cases both directions.
  For extra confirmation compose: bounce THEN `high > high[1]` (the user's
  "exceeded previous high and held" idea) — no new primitive needed.
- VOLUME: no volume primitives were missing — volume conditions are COMPOSED
  per the basic-pieces rule: `Price volume > sma(source=volume, 20)` (relative
  volume), `volume > volume[1]` (rising volume) via offset, `volume.avg_volume`
  / `volume.rel_volume` for daily-baseline versions. Verified both compositions.
- NO-CONVERSION bridge: GET /api/strategies/{id} returns the exact stored JSON.
  Chart preview, Phase-4 backtest, and the trading tool all run the SAME JSON
  through the SAME evaluate() — there is no translation step to introduce
  errors. (The trading tool imports chart/strategy.py or calls the HTTP API.)
All audits green: 54 + 28 + 12 cases + stub-feed e2e.

### It.17 — volume always visible, SL/TP drawn as armed, order mapping  [DONE]
- VOLUME: the histogram existed but at 0.32 alpha squeezed into the bottom 14%
  under the candles it was invisible on a phone. Now a standard chart part:
  own band (bottom 20%), 0.55 alpha, and the LIVE tick updates it too (it
  didn't before).
- SL/TP LEVELS DRAWN: _pair_trades now records the ARMED level on every
  in-position bar (NaN while flat) and evaluate() returns them as dashed step
  series — red 'SL level', green 'TP level'. A fixed stop plots flat from the
  entry; an anchored one (@ line, e.g. 3% below the 9-MA) visibly TRAILS bar
  by bar. What you see is literally what the simulation used. Frontend now
  honors per-series line style (dashed).
- ORDER MAPPING (no-conflict protocol, documented for the trading tool):
  SL/TP are PRICE LEVELS -> broker bracket legs (stop + limit, OCO). Exit
  rules are CONDITIONS -> bot-side close (cancel remaining legs, then market
  out). Anchored SL/TP -> amend the resting stop/limit each bar. Priority is
  the same everywhere: SL first, then TP, then exit rule. SL/TP must NOT be
  modeled as condition groups: conditions evaluate on bar close, levels fill
  INTRABAR and live at the broker even if the bot dies.
Verified: 3 level-view cases + full 101-case regression + headless screenshot
(volume band, dashed SL/TP segments with axis labels, no JS errors).

### It.18 — Fable 5 ownership pass (full re-read, review, harden)  [DONE]
Read every line of strategy.py / server.py / store.py / data_manager.py /
the builder JS with fresh eyes, measuring each decision against the end
journey (backtest → broker orders). qp library untouched (approved/frozen).
BUGS FIXED (platform layer):
1. gt_pct/lt_pct broke on NEGATIVE references (slope, expr diffs): R×(1+p/100)
   moves the margin the wrong way when R<0 → now L ≥ R + |R|·pct/100.
2. ATLEAST with k≤0/blank made the group TRUE ON EVERY BAR (sum ≥ 0) → k
   clamped to ≥1.
3. UNPROTECTED ENTRIES: an SL configured but unpriceable at the entry bar
   (ATR warm-up NaN, anchored line not formed) entered with NO stop, silently.
   Now the entry is SKIPPED until the stop is priceable — live you'd never
   send an entry without knowing the stop, so the preview must not simulate
   one. (Blank SL value = SL off = explicit user choice, still enters.)
4. store embedded stale id/updated_at copies inside the strategy document on
   every load→edit→save cycle → meta keys stripped before persisting.
5. Empty-window responses missed keys the frontend touches (series/entry_now).
DESIGN CHANGED:
- OPEN POSITIONS are now first-class: a trade still holding at the window end
  is returned as open_trade (entry, time, unrealized %) and the UI shows
  "· 1 OPEN (+x%)" instead of the position silently not existing.
DELIBERATELY KEPT (with reasons):
- Fills at the signal bar's close (entry AND exit-rule exits). The standard
  optimistic-by-one-spread preview assumption; Phase 4 backtest will offer
  next-bar-open fills as a config, not a hidden change here.
- Live WS loop recomputes the full snapshot per tick — heavy but bounded
  (interval ≥5s, capped fetch window); an incremental tail computation is a
  Phase 4 optimization, not a correctness issue.
- 'N entry signals' counts fresh edges while trades count status entries, so
  trades can exceed signals after stop-out re-entries — intentional, the OPEN/
  trades readout makes it legible.
Suite now 120 hand-computed cases across 6 audit parts + stub-feed e2e — all
green. Server routes verified exception-wrapped end to end.

### It.19 — Trade operand: position-aware exits  [DONE]
User: "SL and TP conditions are very simple — I can't make 'exit if price is
2 ATR below MA or 1%' or 'break below 20MA OR exhaustion candle while moved
>2 daily ATR OR above R3'." Gap analysis:
- Example 2 and '2 ATR below MA' were ALREADY expressible (nested OR/AND +
  Expr; the SL anchor accepts an Expr like sma20 − atr14×2 → real intrabar
  trailing stop). Verified both with hand-computed cases.
- The REAL structural gap was 'or 1%': exit conditions couldn't see THE TRADE.
Added operand kind 'trade' (exit rules only): entry price / bars in trade /
P&L% (side-signed). Trade-aware exit groups are re-evaluated PER TRADE inside
the pairing loop, so each trade measures from its OWN entry — verified with a
re-entry case where trade 2's −1% baseline differs from trade 1's. Unlocks:
condition-based stops (P&L% ≤ −1), profit locks, TIME stops (bars ≥ N), and
any mix of those with indicator legs in one OR group. Guards: Trade in an
ENTRY rule raises a clear error; 🔍 tester explains it needs a live position.
exit_now for trade-aware exits is computed against the open position if one
exists. Suite: +11 cases (both user examples verbatim) → 131 total, all green;
UI roundtrip verified.

### It.20 — auto-rescale on symbol change  [DONE]
Bug: open SPY (~$700), drag/pinch the PRICE AXIS (lightweight-charts flips the
scale to MANUAL mode permanently), then switch to a $1 stock → the chart keeps
the old $700 range: candles off-screen, "empty space". Fix: drawSnapshot tracks
symbol|tf; when the instrument changes it restores autoScale on the right +
osc scales and fits the time scale (TradingView behavior). A same-symbol
redraw does NOT touch a manual zoom (your zoom survives Compute/params). The
⤢ Fit button now also restores price auto-scale — the manual escape hatch.
Verified headless: manual@700 → switch → autoScale true and $1 candles fill
the view; same-symbol redraw keeps manual; Fit restores. Screenshot proof.

### It.21 — Phase 4: backtest engine (steps 1-8, see PHASE4_PLAN.md)  [DONE]
Fill model ('close' preview vs 'next_open' honest live fills, 14 cases);
evaluate() exposes its trades so the backtester consumes the preview's exact
output; backtests + backtest_trades store; chart/backtest.py runner with
DAY-SLICE honesty (only day-D entries count for D), per-day register
membership (R1/Shortlist), open-vs-closed separation, summary with win rate /
total % / max drawdown / equity curve; API (POST /api/backtest + poll/list/
delete, one-at-a-time guard, spec validated before creating a row); 🧪
Backtest UI panel (saved strategy, symbols or register universe, date range,
fill selector, progress poll, summary + equity curve in the osc pane, trade
list where a click replays that chart as-of that day). +50 new hand-computed
cases across parts 9-11; suite total 215; ALL GREEN; headless UI smoke clean.

### It.22 — Trade The Pool preset: fees, min-profit, session rules  [DONE]
Researched TTP terms (site + reviews): $0.005/sh min $0.75/order; wins under
$0.10/share don't count toward the target (losses always do); auto-liquidation
starts 15:50 ET. Implemented: engine session masks (entry_ok = RTH only,
eod_close = forced flat on the last bar before 15:50, reason 'eod'; next_open
fills landing outside the window are dropped; pending exits can't leak across
days) — works with ALL-DAY charts so pre/post data still feeds indicators.
Backtester: shares + per-share fee with per-order minimum (round trip 2x,
open 1x), TTP block in summary (net $, COUNTED $ under the min-profit rule,
wasted-win count, fees $) + report KPI cards + UI preset (fills 0.005/0.75/
0.10/RTH+EOD/next_open; all editable). CSV gains pnl_ps ($/share). Also
pinned the user's ONE-POSITION invariant with explicit tests (repeated
signals ignored while holding; re-arm only after SL/TP/exit/eod). +17 cases
(part 12) — suite ALL GREEN.

### It.23 — loop it.2: PHASE-1 FOUNDATION BUG — higher-TF look-ahead  [DONE]
User widened the review loop to start from Phase 1 ("if phase 1 is wrong, 2
and 3 are wrong"). Fresh read of the data layer found exactly that class of
bug: daily bars are stamped at the day's START, so the at-or-before reindex
handed day D's COMPLETED daily value (full-day ATR range / volume) to D's own
09:31 bar. On the CHART this matches TradingView (their security() history
repaints identically — it is how atr_daily/avg_volume passed TV verification)
— but the strategy/backtest layer was reading tomorrow's newspaper: 'moved >
2 daily ATR' at 10:00 knew the day's final range. FIX: overlay_arrays gains
causal=True (strategy engine, SL-ATR, anchored levels, strategy-drawn lines);
when compute_tf is COARSER than the display tf the reindex shifts one src bar
→ intraday bars during D see D-1's completed value only. Finer compute TFs
(pine_5day 1m) stay unshifted (complete within the display bar at close
semantics). Chart overlay picker keeps TV-parity mode (approved look).
Hand-computed proof (part 13): D3 TR=5 vs D2 TR=1 → chart mode 5.0 at 09:30,
causal 1.0; avg_volume same law; engine + expr read causal; daily-on-daily
identical both modes. Suite ALL GREEN.

## FULL-TOOL REVIEW LOOP (finite patch list — no infinite loop)
Each patch: review → debug → fix → commit → report. Loop STOPS after the
final patch + one clean full pass. Check off as completed:
- [x] P1  Data-layer boundaries: vendor end-INCLUSIVITY leaked D+1's daily
      bar into asof=D replays (dailies are stamped midnight ET = the window
      end). prepare_bars + compute_tf fetch now cut strictly < end on
      replays; LIVE keeps the boundary (developing) bar. Tests part 14.
- [x] P2  data_manager + live WS: FOUND — alpaca-1m 7-day cap silently
      truncated multi-day warm-up (month VWAP!) → loud banner warning now
- [x] P3  Screener bridge: clean (4th pass — dates, latest fallback, R1
      _score vs Shortlist score mapping, error surfacing)
- [x] P4  Engine corners: eod supersedes same-bar next_open exit signal;
      fill landing ON the liquidation bar blocked (part 12 → 20 cases)
- [x] P5  Store+API: backtest-start double-POST race closed with a lock
- [x] P6  Frontend: smoke green at 390px + 900px (banner, error-samples
      toggle, builder, backtest panel), no JS errors
- [x] P7  FINAL: full suite ALL GREEN (250+ cases, 15 parts) — LOOP CLOSED.
      Next real work needs USER input: run backtests on real data and report
      anything that looks wrong; then the trading-tool bridge (Phase 5).

### It.24 — loop patch P1: asof replay boundary  [DONE]
Alpaca/Polygon treat `end` as inclusive; daily bars are stamped at midnight
ET; asof=D sets end = D+1 00:00 ET → historical replays could include D+1's
daily bar (the future) in daily displays AND in the compute_tf daily fetch.
Fix: on replays (ctx.asof), slice strictly before `end` in prepare_bars and
in overlay_arrays' HTF fetch; live keeps the boundary bar (the developing
candle is the point of live). Proven with a deliberately end-inclusive stub
loader stamping dailies at ET midnight (part 14, 7 cases). Suite ALL GREEN.

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

### It.25 — first real-data run (#16) diagnosed: coverage honesty  [DONE]
User ran "Vwap bounce" on register R1 (07/08→07/14, TTP rules, next_open)
and got 1 trade — rightly called it impossible. Root causes, all fixed:
1. SILENT no-data skips: a pair whose feed returns zero bars was neither an
   error nor counted anywhere. Alpaca (IEX) carries no bars for many small-cap
   gappers, so most of R1 could vanish without a trace. run() now counts
   evaluated / no-data (named samples) / signal / traded pairs, per-day pair
   counts, median bars → summary.coverage (part 15, 19 cases).
2. Backtest silently inherited the CHART's tf + feed selects (feed defaults
   to alpaca on first load, persisted before the server hint applies). The
   panel now has its own visible TF + feed selects; backtest feed defaults to
   the server's default_feed (polygon when keyed); '' normalizes server-side.
3. btRender wired the ⚠ errors tap handler BEFORE `innerHTML +=` appended the
   TTP line — re-parsing destroyed the listener, so the errors toggle was
   dead whenever a TTP block was shown. One innerHTML write, then wire.
UI shows: pairs count always + coverage line with tappable no-data list;
report shows coverage KPIs + a PARTIALLY-EVALUATED warning. Suite ALL GREEN
(16 parts). Headless smoke at 390/900px: toggles alive, no JS errors.

### It.26 — phantom signal ladders (stacked arrows at one bar)  [DONE]
User's SPY preview showed columns of identical entry/exit arrows at single
x-positions. Cause: required_days() EXTENDS the evaluate fetch for indicator
warm-up (pine_5day len 1950 on 1m: 5 requested days -> ~13, alpaca-capped 7),
so eval returned markers/series/trades on warm-up bars the chart never
displays — lightweight-charts snaps unknown marker times onto the nearest
bar it has, stacking them into ladders. Not real trades (one-position
invariant holds); a pure display lie. Fixed at three layers:
1. evaluate(): every output (markers, entries/exits, trades, series incl.
   SL/TP views, bar count, stats, first/last) sliced to the REQUESTED window;
   warm-up keeps feeding indicator values + position state carried in. A
   pre-window open position is still reported, just not drawn.
2. test_condition(): same slice — the fire-rate % now describes the bars the
   user is looking at, not invisible warm-up bars.
3. refreshMarkers(): drops any marker outside PRICEBARS' time range (belt &
   braces against any future bar-set mismatch).
Audit part 16 (17 cases) forces a 2->13-day extension and pins all of it.
Suite ALL GREEN (17 parts).

### It.27 — bounce v4: touch and confirmation may be different candles  [DONE]
User (SRXH 07/09, riding ema16): "our rule of bounce excludes very valid
bounce." True — v3 demanded ONE candle to touch the level, close back above
it, close above prev close AND close in the top 40% of its range. The most
common real bounce (weak hammer taps the MA, NEXT candle confirms) failed.
v4 adds `within` (op_param, default 1 = exact old behavior, UI 'win'):
the confirmation may come up to N-1 bars after the touch, provided no bar
in between CLOSES through the level beyond tol (spring wicks fine,
breakdowns kill it; a reclaim after a breakdown close is a CROSS, not a
bounce). Fires on the confirmation bar. All v3 guards intact: from-side +
open-side on the touch bar, wick tol, doji/close_pos on the confirm bar.
Part 3 +8 cases (two-bar shape, breakdown kill, window boundary, down
mirror); all old attack cases pass unchanged = within=1 equivalence.
Suite ALL GREEN (17 parts). Headless: 'win' input renders, stores op_params.

### It.28 — "loser in backtest, winner alone" investigated: replay mode  [DONE]
User: ZCMD 2026-07-07 shows -2.50% in backtest #22 but evaluating it alone
shows a winner. Investigated, not assumed:
1. Engine consistency PROVEN, not asserted: part 15 sec 4 pins bit-for-bit
   equality between a backtest row and evaluate() under the same settings
   (entry_ts, prices, ret, reason). No nondeterminism.
2. The real cause: the Evaluate preview runs close-fill with NO session
   rules; the backtest ran next-open fill + TTP rules. Hand-built case in
   the suite: identical signals are +1.000% at close fill and -1.176% at
   next-open (signal close 50.00, next open 51.00 spike). On 1m runners the
   fill model alone flips signs — that is the honesty it exists for.
3. Tool so the user can SEE it: tapping a backtest trade row now REPLAYS
   that run — loads the symbol as-of the trade date, switches tf/feed to the
   run's, loads the run's strategy, evaluates with the run's fill+rules, and
   labels the stat line 'backtest #N replay: next-open fill · session rules
   ON'. /api/strategy/evaluate accepts rules; EVALMODE tracks the mode and
   the stat line always names it; Clear signals resets to pure preview.
Suite ALL GREEN (17 parts, part 15 now 23 cases). Headless: tap injects
fill/rules/symbol/asof/tf into the evaluate request, label renders.
