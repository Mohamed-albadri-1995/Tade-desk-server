# The 5 Pro Scalps — can the tool build them?

Source: `trades_.pdf` (RubberBand, Second Chance, Back$ide, HitchHiker,
Fashionably Late). This document (1) states each scalp in plain logical
language, (2) shows the exact builder conditions that express it, and (3)
marks the boundary between what the **signal engine** does and what the
**trading tool** does.

**Verdict: all 5 entries and their core exits build with the primitives that
already exist — no new primitives were added.** Every strategy here is
constructed as real strategy JSON and fires through the full `evaluate()`
path in the regression suite (`chart/tests/logic_audit17.py`, part 18). What
does *not* live in the signal engine is **scaling out** (thirds / halves /
waves) and **entry-frozen measured-move targets** — those are bracket-order
mechanics and belong to the trading tool (Phase 5). That is a deliberate
design line, not a missing feature: the engine holds one position and takes
one exit so that preview, backtest and live can never disagree.

Long side is shown throughout; every scalp inverts for shorts (swap
`gt`↔`lt`, `cross_above`↔`cross_below`, `bounce_up`↔`bounce_down`,
`today_low`↔`today_high`, and set Side = Short).

---

## 1. RubberBand — mean-reversion snapback (Side: Long)

**Idea.** Stock over-extends DOWN, selling gets sloppy, then snaps back.

**Logical rules**
- Entry: a **green candle** whose **high clears the highs of the prior 2
  candles** (the "double-bar break"), while the move is extended and volume
  is climbing.
- Stop: ~$0.02 below the **low of the day**.
- Exit: scale out — 1/3 at 1:1, 1/3 at 2:1, final 1/3 into **VWAP**.

**Builder (ENTRY, ALL match)**
| left | op | right |
|---|---|---|
| Expr `day_open − today_low` | `>` | Expr `3 × atr_daily` |
| Price `close` | `>` | Price `open` |
| Price `high` | `>` | `extremes.highest` len 2, source high, **[1] ago** |

The first row is the **defining premise** and ships in the seed: the day
must be extended DOWN by >3 ATR (open to low-of-day) — without it the
double-bar break fires in any uptrend, the opposite of a snapback fade.

The PDF's **"RVOL > 5"** is the SCREENER's daily relative volume — a
stock-**selection** filter, not an intraday bar condition. It is already
handled by trading only the R1 universe (these ARE the high-RVOL in-play
names) and is filterable in the backtest by the `rvol` column, so it is not
an entry rule. Time-of-day `hhmm` 1000–1330 is an optional filter you can add.

**Stop:** SL = anchored to `today_low`, small % beyond (the $0.02 becomes a
tiny %; the exact 2-cent offset is a bracket detail).

**Exit that lives in the engine:** `close crosses ▲ vwap.session` (the final
third into VWAP). → **The 1:1 and 2:1 partials are trading-tool bracket
legs.**

---

## 2. Second Chance — breakout retest, old resistance becomes support (Long)

**Logical rules**
- Break a resistance level, **retest** it from above, then a candle **closes
  above the prior candle** (buyers confirm).
- Stop: ~$0.02 below the low of the turn candle.
- Exit: half at the pullback high, trail the rest under the **9 EMA**.

**Builder (ENTRY, IN SEQUENCE / THEN, window ≈ 6 bars)**
| step | left | op | right |
|---|---|---|---|
| 1 break | Price `close` | `crosses ▲` | `structure.pivot_high` **(hold)** — the range top, held as a fixed level |
| 2 retest | Price `low` | `≤` | the **same** held `pivot_high` |
| 3 attack | Price `close` | `>` | Price `close` **[1] ago** |

