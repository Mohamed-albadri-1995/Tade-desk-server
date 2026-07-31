# Full review: builder · engine · strategies — the "nonsense entries" fix

Structured per the request: general → exact → actual → what to fix → how →
implement. Written BEFORE coding. Nothing here is implemented yet.

---

## 1. How it's supposed to work — GENERALLY
A strategy detects a repeatable *setup*. Each time the setup genuinely occurs
you take **one** position. After the position closes you wait for the **next
genuine occurrence** — you do not machine-gun the same level. Each strategy
has a small, sane **cap on attempts per day** (the book's "1 and done" or "2
strikes"). Exits react to *state* (exit whenever the exit condition holds).

## 2. How it's supposed to work — EXACTLY
- **Entry** fires when the entry group *becomes* true (a fresh setup), while
  flat and enterable (session ok, stop priceable).
- **Re-entry** on the same symbol/day is bounded by (a) the strategy's own
  **max attempts/day** (PDF: RubberBand 2, Second Chance 2, Back$ide 1,
  HitchHiker 1, Fashionably Late 1) and (b) a **cooldown** — a minimum number
  of bars after an exit before the setup may fire again (stops re-taking the
  same chop within 2–3 minutes).
- **One position** at a time; **exit** is status; priority SL→TP→exit→eod;
  scale-out legs bank fractions, runner rides.
- A setup that stays true for many bars is **one** setup, not one-per-bar.

## 3. How it ACTUALLY works now (verified in code + the run-60/59 CSVs)
- `_pair_trades` enters on `if entry_mask[j]:` — **STATUS**: any true bar while
  flat. `_edges()` (fire-once) is applied only to the CHART display, not to
  the trade pairing. So a *persistent* entry mask re-enters every bar after an
  exit.
- BUT every seed's entry mask is already **spiky** (each contains a cross /
  break / THEN-sequence, true only on the trigger bar), so the churn we see is
  not consecutive-bar re-firing — it's the **setup re-completing every 2–3 min
  on chop**: Second Chance BTOG = 5 trades, 1-min holds, 2–3 min gaps; JEM =
  0-min holds (instant whipsaw).
- `max_entries_per_day` exists but is a **backtest-panel run rule**, NOT part
  of the strategy, and the seeds don't set it → the user had it at **5**, far
  looser than the PDF's 1–2. That is the dominant cause of the entry counts.
- No **cooldown** exists, so nothing stops re-entry 2 minutes after an exit.
- **Whipsaw exits**: the 9-EMA-cross exit fires 0–2 bars after entry on a
  fakeout → 0–1 min "trades" that only pay commission.

## 4. What I need to fix (ranked by impact on the real symptom)
1. **Per-strategy max attempts/day** — the primary lever. Move the cap into
   the strategy JSON (default sensible), have the seeds carry the PDF values
   (2 / 2 / 1 / 1 / 1). Turns Second Chance 5→2, RubberBand 5→2 immediately.
2. **Cooldown** — a `cooldown_bars` guard: after an exit, block new entries for
   N bars on that symbol/day. Kills the 2–3-min re-take of the same chop.
3. **Min-hold / no-instant-exit** — don't let the exit rule fire in the first
   `min_hold_bars` after entry (the SL still protects). Kills the 0-min
   whipsaws. (Strategy-level, tunable.)
4. **Edge-triggered entry** — semantically correct (fire on the group's
   false→true edge, re-arm only after reset). Does NOT change the spiky seeds,
   but fixes user strategies with *persistent* entry conditions (e.g.
   "close > ema"). Lower urgency, still correct.
5. **Builder review** — surface caps 1–3 as first-class strategy fields (not
   just backtest-panel rules), so a saved strategy carries its own risk
   discipline everywhere (preview, backtest, and later the trading tool).

## 5. How I'll fix it — EXACTLY
- **Engine (`_pair_trades`)**: read `max_per_day`, `cooldown_bars`,
  `min_hold_bars` from the strategy's `risk` (fallback to the panel `rules`).
  - cap: already have the per-day counter; also accept it from the strategy.
  - cooldown: track `last_exit_bar[day]`; block entry if
    `j - last_exit_bar < cooldown_bars`.
  - min-hold: in-position, ignore the exit-RULE (not SL/eod) while
    `j - ei < min_hold_bars`.
  - edge-trigger: enter only when `entry_mask[j] and not entry_mask[j-1]`
    (rising edge) — add as an opt-in `entry_mode: 'edge'|'status'` (default
    edge) so persistent-mask strategies stop re-firing; spiky masks unchanged.
- **Seeds**: add `risk.max_entries_per_day` (2/2/1/1/1) and a small
  `cooldown_bars` (e.g. 10) + `min_hold_bars` (e.g. 3) where the PDF implies it.
- **Builder UI**: a "Discipline" row — max attempts/day, cooldown, min-hold —
  on the strategy (mirrors the backtest-panel rule, but saved with the strategy).
- **Backtest panel**: the existing max-entries field becomes an OVERRIDE of the
  strategy value (blank = use the strategy's).
- **Tests**: hand-computed cases for cap-from-strategy, cooldown blocks a
  2-bar re-entry, min-hold defers an instant exit-rule fire, edge vs status on
  a persistent mask. Backward compatible: absent → today's behavior.

## 6. Implementation order (commit + test + review each; no rush)
- [ ] S1. Engine: cooldown_bars + min_hold_bars + per-strategy max_per_day
      (read from risk, panel overrides). Hand-computed tests.
- [ ] S2. Engine: opt-in edge-triggered entry (`entry_mode`), default preserved
      until proven; tests on persistent vs spiky masks.
- [ ] S3. Seeds: set the PDF discipline (attempts/cooldown/min-hold); re-run
      part 17; regenerate; confirm entry counts drop to 1–2.
- [ ] S4. UI: "Discipline" fields on the strategy; panel field becomes override.
- [ ] S5. Full re-review of builder + engine end-to-end; user re-runs vs PDF.

## STATE: PLAN WRITTEN — awaiting go-ahead before S1.
