# SCALPS_SPEC — the 5 SMB scalps, piece by piece from trades_.pdf

This is the complete, precise logic of each scalp: the market-participant story,
the exact rules, the SEQUENCE (phases in order), the quality factors (what makes
it better/worse), timing, and — critically — the MECHANIZATION MAP: for every
piece, where it lives (entry rule / risk block / screener / engine capability /
inherently discretionary). Seeds in `seeds/scalps.json` implement exactly this
document. When a piece cannot be expressed, the gap is named here and closed in
the engine or qp — never silently dropped.

Legend for the mechanization map:
- `RULE`      — an entry/exit rule in the strategy JSON
- `RISK`      — stop / targets / discipline in the risk block
- `SCREENER`  — a stock-selection property (R1 register), not a bar rule
- `MARKET`    — needs the market tape (SPY/QQQ) → cross-symbol operand
- `QP`        — needs a qp primitive that didn't exist (added, TV-verifiable)
- `DISC`      — inherently discretionary / post-hoc (named honestly, not faked)

---

## 1 · RubberBand — snapback of a sloppy, accelerating sell-off

### Participant story (WHY it works)
Sellers press an In-Play stock lower in a controlled grind. Then the seller
gets URGENT — the sell program rushes, execution turns sloppy, price cares
only about being done. That acceleration is unsustainable; when the sloppy
order ENDS, the rubber band SNAPS back. **It is not the extension that makes
the trade — it is the sloppiness of the acceleration.** We wait for the moment
it *can't* extend further and a distinct snapback announces the seller is done.
(All rules identical inverted for shorts.)

### The sequence (phases, in order)
1. **EXTENSION** — controlled grind down, price down > 3 ATR from the open.
2. **ACCELERATION** — the last leg down gets *sloppier*: 1-minute candle
   RANGE and VOLUME both increase vs the grind.
3. **SNAPBACK** — a SINGLE green candle at the low of day clears the highs of
   ≥2 preceding candles (the "double-bar break"). It is a BIG, decisive candle
   (range ≥ ~1.5× the prior bars) and one of the day's biggest volume bars.
   Enter immediately — do not wait for the close.

### Exact rules
- ENTRY: single green candle, high clears `highest(2 prior highs)`, at the LoD
  (snapback candle "almost always marks the low of the day").
- STOP: hard, `.02 below the low of day`.
- EXIT in thirds: 1/3 @ 1R · 1/3 @ 2R · final 1/3 into VWAP.
- DISCIPLINE: **2 strikes and out** (max 2 attempts/day).

### Quality factors
- Better: RVOL > 5 (In Play) · down >3 ATR from open · range+volume rising on
  the last leg · snapback bar among the day's top-5 volume bars.
- Worse: fresh negative news · day-1 break of a higher-TF range.
- AVOID: not extended from VWAP / no acceleration · **don't fade a cleanly
  down-trending market (SPY/QQQ/IWM steady downtrend = no rubber-band effect)**.
- Times: 10:00–10:45 · 10:45–13:30. Open (9:30–10) only if already higher-TF
  extended.
- Stats: 60–65 % win · 1.6:1.