The resistance is not a single arbitrary level but the **top of the range the
stock broke** — a real swing high (`structure.pivot_high`), **held** forward
(`"hold": true`) so it stays fixed through the retest. A rolling `highest(N)`
can't be used: after the break it jumps to the breakout high and smears the
retest. (The old seed used the first-4-min opening-range high — usually a tiny,
meaningless level; that produced the junk breaks in backtest #75.) `pm_high` /
`prev_day_high` are alternative fixed levels if you want a specific one.

**Stop:** the PDF says ".02 below the low of the **turn candle**" → anchored to
`extremes.lowest` len 3, source low (the recent retest low), not the day low.
**Exit in the engine:** `close crosses ▼ ema(9)` (the trail). → **The "sell
half at the pullback high" leg is a trading-tool bracket.**

The level is your choice of any real level primitive — that is exactly the
"old resistance becomes support" idea made concrete.

---

## 3. Back$ide — reversal back to VWAP (Long)

**Logical rules**
- After a low, price builds **higher lows above a rising 9 EMA**, then
  **breaks the recent range**; ride it to **VWAP**.
- Stop: ~$0.02 below the most recent higher low. One attempt.
- Exit: **entire** position at VWAP.

**Builder (ENTRY, ALL match)** — all 5 conditions ship in the seed
| left | op | right |
|---|---|---|
| Price `close` | `>` | `ema` len 9 |
| `ema` len 9 | `rising` | (upsloping 9EMA) |
| `extremes.lowest` len 3, source low | `rising` | **the "higher low"** |
| Price `close` | `>` | Expr `(today_low + vwap.session)/2` (range above the midpoint) |
| Price `close` | `crosses ▲` | `extremes.highest` len 5, source high, **[1] ago** (the "higher high"/range break) |

**Stop:** PDF says ".02 below the **most recent higher low**" → anchored to
`extremes.lowest` len 5, source low (a recent swing low), not the day low.
**Exit in the engine:** `close crosses ▲ vwap.session` — **fully expressible,
single target. This scalp maps 1:1.**

---

## 4. HitchHiker — consolidation breakout after an opening drive (Long)

**Logical rules**
- Drive up, then a tight **consolidation** (low in the upper 1/3 of the day
  range), then **break the consolidation high on +30% volume**.
- Stop: ~$0.02 below the consolidation low.
- Exit: waves — 1/2 into the first wave, 1/2 into the second.

**Builder (ENTRY, ALL match)**
| left | op | right |
|---|---|---|
| Price `close` | `crosses ▲` | `extremes.highest` len 6, source high, **[1] ago** |
| Price `close` | `>` | Expr: `today_low + (2/3)×(today_high − today_low)` |
| Price `volume` | `>` | Expr: `1.3 × volume [1] ago` |

Optional: consolidation above `pm_high` / `prev_day_high`; setup time
`hhmm < 959`.

**Stop:** anchored to `extremes.lowest` len 6, source low (the consolidation
low). **Exit in the engine:** `close crosses ▼ ema(9)` as a wave proxy. →
**The precise two-wave scale-out is a trading-tool concern.**

Note: "consolidation" is approximated as *break of the rolling N-bar high
while price sits in the upper third of the day's range* — a faithful,
mechanical stand-in for the visual pattern.

---

## 5. Fashionably Late — 9 EMA crosses VWAP (Long)

**Logical rules**
- Enter when an **upsloping 9 EMA crosses above a flat-to-down VWAP**.
- Stop: a **measured move** — 1/3 of the VWAP-to-LoD distance.
- Exit: 1 measured move above the cross.

**Builder (ENTRY, ALL match)** — all 3 conditions ship in the seed
| left | op | right |
|---|---|---|
| `ema` len 9 | `crosses ▲` | `vwap.session` |
| `ema` len 9 | `rising` | **cons≥ 0** (see lesson below) |
| `vwap.session` | `≤` | `vwap.session` **[5] ago** (VWAP flat-to-down, per the PDF) |

**Stop:** SL anchored to an Expr `vwap − (2/3)×(vwap − today_low)` (1/3 of the
way down from VWAP to the LoD). **Target:** the measured move (cross + (cross
− LoD)) is *frozen at entry*, so it is best placed as a bracket leg in the
trading tool; on the chart it is approximated with a VWAP-anchored Expr.

---

## Coverage summary

| Scalp | Entry logic | Engine exit | Trading-tool part |
|---|---|---|---|
| RubberBand | ✅ double-bar break + filters | ✅ VWAP | 1:1 & 2:1 partials |
| Second Chance | ✅ break→retest→attack (THEN) | ✅ 9EMA trail | sell-half leg |
| Back$ide | ✅ HL + rising 9EMA + range break | ✅ VWAP (1:1) | — |
| HitchHiker | ✅ range break + upper-⅓ + volume | ✅ 9EMA proxy | 2-wave scale-out |
| Fashionably Late | ✅ 9EMA×VWAP cross | ✅ measured-move approx | frozen MM target |

## Two lessons this validation surfaced (real, not test artifacts)

1. **`cross_above` + `rising`: use consistency 0 at the cross.** At the exact
   bar a fast MA crosses up through a slow line, the fast MA has *just*
   turned — it is higher than N bars ago (direction up) but has not been
   *consistently* rising for N bars. A strict `cons≥` run only passes a bar
   or two later and would miss the cross. Express "upsloping" as pure
   direction (`cons≥ 0`), or just let the cross imply the upslope.
2. **Warm-up before the signal.** `ema(9)` and `vwap.session` both anchor at
   09:30; an EMA-cross-VWAP is only meaningful after ~9+ bars. In real data
   these scalps fire mid-morning (10:00–10:45), long past warm-up, so this is
   never a problem live — but a preview window must include the bars before
   the cross (the engine already extends the fetch for warm-up and slices the
   display to your window).

## Scale-out exits (now modeled — the seeds carry them)

The engine models partial exits: `risk.targets` = ordered legs
`{fraction, r_multiple}` (or a fixed `tp`), the runner rides to SL/exit/eod,
and the return is size-weighted. The seeds ship their PDF exits:
- **RubberBand** — ⅓ at 1R, ⅓ at 2R, final ⅓ (runner) into VWAP.
- **Second Chance** — ½ at ~2R, trail the other ½ under the 9-EMA.
- **HitchHiker** — ½ at 1R (wave 1), trail ½ under the 9-EMA (wave 2).
- **Back$ide / Fashionably Late** — single exit (the PDF has no scale-out).

The chart draws a teal T1/T2 (…%) tick at each partial; the report shows how
many partials banked. Only LIVE execution of the legs (bracket orders) is
left for the trading tool.

## The remaining boundary → Phase 5 (live execution)

The engine is **one position, one exit**, on purpose (preview = backtest =
live, no drift). Every "scale out in thirds / halves / waves" and every
"measured-move target frozen at entry" is a **bracket-order** behavior. The
Phase 5 bridge maps a strategy's single entry + protective stop into the
trading tool, and layers the multi-leg profit-taking there:
- fixed SL/TP → bracket legs;
- anchored (trailing) SL → an amended stop that follows the line;
- engine exit rule (e.g. `close crosses ▼ ema9`) → cancel-and-close;
- **partial targets (1:1, 2:1, wave-1, wave-2) → additional take-profit legs
  defined on the trading-tool side**, since they never affect signal
  generation.

So: the tool can *build and backtest* all 5 scalps today (entry + stop +
primary exit). The scale-outs become bracket legs when we wire Phase 5.
