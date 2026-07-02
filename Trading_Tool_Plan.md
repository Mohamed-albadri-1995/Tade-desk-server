# Trading Tool — Current State

This doc reflects the trading side as it stands. It supersedes earlier plans that were written before implementation began.

> **Phase status (2026-07-02)**: trading side is **feature-complete** pending bug reports. See [Phase status](#phase-status--trading-side-complete) below for the tick-list. The next initiative is a separate Quantitative Analysis Platform (Stages 1–19) that will replace the indicator/level derivations here with TradingView-validated values — see [What comes next](#what-comes-next--separate-quantitative-analysis-platform).

---

## Architecture in one picture

```
9:35 ET                                                                  10:00 ET
   │                                                                         │
   │  Scanner (Screener side) publishes the day's shortlist                   │
   ▼                                                                         │
Trading Session starts ─► pulls shortlist                                    │
                          loads active setups                                │
                          starts bar poller (HTTP 60s OR Alpaca WS)          │
                          starts brokerSync (order fills + balance)          │
                                                                             │
Each 1-min bar per ticker ─► Setup Engine evaluates all its setups           │
                              ─► fire? ─► Router builds a trade card         │
                                          Sizer computes shares/risk         │
                                          Market Gate applies direction gate │
                                          Grading assigns live A+/A/B/C      │
                                          brokers.send fans out per profile  │
                                                                             │
Alpaca fills the bracket ─► brokerSync polls /v2/orders                      │
                            updates entry_price with the real avg            │
                            closes position on SL/TP leg fill                │
                            router.closePosition writes trade card + journal │
                            grading engine picks up the new closed card      ▼
                                                                     Session ends
```

Nothing is scheduled by a big cron. Everything is driven by the bar stream + broker events.

---

## Modules (`src/trading/`)

| File | Responsibility |
|---|---|
| `session.js` | Lifecycle. Starts/pauses/ends. Owns the tickers and setups list for the day. |
| `barPoller.js` | Feeds 1-min bars to the setup engine. HTTP (60s) or Alpaca WebSocket, chosen in Settings. |
| `alpacaStream.js` | Alpaca market-data WebSocket client. Bars + quotes. |
| `marketGate.js` | Direction gate. Reads context (short/mid/long term bias, sec bias). Fail-safe: unknown ticker → blocked. |
| `setupEngine.js` | Registry + fire hook. Single source of truth for the active setups. Hot-reloadable mid-session. |
| `indicators/*` | Indicator engines. Each exports `evaluate(bars, pmHigh, ctx)` and `debug(...)`. `ctx.rvol` is available. |
| `sizer.js` | Two-multiplier cascade: `equity × riskPct × gateMult × scoreMult × signalGradeMult × setupMult`, then hard caps. |
| `router.js` | The junction. Evaluates checks, calls factor-analysis scorer (or naive-delta fallback), sizes, gates, opens position, creates card, fans out to brokers respecting each profile's `minGrade`. `closePosition()` is the single close path. Also runs kill-block / auto-pause / event logging. |
| `brokers.js` | Broker profiles. `send()` POSTs to Alpaca `/v2/orders` as bracket orders. Three-gate safety on live. `config.minGrade` gates fanout. |
| `brokerSync.js` | 15s order-fill poll, 60s balance poll. Rewrites entry_price to the real Alpaca fill, closes on bracket leg fills, refreshes sizer equity. Always-on lifecycle. |
| `positionMonitor.js` | Local SL/TP watchdog on the bar stream. Redundant when Alpaca owns the bracket, useful in offline paper mode. |
| `checks.js` | Check library + condition DSL. 78 seeded conditions across 7+ batches, direction-aware paired variations, boot-time grammar repair migration. |
| `dailyLevels.js` | Multi-day / week / month / premarket levels computed from the merged bar buffer at fire time. Fields spread into `indicatorExtras` for the check evaluator. |
| `historicalCache.js` | Multi-day 1-min bar warmup at session start (Yahoo primary, Alpaca fallback). Enables 5D MA + 2D VWAP + prev-day levels from the first fire. |
| `grading.js` | Setup expectancy + drawdown + winRate + profit factor + longest losing streak. `setupSizeMultiplier` is direct-from-stats, not letter-based. Kill switch, auto-pause hook, event logger, expectancy trend. |
| `setupScorerClient.js` | HTTP wrapper for the Python factor-analysis scorer. Timeout 1.5s; null on any failure so router falls back to naive delta. |
| `volumeBaseline.js` | 10-day per-minute baseline for rvol. Refreshed nightly. |
| `backtest.js` | Historical replay of an indicator on cached bars. Optional. |

### Python side (`src/scoring/`)

| File | Responsibility |
|---|---|
| `setupProcessor.py` | Per-setup PCA + Ridge training. Reads closed cards + additional check alignments, pivots into (rows = cards) × (cols = check_key × variation), fits scaler → PCA → Ridge, computes bucket cutoffs + feature importance, persists to `outputs/setups/{setup_id}/{model.pkl, meta.json}`. Enforces per-setup isolation. |
| `setupScorer.py` | Loads a setup's model on demand, scores aligned-features → letter grade. Cache per setup_id. |
| `server.py` | Flask on 3001. Scanner routes + `/setup/*` for per-setup training + scoring. |

### Grading loop tables

| Table | Purpose |
|---|---|
| `trade_cards` | One row per fire. Filled in with r_multiple on close. Feeds every learning query. |
| `trade_card_checks` | Per-card check evaluations (mandatory + additional). Carries `check_version_id` + `variation` so learning splits cleanly on edits and per direction. |
| `trading_grading_events` | Grading-loop actions: `kill_block`, `kill_override`, `auto_pause`, `grade_drift`. Learning modal reads this for the events log. |

---

## Data model

Only the tables trading writes to. Everything not listed here belongs to the scanner side.

- `trading_setups` — user-defined setups (name, indicator, window, config).
- `trading_orders` — every order emitted by router. Includes `alpaca_order_id` after fanout.
- `trading_positions` — one row per opened position. `entry_price` gets rewritten to the Alpaca fill.
- `trading_signals` / `trading_signal_log` — signal history for the day.
- `trading_sessions` — session lifecycle.
- `trading_brokers` — broker profiles (type, config JSON, enabled, is_default). Config JSON holds `url`, `key`, `secret`, `feed`.
- `trade_cards` — the grading engine's substrate. One card per fire; fills in exit/R when closed. `check_version_id` on each stored check evaluation.
- `trade_card_checks` — mandatory + additional checks captured at fire time.
- `check_library` — DSL check definitions. `version_id` bumps on condition edit so learning history doesn't mix.
- `setup_check_assignments` — per-setup "additional" checks.
- `journal_trades` — the trade log. Fed by both journal CSV imports and the bridge from `router.closePosition`. The grading engine also reads mirrored versions of these via the bridge.

---

## Credentials

Single source of truth: **the Alpaca broker profile in Trading > Brokers**. URL, feed (IEX/SIP), key, secret all live in `trading_brokers.config`. Both HTTP polling (`alpaca/client.js`) and the WebSocket stream (`alpacaStream.js`) prefer this profile over the legacy settings-based `alpacaApiKey`/`alpacaApiSecret`.

The legacy settings fields still work as a fallback for older installs, but the UI no longer exposes them.

---

## Execution modes

| Mode | Behavior |
|---|---|
| **off** | Signals fire in the UI but no order, no position, no broker call. |
| **paper** | Local position + trade card + fan-out to Alpaca profiles whose URL is `paper-api.alpaca.markets`. Real fills, real slippage, no real money. |
| **live** | Same, targeting profiles whose URL is `api.alpaca.markets`. **Requires the `trading_live_confirmed` checkbox in Settings** — three-gate safety so no upgrade path can accidentally submit live orders. |

The Router picks which profiles to call based on `env` (derived from the profile's URL, not a duplicate field). A paper-configured session with a live profile enabled won't accidentally hit the live URL — the profile just gets skipped.

---

## Grading

Two independent multipliers stack into position size:

- **Setup multiplier** — computed directly from raw journal-analysis stats (`grading.setupSizeMultiplier`). Not a letter grade lookup any more:
  ```
  expectancyFactor = clamp(0.75 + 0.5 × expectancyR, 0.40, 1.50)
  winRateFactor    = 1.00 / 0.90 / 0.80 / 0.65  (≥50% / ≥35% / ≥25% / else)
  drawdownFactor   = 1.00 / 0.90 / 0.80 / 0.65  (<3R / <6R / <10R / else)
  multiplier       = clamp(expectancyFactor × winRateFactor × drawdownFactor, 0, 1.5)
  ```
  Bootstrap: <20 closed cards → 1.0×. Kill switch: 30+ cards with expectancy ≤ −0.5R → 0×.
- **Signal grade multiplier** — how good is THIS specific fire. Two-tier grader:
  1. **Preferred**: the setup's own trained factor-analysis model (Python `SetupLiveScorer`). Isolated per setup at `src/scoring/outputs/setups/{setup_id}/`. PCA + Ridge on the aligned-check feature matrix, bucketed by empirical prediction quantile → A+/A/B/C.
  2. **Fallback**: naive per-check delta expectancy from `grading.gradeSignal`. Used when the setup hasn't been trained yet (<30 closed cards) or the Python service is unreachable. Bootstrap default is `B`.

  Grade → multiplier map in `sizer.js`: A+ (1.2×) / A (1.0×) / B (0.85×) / C (0.7×).

Both live in `sizer.js`'s cascade. Both display on the Alerts card so you can see why size came out where it did.

### Grade → account routing

Each broker profile has a `config.minGrade` field (`off | C | B | A | A+`). Router silently skips a broker whose `minGrade` is stricter than the fire's grade — recorded on `brokerResults` for debugging. Bootstrap fires are treated as B.

Typical use: `Alpaca Live` → `minGrade = A+`, `Alpaca Paper` → `minGrade = off`. Every fire records to paper for learning; only A+ fires reach live.

### Kill-switch + auto-pause + override

- **Kill switch** — `setupSizeMultiplier` returns 0 when expectancy is deeply negative. Router blocks the trade via `shares > 0` guard, logs a `kill_block` event.
- **Override** — per-setup checkbox (`override_kill_switch`); when on, router uses the grade-based multiplier even under kill, logs `kill_override`.
- **Auto-pause on grade drift** — per-setup threshold (`auto_pause_c_streak`); after N consecutive C grades the router flips `enabled=0` and logs `auto_pause`. Prevents slow-decay setups from bleeding.

All three events land in `trading_grading_events` and surface in the Learning modal.

---

## Journal

Trade log — every closed trade card mirrors here so the log stays complete. Manual entries and CSV imports write here first; the bridge (`journal/bridgeToGrading.js`) copies closed entries into `trade_cards` so historical data feeds the grading engine.

The journal has its own filtered-metric bar (net P&L, win rate over an arbitrary date range) that reads from `journal_trades`. Per-setup expectancy math is delegated to `grading.accountSummary` — one source of truth for the numbers that drive sizing.

---

## Check library

**78 seeded conditions** (Batches 1–7) expressible as JSON. Grammar:

- Comparisons: `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `in`
- Combinators: `and`, `or`, `not` (`not` takes singular `operand`, and/or take `operands` array)
- Value nodes: `{field: "rvol"}`, `{ctx: "secBias"}`, `{literal: 2}`, `{history: "vwap", barsAgo: 3}`, `{slope: "ema13", bars: 5}`
- Arithmetic (as value nodes): `{expr: "add|sub|mul|div|min|max|abs|neg|pct_change|avg|weighted_avg", ...}`

Every check has a `version_id` that bumps on condition edit. `trade_card_checks` rows carry the version they were measured under, so learning history splits on JSON changes.

Categories:
- **Mandatory** — from the indicator's `debug()`. Read-only.
- **Default** — auto-applied to every setup.
- **Additional** — opt-in per setup, drives the A+/A/B/C signal grade.

### Direction-aware variations

Each check has a `direction` field (`both | long | short`) that filters at fire time. `direction='both'` entries can also carry paired `condition_long` + `condition_short` slots — the resolver picks the right one based on signal direction. The chosen slot is recorded as `variation` (`long | short | symmetric`) on the trade card so grading knows which side actually fired.

### Available `field` names (from `dailyLevels.computeLevels` + indicator engines)

**Per-bar / indicator engine**: `close, open, high, low, volume, prevClose, vwap, ema9, ema13, ema20, ema50, sma5, sma9, sma13, sma20, bb_upper, bb_lower, bb_mid, atr14, rvol, daily_vwap, vwap_stdev, ll_avwap, bb_ema, slope_score, prevLwickPct, touchedDv, touchedV2, touchedAv, maHit, zonePct`

**Multi-day / week / month / premarket** (`src/trading/dailyLevels.js`, computed from merged bar buffer per fire): `ma5day, ma5day_slope, vwap_2day, vwap_week, vwap_month, week_high, week_low, month_high, month_low, prev_day_high, prev_day_low, premarket_high, premarket_low`

**Scanner ctx** (via `{ctx: "..."}`): `regime, regimeLabel, secBias, secScore, secHot, sector, industry, shortTerm, midTerm, longTerm, broadResolved, _score`

The batches of seeded checks:
- Batch 1 (L3): 7 vwapBounce-specific checks (slope score, VWAP-touch confluence, strict bias, room to BB upper, stack alignment).
- Batch 2 (BBZ): 7 smaTouchBounce-specific checks (SMA touch level, zone quality, body/ATR ratio, σ-band gates, SMA stack).
- Batch 3 (Market context): 7 cross-setup filters on rvol, sector, MTF biases.
- Batches A/B/C (direction): schema + short counterparts + paired variations.
- Batch 4 (Multi-day levels): 13 single-field checks on 5D MA, 2D/week/month VWAPs, prev-day / premarket / week / month H/L.
- Batch 5 (Confluence): 6 compound filters (5D+sector, breakout stack, multi-VWAP stack).
- Batch 6 (High-conviction): 11 compounds — volume-confirmed breakouts, trend+volume, full 4-VWAP stack, MTF scanner align, sector+volume.
- Batch 7 (Safety): 11 filters — room-to-run, not-extended, gap-up sustained, triple-break, breakout+sector, no-sector-headwind, pullback-in-uptrend.

---

## Fire-time flow

1. Bar poller emits a signal.
2. `setupEngine.onIndicatorFire` enriches with scanner context.
3. `router.processSignal`:
   1. Fresh-fetches the scanner snapshot (`ctx._score`, `secBias`, etc.) so grading learns from the values at the exact minute.
   2. Runs mandatory + default + additional checks via `checks.collectChecksForFire`.
   3. Calls `grading.gradeSignal` for the live A+/A/B/C.
   4. Calls `sizer.calculate` with both multipliers.
   5. Applies market gate + daily loss + max exposure checks.
   6. Writes `trading_orders`, `trading_positions`, `trade_cards` in one transaction.
   7. Fans out to every enabled broker profile whose `env` matches the current execution mode.
   8. Broadcasts an SSE event so the UI updates.

---

## Deploy

The trading side runs inside the same Node process as the scanner. `pm2 restart trade-desk` is enough for Node changes; the Python scorer (`pm2 restart scorer`) only needs a restart when its model or `src/scoring/*.py` changes.

Full deploy: `./deploy.sh` (pulls, installs, restarts everything).

---

## Phase status — TRADING SIDE COMPLETE

As of `f795a30`, every piece of the loop the user laid out is in place:

- Session lifecycle, bar poller, indicator engines (L3 → vwapBounce, BBZ → smaTouchBounce), Alpaca WS + HTTP fanout ✓
- Historical bar cache (Yahoo primary, Alpaca fallback) — 6-day warmup so multi-day levels work at session open ✓
- 78-entry check library with direction-aware paired variations ✓
- `dailyLevels.computeLevels` — 5D MA, 2D/week/month VWAPs, week/month H/L, prev-day H/L, premarket H/L ✓
- Trade-card recording at fire time; card feeds live grader + learning storage in one shot ✓
- Setup multiplier from raw journal-analysis stats (expectancy × winRate × drawdown) ✓
- Factor-analysis training pipeline (`src/scoring/setupProcessor.py`) — per-setup PCA + Ridge, isolated `outputs/setups/{id}/` ✓
- Live grader: factor-analysis model when trained, naive delta when not, bootstrap-B when neither ✓
- Feature importance chart + realised-R-per-grade-band in the Learning modal ✓
- Grade → account routing (per-broker `minGrade`) ✓
- Kill-switch + override + auto-pause on grade drift + events log ✓
- Journal cards unified with per-setup checks (imported trades get retroactive evaluation from stored snapshots) ✓

**No further work required on the trading side pending bug reports.**

---

## What comes next — separate Quantitative Analysis Platform

The **indicators + condition primitives** in this repo were built pragmatically alongside the rest of the trading stack. Correctness varies: some (L3, BBZ) were ported directly from Pine; others (multi-day levels) were re-derived. The user's next initiative is to build a dedicated Quantitative Analysis Platform where every primitive is validated against TradingView bar-for-bar before it's trusted, then export its output for this tool to consume.

### The plan (user's master plan, verbatim structure)

```
Market Data
    │
    ▼
Data Management Layer      ← STAGE 1
    │
    ▼
Time & Session Engine      ← STAGE 2
    │
    ▼
Mathematical Foundation    ← STAGE 3   (rolling stats, slope, regression — no trading knowledge)
    │
    ▼
Price Foundation           ← STAGE 4   (OHLC + typical/median/weighted-close)
    │
    ▼
Moving Average Library     ← STAGE 5   (SMA / EMA / RMA / WMA / VWMA / HMA)
    │
    ▼
VWAP Library               ← STAGE 6   (session / 2D / 3D / weekly / monthly / quarterly / yearly / anchored)
    │
    ▼
Volatility Library         ← STAGE 7   (ATR, TR, BB, Keltner, stdev)
    │
    ▼
Level Library              ← STAGE 8   (Y-High/Low, prev-week/month, rolling extremes)
    │
    ▼
Market Structure           ← STAGE 9   (swing / pivot / HH-HL-LH-LL / trend state)
    │
    ▼
Primitive Library          ← STAGE 10  (Above, Below, Cross, Touch, Reject, Break, Slope, Bounce…)
    │
    ▼
Indicator Combinations     ← STAGE 11
    │
    ▼
Setup Library              ← STAGE 12
    │
    ▼
Screening Engine           ← STAGE 13
    │
    ▼
Chart Engine               ← STAGE 14  (own TradingView, dev-only)
    │
    ▼
VALIDATION MODE            ← STAGE 15  (TradingView side-by-side comparison, per timeframe / EMA length / symbol)
    │
    ▼
Backtest / Replay          ← STAGE 16
    │
    ▼
Live Engine                ← STAGE 17
    │
    ▼
Statistics Database        ← STAGE 18
    │
    ▼
AI Analysis                ← STAGE 19
```

### Rules

- One responsibility per function.
- Never duplicate calculations — same library across chart, screener, backtester, live.
- Validate before reuse — every primitive must match TradingView before other modules depend on it.
- Once verified, lock. Change only for confirmed defects.
- Separate concerns: data / indicators / strategies / execution / visualization.
- Test continuously.

### Interface with THIS repo

The Quant Platform will be a separate codebase. Its output — validated indicator values per bar per symbol — will be imported into this tool in one of two ways:

1. **Batch export**: JSON or Parquet files per symbol/day. Loaded on session start, merged into the `signal.indicators` extras the check evaluator consumes. Same key names as `dailyLevels.computeLevels` publishes today (`ma5day`, `vwap_week`, `week_high`, etc.) so the check library needs zero edits.
2. **Live stream** (later): HTTP/websocket subscription. Router pulls the latest values at fire time.

Once Stage 15 (Validation Mode) certifies a primitive, its values here become authoritative — the local re-derivations in `src/trading/dailyLevels.js` and the indicator engines get replaced by imports from the platform. The check library grammar, direction-aware resolver, and trained models keep working unchanged since they only care about the values, not who computed them.

The `src/trading/indicators/*.js` engines stay as the fire-detection layer (which bars produce a signal), but the levels they reference will come from the platform.

### Migration hooks already in place

- `checks.buildIndicatorContext(bars, extras)` — the `extras` merge point already exists. Whatever the platform exports for a given `signal.bars[-1]` can be spread into `extras` with zero refactor.
- `check_library.condition` grammar is stable — 78 seeded checks will Just Work against platform-computed levels of the same names.
- Direction-aware variations + version stamping + factor-analysis training are all downstream of the check evaluator, so they carry over transparently.

---

## Deploy

```
# Every code change
cd /home/ec2-user/Tade-desk-server && git fetch origin claude/test-9d4txv && git checkout claude/test-9d4txv && git reset --hard origin/claude/test-9d4txv && git log -1 --format='deployed: %h %s' && pm2 restart trade-desk

# When Python side changes
pm2 restart scorer

# Verify scorer routes
curl -s http://127.0.0.1:3001/setup/health && echo
```

Expected `/setup/health`: `{"ok":true,"ready":true}`.