### Mechanization map
| piece | where |
|---|---|
| down >3 ATR from open | QUALITY (demoted from RULE — PDF lists it under increase factors; funnel evidence LHSW 07/07: after a +277% overnight gap the 14-day ATR is denominated in the OLD price regime, so "3 ATRs" was true on ZERO bars of a 7.74→4.8 fade day while dropping it fires the 2 real snapbacks. The avoid clause "not extended from VWAP" stays covered by step 1's beyond-VWAP grind) |
| snapback AT the LoD | RULE `low ≤ today_low×1.03` |
| green double-bar break | RULE `close>open` + `high > highest(2,high)[1]` |
| BIG snapback candle | RULE `(high−low) ≥ 1.5×(sma(high,5)[1]−sma(low,5)[1])` |
| range accel on last leg | RULE (same avg-bar-range identity, recent vs earlier window) |
| top-of-day volume bar | QUALITY (demoted from RULE — the PDF lists it under increase factors, not entry; funnel evidence VEEE 07/14: on gap-up days the 9:30 bar dominates today_vol_max, so a 0.6×max proxy was near-unsatisfiable and far stricter than the PDF's "one of the 5 highest" rank wording) |
| RVOL > 5 | SCREENER (R1 `rvol` column; filterable in backtest) |
| stop .02 under LoD | RISK sl anchor `today_low[1]`, ratcheted |
| thirds 1R/2R/VWAP | RISK targets ⅓@1R ⅓@2R + EXIT rule `close cross_above vwap` |
| 2 strikes | RISK `max_entries_per_day: 2`, cooldown |
| times | RISK window 1000–1330 |
| don't fade trending market | MARKET `SPY close rising/falling` gate (cross-symbol) |
| day-1 higher-TF break | SCREENER (gap%, monthRangePos) — report filter |
| fresh negative news | DISC (catalyst text is in R1 ctx; human judgement) |

**Direction note:** R1 is an extended-UP universe → the LONG RubberBand is rare
on R1; the SHORT (identical, inverted: blow-off top, red snapback at HoD,
breaks 2 prior lows, covers into VWAP from above, stop over HoD) is the one
that fires. Both seeds exist. The short must ALSO respect "don't fade a cleanly
trending (up) market" — the VEEE lesson (#96): never short a day-1 raging
momentum name. Market gate + the same extension/acceleration prerequisites.

---

## 2 · Second Chance — break, retest, attack (old resistance → new support)

### Participant story
A range breaks; the first break "tests" everyone (hot-potato). The easier,
higher-probability trade is the SECOND chance: the pullback to the breakout
point shows whether higher-time-frame buyers are actually there. Old
resistance becomes new support — or the breakout fails and traps the longs.
It is a sniper's trade: wait, let the level prove itself.

### The sequence
1. **BREAK** — a candle CLOSES above a significant resistance level (the top
   of a real prior range — a held swing high, not a rolling max).
2. **RETEST** — price pulls back and touches the broken level (ideally on
   LOW volume — sellers show no urgency).
3. **ATTACK** — a candle closes above a prior candle at the level → enter.
4. **ABORT** — if price closes back INSIDE the range and does not recover on
   the next candle, the setup is dead. Never a 3rd attempt.

### Exact rules
- ENTRY: THEN-sequence 1→2→3 (window ~6 bars between steps).
- STOP: `.02 below the low of the TURN candle` (the retest low).
- EXIT: half at target = **the high of the initial pullback** (the breakout
  swing high); trail the rest until a 1-min close below the 9-EMA.
- DISCIPLINE: 2 strikes and out.

### Quality factors
- Better: significant level · high-volume break + low-volume retest · market
  moving WITH the trade.
- Worse: over-extended initial break (breakout move > prior range height) ·
  fighting the day's bigger trend.
- Times: 9:59–10:44 · 10:45–13:29 · 13:30–16:00 (all sessions).
- Stats: 50–55 % win · 1.9:1.

### Mechanization map
| piece | where |
|---|---|
| significant level | RULE held pivot `structure.pivot_high(5,5)` `hold:true` **+ LADDER rule** `heldPivot ≥ 0.97 × heldPivot[20]` on the break step. Derived from the USER'S CHART AUDIT of all 7 graded #128 trades: every loser crossed a level in a DESCENDING pivot staircase (NVVE 8.89→7.75, SHPH 4.45→4.24→4.06, KIDZ's slide, JEM's 09:57 post-crash lower-high, LHAI's spike-chase) — buying a lower-high inside a fade, the opposite of the book's "stocks that put in RANGES"; both winners (JEM 12:17, PMA 10:59) broke a flat-to-rising ladder. The 3 % tolerance lets a flat range's pivots wiggle; a real fade ladder drops far more over 20 minutes |
| break = CLOSE above | RULE `close cross_above heldPivot` |
| retest touches level | RULE `low ≤ heldPivot` (THEN step 2) |
| attack closes above prior | RULE `close > close[1]` (THEN step 3) |
| low-volume retest | RULE `volume < sma(volume,5)` on the retest step |
| high-volume break | RULE `volume > 1.3×sma(volume,5)` on the break step |
| abort/no 3rd try | THEN window expiry + RISK `max_entries_per_day: 2` |
| stop under turn candle | RISK sl anchor `lowest(3,low)[1]` **frozen at entry** (`freeze:true` — the book's stop is a FIXED level; a rolling low ratchets into an unintended trailing stop) |
| half at pullback high | RISK target `{type:prim, anchor: highest(13,high)[1], fraction:0.5, freeze:true}` — frozen at the signal bar. 13 spans the whole THEN window (6+6+attack) back to the break bar, so the post-break spike can't slide out of the lookback; unfrozen it self-fills on any new N-bar high (#126: JEM banked T1 at +0.79 % while the runner ran +31 %) |
| trail 9-EMA (the REMAINING ½ only) | EXIT rule `close cross_below ema(9)` with `scope:"runner"` — armed only after the half banks. Book: "Trail our stop for the remaining ½". Unscoped it scratched full positions at a median 4-min hold (43 of 78 rows in #126) |
| market WITH the trade | MARKET SPY gate |
| over-extended break | RULE breakout leg ≤ prior range height (expr on highest/lowest) |
| times | RISK window 959–1550 |

Status: **NOT validated.** Backtest #126 (07/01–07/18 R1, 1m): 78 trades,
29.5 % win, payoff 1.55:1, −12.3 % (−28 % without JEM's single runner) vs the
sheet's 50–55 % / 1.9:1. The CSV's leg math isolated two EXECUTION defects
(self-filling rolling target, whole-position ema9 scratches — both fixed via
`freeze` + `scope:"runner"`, see the map above).
Backtest #127 (same window, exits fixed): 77 trades, 39 % win, −25.8 % —
worse in total because the freeze EXPOSED a third execution defect: a violent
attack bar gaps the next-open fill ABOVE the frozen pullback-high target
(JEM: fill 7.58 vs target 7.08), and the engine banked the sub-entry level as
an instant "T1" loss. Leg-math reconstruction: 21 of 77 trades poisoned;
−25.8 % actual vs −15.1 % with those phantom fills removed. Fixed by the
WRONG-SIDE GUARD (a target leg must be beyond the fill; if no leg arms, the
runner-scoped exit manages the full position from entry).
Backtest #128 (same window, guard live): 77 trades, 37.7 % win, −16.7 %,
payoff 1.12:1 — leg-math audit found ZERO phantom fills and the total landed
on the #127 reconstruction (−15.1 %), so the EXECUTION LAYER IS VERIFIED
CLEAN (stops avg −2.4 %, exit bucket net +17.6 %). The remaining deficit vs
the sheet (50–55 % / 1.9:1) is the ENTRY: 402 raw signals, attacks at
insignificant levels feeding the stops.
Backtest #129 tested the capped-range entry rule and FAILED it (see the
provenance row) — the rule was reverted; the seed is back to the #128 state.
VISUAL PATTERN AUDIT (the protocol's "user confirms geometry" step): the
user charted all 7 graded #128 trades. Finding — the detector cannot tell
the flat top of a RANGE from a LOWER HIGH in a decline; every loser bought a
descending pivot ladder, both winners broke a flat/rising one; the 2/day cap
maxes on nearly every symbol and the two entries are usually unrelated
levels (the book's "2 strikes" means the SAME level). This produced the
LADDER rule (see the map) — a CHART-derived fidelity fix, not a
backtest-delta tune.
PRE-REGISTERED PREDICTIONS for the validation run (#130) — the rule is
judged on these, decided BEFORE running: MUST KEEP JEM 07/01 12:17 (+16.4 %)
and PMA 07/10 10:59 (+4.6 %); MUST DROP JEM 07/01 09:57 (−5.7 %), NVVE
07/09 10:11 (−6.0 %), SHPH 07/14 10:35 (−2.8 %), LHAI 07/02 11:57 (−5.7 %);
KIDZ 07/07 12:26 (−3.5 %) is EXPECTED TO SURVIVE and lose (its ladder had
recovered — an honest miss). Watch the cap/cooldown shift side-effect: count
NEW entries that appear and their P&L before crediting the rule. If JEM
12:17 disappears, the rule is wrong — revert immediately, no debate.
Side observation (report filter only, NOT a seed change — pattern held in
ALL THREE runs, same as RubberBand Long): #128 rvol≥5 → 43 % win vs 21 %
below; #129 rvol≥5 → 46 % win vs 27 % below. The book's "In Play RVOL>5"
screener factor keeps showing up.

---

## 3 · Back$ide — the reversal grind back up to VWAP

### Participant story
The stock extends DOWN away from VWAP; shorts are excited for more. It stops
going lower. Buyers walk it back up with a distinct HIGHER HIGH (≥1) and
HIGHER LOW (≥1) — a new trend. Shorts turn hopeful, then FEARFUL. During this
rising phase price rides **above a RISING 9-EMA** (VWAP itself is overhead —
falling-to-flat, never rising). A range forms above the 9-EMA; when it breaks
higher, shorts stop out → fast, powerful pop INTO VWAP. Exit there. One shot.

### The sequence
1. **SELLER CONTROL** — extended ≥1.5 % below a falling VWAP, falling 9-EMA.
2. **BACKSIDE ESTABLISHED** — 9-EMA slope flips up; price HOLDS above it
   (majority of trading above the 9-EMA); a distinct higher-low prints.
3. **RANGE BREAK** — consolidation high breaks while price is STILL below
   VWAP, above the midpoint of LoD→VWAP. Enter on the break.

### Exact rules
- ENTRY: THEN 1→2→3 (window ~30).
- STOP: `.02 below the most recent higher low`. ONE AND DONE.
- EXIT: entire position at VWAP.

### Quality factors
- Better: consistent (non-erratic) price action off the LoD · majority of
  trading above the 9-EMA after the turn · confusing catalyst.
- Worse: market trending against · range below the LoD→VWAP midpoint.
- AVOID: stock in a day-1 breakdown of a higher-TF range.
- Times: 10:00–10:45 · 10:46–13:30. Stats: 50–60 % win · 1.4:1.

### Mechanization map
| piece | where |
|---|---|
| extension below falling VWAP | RULE `(vwap − low) ≥ 1.5%×close` + `close<vwap` + falling 9-EMA |
| 9-EMA turn + hold | RULE `ema9 rising` + `close>ema9 for_bars 3` |
| distinct higher low | RULE `lowest(3,low) rising` |
| still below VWAP, above midpoint | RULE `close<vwap` + `close>(LoD+vwap)/2` |
| range break | RULE `close cross_above highest(5,high)[1]` |
| extension band (validated #93/#94: skip broken names + chop) | RULE `3% ≤ (vwap−LoD)/price < 12%` |
| stop under higher low | RISK sl `lowest(5,low)[1]` |
| exit at VWAP | EXIT `close cross_above vwap` |
| one and done | RISK `max_entries_per_day: 1` |
| market against | MARKET SPY gate |
| day-1 breakdown avoid | the 12 % extension cap (validated proxy) + SCREENER |

Status: **validated** at 44 % win / +4.9 % / payoff 1.55:1 (backtest #94) —
at the PDF's 1.4:1 R:R. Locked pending more data.

---

## 4 · HitchHiker — ride a real institutional buy program

### Participant story
A distinct drive off the open that does NOT get faded: instead of pulling
back, price holds up and goes SIDEWAYS. That refusal to pull back is unusual —
it is a large, price-insensitive institutional order that NEEDS to fill. Real
buy programs run for hours; the consolidation break lets us hitch a ride.

### The sequence
1. **DRIVE** — a distinct, sustained drive (a real move, not one big candle).
2. **CONSOLIDATION** — price STOPS MAKING HIGHER HIGHS (the peak is behind
   it); a tight box [LL,HH] is respected for ≥3–4 bars (5–20 min); the box
   LOW sits in the upper 1/3 of the day's range; bars are orderly, not wicky.
3. **BREAK** — one good candle breaks AND CLOSES above the box high on
   volume ≥ +30 % vs the prior bar (the "HitchHiker Candle").

### Exact rules
- ENTRY: THEN 1→2→3 (window ~20).
- STOP: `.02 below the consolidation low`. ONE AND DONE.
- EXIT in waves: 1/2 when the first rush slows (~1R) · 1/2 on the second wave
  (trail: 1-min close below the 9-EMA).
- ⚠ PENDING for HH's own validation pass: the same exit-fidelity questions
  #126 exposed on Second Chance apply here structurally — the sl anchor
  `lowest(5)[1]` is rolling (should likely be `freeze:true` = the fixed
  consolidation low) and the ema9 trail is unscoped (book trails the second
  half). Apply only WITH HH backtest evidence, one pass, not preemptively.

### Quality factors
- Better: +30 % volume on break · market/sector trending up · consolidation
  above a key level (premarket high / prior-day high).
- Worse: over-extension (ONE big candle instead of a drive) · multiple upside
  attempts before the consolidation · fighting the day trend.
- AVOID: choppy consolidation (large wicks both ways, no defined range).
- Times: opening drive — sets up before ~9:59. Stats: 55–60 % win · 1.9:1.

### Mechanization map
| piece | where |
|---|---|
| real drive (not 1 candle) | RULE `close rising(5, 0.7)` + `close ≥ 1.04×lowest(12,low)` |
| stopped making HH | RULE `highest(3,high) < 0.998×highest(8,high)` ← the proven detector |
| tight respected box | RULE `(highest(5,high)−lowest(5,low)) ≤ 3%×close` |
| box low upper 1/3 | RULE `lowest(5,low) ≥ LoD + ⅔(HoD−LoD)` |
| break + close above | RULE `close cross_above highest(8,high)[1]` + `close>open` |
| +30 % volume | RULE `volume > 1.3×volume[1]` |
| stop under box low | RISK sl `lowest(5,low)[1]` |
| waves exit | RISK target ½@1R + EXIT `close cross_below ema(9)` |
| one and done | RISK `max_entries_per_day: 1`, window 945–1100 |
| market/sector up | MARKET SPY gate · SCREENER secBias |
| above PM/prior-day high | RULE optional: `lowest(5,low) ≥ pm_high` (quality tier) |
| "program keeps running" | DISC — confirmed only after entry; cannot be gated |

Honest status: hardest to mechanize (1 confirmed real setup — SUNE — in 2.5
weeks of R1; every extra gate we tested either dropped SUNE or kept the noise).
The stopped-making-HH consolidation detector is the best-proven core. The
detector was proven in ISOLATION against clean-box / drift / trend / chop /
tight-chop scenarios before being wired in.

---

## 5 · Fashionably Late — momentum capture at the 9-EMA×VWAP cross  ✅ LOCKED

Divergence → convergence: momentum builds off the low; entry the moment an
UP-SLOPING 9-EMA crosses a FLAT-TO-DOWN VWAP. Measured move (LoD→cross) sets
stop and target. Avoid if flat/choppy or the 9-EMA went horizontal >15 min
before the cross. Times 10:00–13:30. PDF: 60 % win · 3:1.

Implemented (validated #89: 75 % win / +29 % / net +$182 TTP):
- `ema9 cross_above vwap` + `ema9 rising(4,0)` + `vwap ≤ vwap[5]`
- anti-chop (data-driven, #88): `(vwap − LoD) ≥ 1%×close`
- exit `close cross_above vwap + 1.0×(vwap − LoD[1])` · stop `vwap − ⅔(vwap−LoD[1])`
- cap 1 · cooldown 10 · window 1000–1330.
The "textbook 3:1" tight stop was tried (#85/#86) and REVERTED — it
noise-stopped the winners (64 %→30 %). Win-rate fidelity beats R:R cosmetics.

---

## Cross-cutting engine capabilities (added for this spec)

1. **Cross-symbol (market) operand** — any operand may carry `"symbol":"SPY"`;
   it is computed on that symbol's bars from the same feed and causally
   reindexed onto the traded symbol's timeline (last completed reference bar at
   or before each bar — same non-look-ahead rule as higher-TF). This powers
   every "market trending with/against" factor.
2. **`levels.today_vol_max` (qp)** — running intraday session maximum of
   volume (the volume analogue of `levels.today_high`). Powers "one of the
   day's biggest volume bars".
3. Everything else in this spec is expressible with the existing verified
   primitives (levels, extremes, ma, vwap, structure.pivot + hold, candle
   anatomy via price fields, THEN sequences, for_bars, targets, discipline).

---

## Provenance of every number (anti-overfit guardrail)

The crafted test arcs are SMOKE tests only: they prove a sequence CAN fire and
an avoid-case CAN reject. They are never evidence a threshold is right, and no
live threshold may be changed to make an arc pass. Thresholds change only from
(a) the PDF's literal text, or (b) REAL-market evidence — and any data-derived
number is listed here with the window it came from, so fitted numbers can never
masquerade as book numbers.

| number | value | provenance |
|---|---|---|
| stop offset | $0.02 | PDF literal (".02 below") |
| scale-outs 1R / 2R / thirds | exact | PDF literal |
| break volume | +30 % vs prior bar | PDF literal (HitchHiker) |
| consolidation 5–20 min | 5-bar box / window 20 | PDF literal |
| extension from open | (demoted to quality) | was `>3×atr_daily` — funnel on LHSW 07/07: after a +277% gap the daily ATR reflects the OLD price regime, so the rule was true on 0 bars of a real 7.74→4.8 fade day (leave-one-out: dropping it fires the 2 real snapbacks). PDF lists it under increase factors; the avoid ("not extended from VWAP") remains via step 1 |
| snapback candle ≥1.5× recent range | 1.5× | USER-observed characteristic (not in PDF) |
| top-of-day volume | (demoted to quality) | was ≥0.6× today_vol_max[1] — funnel on VEEE 07/14 showed the proxy near-unsatisfiable on gap-up days (open bar dominates the day max) and stricter than the PDF's rank wording; the PDF's entry rules never contained it, so it left the entry per the audit rule |
| drive magnitude | ≥4 % over lowest(12) | mechanization of "distinct drive" — judgment |
| market gate | ema20(SPY) slope over 15 m | mechanization of "cleanly trending" — judgment |
| stopped-making-HH | highest(3) < 0.998×highest(8) | USER-designed detector, proven in isolation |
| box tightness | ≤3 % of price | judgment |
| Back$ide extension band | 3–12 % | DATA-FITTED on backtests #93/#94 (07/01–07/16 R1) — needs forward OOS confirmation |
| FL anti-chop | VWAP−LoD ≥1 % | DATA-FITTED on backtest #88 (same window) — validated in #89, needs forward OOS |
| EMA-hug tolerance | box low ≥ 0.995×ema9 | ⚠ CALIBRATED ON A SYNTHETIC ARC — the geometric argument (EMA lags into a box from below) is real, the NUMBER is not evidence. Re-measure on a real confirmed Back$ide chart before trusting. |
| cooldown | 10 bars | engine hygiene (PDF silent) |
| SC frozen stop/target (`freeze:true`) | — | PDF literal: the stop (".02 below the low of the turn candle") and target ("the high of the initial pullback") are levels FIXED before entry. #126 leg math proved the unfrozen forms diverge: rolling `lowest(3)[1]` + ratchet = unintended trailing stop; rolling `highest(8)[1]` = self-filling target (JEM T1 +0.79 % on a +31 % runner) |
| SC target lookback | 13 bars | mechanization-judgment: 6+6 THEN gaps + the attack bar span at most 13 bars back to the break, so the frozen lookback always contains the post-break spike (8 could slide past it). Must move with the THEN window if that ever changes |
| SC exit scope | runner | PDF literal ("Trail our stop for the REMAINING ½ … below the 9 EMA") — the 9-EMA close-below manages only the half left after T1; the hard stop protects the rest. Unscoped, 43/78 rows in #126 were pre-target ema9 scratches (median hold 4 min) |
| wrong-side target guard | engine-wide | engine hygiene, no threshold: a profit-target leg must sit BEYOND the entry fill (long: above, short: below) or it is not armed / not filled — no trader can rest a profit limit behind their fill. Exposed by #127 (21/77 trades banked phantom sub-entry "T1" losses after gapped next-open fills). When no leg arms, a runner-scoped exit governs the whole position from entry (there is no half to wait for) |
| SC ladder rule | 0.97 × / 20 bars | USER-CHART-AUDIT derived (7 graded #128 trades, screenshots 07/20): the level being broken must not sit ≥3 % below the level standing 20 minutes earlier — refuses lower-high crosses inside a fade while letting a flat range's pivots wiggle. Numbers are geometry-scale judgment (like RubberBand's 1.5× candle): 20 m spans the book's range scale; 3 % separates range-wiggle from the observed fade ladders (5–15 % drops). Validated ONLY if the pre-registered per-trade predictions in the status section hold on #130 |
| SC capped-range rule (REVERTED) | was `highest(15,high)[1] ≤ heldPivot` | the one entry-side change for the 07/01–07/20 window — FAILED validation on #129 and was reverted the same day. Evidence: total worsened −16.7 % → −21.5 %, payoff 1.12 → 0.74; the 22 dropped trades netted only −2.3 % but included the ARCHETYPE (JEM 07/01 +16.4 % second-chance-after-first-strike) because a parabolic tape always has prints above older pivots — the rule demanded the level be the absolute 15-bar max, not the top of the CURRENT range; and trimming early entries freed the 2/day cap for later, worse attacks (10 shifted entries, −7.1 %). Lesson recorded: any future significance rule must (a) measure the current range, not the recent max, and (b) be checked against the cap/cooldown shift side-effect. Window budget SPENT — next attempt needs forward OOS |

### Validation protocol (the fix for "tuning until it dies")
1. Seeds are FROZEN as the PDF derivation. Arc tests are smoke only.
2. Real validation: eyeball detections on real charts (user confirms geometry),
   then backtest the frozen seed.
3. At most ONE tuning pass per strategy per data window — and the register
   accrues forward daily, so NEXT week's data is free out-of-sample: tune on
   window A, confirm on window B, never iterate on the same window.
4. A change motivated by a failing test arc is allowed ONLY when the arc is
   shown to be wrong against the PDF's picture — never to make the arc green.
