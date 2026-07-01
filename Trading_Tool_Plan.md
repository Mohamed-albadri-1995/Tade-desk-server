# Trading Tool — Current State

This doc reflects the trading side as it stands. It supersedes earlier plans that were written before implementation began.

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
| `router.js` | The junction. Evaluates checks, sizes the trade, checks risk, opens the position, creates the card, fans out to brokers. `closePosition()` is the single close path. |
| `brokers.js` | Broker profiles. `send()` POSTs to Alpaca `/v2/orders` as bracket orders. Three-gate safety on live (env=live + mode=live + trading_live_confirmed=true). |
| `brokerSync.js` | 15s order-fill poll, 60s balance poll. Rewrites entry_price to the real Alpaca fill, closes on bracket leg fills, refreshes sizer equity. |
| `positionMonitor.js` | Local SL/TP watchdog on the bar stream. Redundant when Alpaca owns the bracket, useful in offline paper mode. |
| `checks.js` | Check library + condition DSL. ~40 atomic conditions via JSON grammar (compare, combinators, arithmetic, slope, history). Seeds ship with the app. |
| `grading.js` | Learns from `trade_cards`. Setup expectancy (drives base size + kill switch), per-check delta expectancy (drives A+/A/B/C on the live fire). |
| `volumeBaseline.js` | 10-day per-minute baseline for rvol. Refreshed nightly. |
| `backtest.js` | Historical replay of an indicator on cached bars. Optional. |

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

- **Setup multiplier** — how good is this setup overall? Default 1.0, only moves off 1.0 once the setup has enough closed trades (`grading_min_setup_trades`, default 20). Kill switch at expectancy ≤ `grading_kill_expectancy_r` with `grading_kill_min_trades` samples.
- **Signal grade multiplier** — how good is THIS specific fire, given which additional checks are aligned right now? A+ (1.2×) / A (1.0×) / B (0.85×) / C (0.7×). Requires `grading_min_check_side_trades` samples on each side of the delta before a check contributes.

Both live in `sizer.js`'s cascade. Both display on the Alerts card so you can see why size came out where it did.

---

## Journal

Trade log — every closed trade card mirrors here so the log stays complete. Manual entries and CSV imports write here first; the bridge (`journal/bridgeToGrading.js`) copies closed entries into `trade_cards` so historical data feeds the grading engine.

The journal has its own filtered-metric bar (net P&L, win rate over an arbitrary date range) that reads from `journal_trades`. Per-setup expectancy math is delegated to `grading.accountSummary` — one source of truth for the numbers that drive sizing.

---

## Check library

40+ atomic conditions expressible as JSON. Grammar:

- Comparisons: `eq`, `ne`, `gt`, `ge`, `lt`, `le`
- Combinators: `and`, `or`, `not`
- Value nodes: `{field: "rvol"}`, `{ctx: "secBias"}`, `{literal: 2}`, `{history: "vwap", barsAgo: 3}`, `{slope: "ema13", bars: 5}`
- Arithmetic: `add`, `sub`, `mul`, `div`, `min`, `max`, `abs`, `neg`, `pct_change`, `avg`, `weighted_avg`

Every check has a `version_id` that bumps on condition edit. `trade_card_checks` rows carry the version they were measured under, so the grading engine's `checkContributions` JOINs on both `check_key` AND `version_id` — an edited check's old-logic history is discarded from the learning pool, and it starts a fresh sample.

Categories:
- **Mandatory** — pulled from the indicator's `debug()` output. Can't be edited; if the check isn't aligned the indicator won't fire.
- **Default** — enabled library entries that apply to every setup.
- **Additional** — opt-in per setup, driving the A+/A/B/C signal grade.

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

## What's next

- Import 3 TradingView Pine scripts (VWAP Cluster Bounce, S/R Dynamic v2, L3+BBZ) as new indicator engines. The check DSL, expression engine, and UI already exist — the work is porting the stateful Pine math (anchored VWAPs, slope score, zone duration, S/R levels) into JS and merging the computed values into `signal.indicators`.
- Broader integration tests for the fill-sync path.
- Optional filters on the trade-card viewer UI (already shipped).
