# Implementation Roadmap: Trade Desk Rebuild

This document tracks what has been built, what changed from the original spec, and what is pending.

---

## Guiding Principles

- **Server as source of truth** — all business logic on the server
- **Exact reproduction** — formulas and thresholds match spec exactly
- **No hidden logic** — all deviations documented here

---

## Session Change Log

### Session 1 — Core pipeline (Sides A, B, D, C, E, F)

#### Side A — TradingView Scanner

| What Changed | Spec Said | What We Did | Reason |
|---|---|---|---|
| `ignore_unknown_fields` | `false` | `true` | TV returns unexpected fields; `false` caused silent failures |
| Ticker extraction | `d[0]` (ticker-view column) | `rawTV.s` (symbol field) | TV changed `ticker-view` column format mid-session |
| Common base filter | 3 OR-branches | 4 OR-branches (added `fund` type) | Missing `fund` excluded valid stocks |
| Resilience layer | Not in spec | Added `validateTVStructure()`, `COLUMN_EXPECTED_TYPES`, safe extractors | Detects future TV API format changes |

#### Side D — Market Context

| What Changed | Spec Said | What We Did | Reason |
|---|---|---|---|
| Sector taxonomy | GICS names only | Added Morningstar taxonomy to mapping | TV returns Morningstar names; sectors were always NEUTRAL without this |
| `context.regime` | Store label string | Store slug (e.g. `STRONG_UP`) | Slug is stable for programmatic use |
| `context.regimeLabel` | Not in spec | Added as separate field | Human-readable label for UI display |

#### Side E — Scoring Engine

| What Changed | Spec Said | What We Did | Reason |
|---|---|---|---|
| Score display | Show `_score` | Show `—` (blank) | Scoring engine disconnected — will be designed after analysis report review |

#### Settings System (new — not in original spec)

Runtime control panel for thresholds and API keys. All keys stored in `settings` DB table, read per-request.

**Keys added:**

| Key | Default | Description |
|---|---|---|
| `hotImmediateThreshold` | 60 | Score to enter HOT instantly |
| `hotSustainedThreshold` | 40 | Score to sustain toward HOT |
| `hotSustainedSessions` | 3 | Consecutive sessions needed for sustained HOT |
| `hotFloorThreshold` | 20 | Score floor to remain HOT |
| `coolOffDays` | 2 | Sessions below floor before losing HOT |
| `sectorBullishThreshold` | 20 | Score above = BULLISH |
| `sectorBearishThreshold` | -20 | Score below = BEARISH |
| `shortlistMinScore` | 70 | Min score for auto-shortlist |
| `shortlistTopN` | 5 | Max picks for auto-shortlist |
| `finnhubApiKey` | `''` | Finnhub news key (masked in API) |
| `githubBackupToken` | `''` | GitHub PAT for backup (masked) |
| `alpacaApiKey` | `''` | Alpaca key for R3 capture (masked) |
| `alpacaApiSecret` | `''` | Alpaca secret (masked) |

#### Frontend Fixes

| Fix | Root Cause |
|---|---|
| Frontend showed 0 stocks | API returns `{count, rows}` but frontend assigned whole object |
| Screener filter never matched | Filter checked `keys.includes('trend')` but keys are capitalized (`'Trend'`) |
| Market tab not refreshing after scan | `runScan()` only called `loadRegistry()`; needed `loadMarket()` too |
| Card showed regime slug not label | Card used `ctx.regime` (slug); fixed to use `ctx.regimeLabel` |

---

### Session 2 — Data Warehouse, Scheduler, Side G, Pipeline Monitor

- **Side G** (stale ticker refresh): fetches fresh TV quotes for non-live rows after each scan using symbol mode
- **Pipeline monitor**: full `PipelineReport` with per-stage timings, row counts, errors
- **Scheduler browser controls**: card-based job list, modal editor with day toggles + hour/minute inputs + live cron preview
- **Data Warehouse tab**: R1, R2, R3A, R3B, R4A, R4B viewer with date picker
- **R3 EOD capture** (Side H): Alpaca 1-min bars → entry price + HH/LL + ATR14 + R-values at 4:05 PM

---

### Session 3 — Side E Analysis Engine

#### What was built

- `src/sideE/train.js` — feature importance engine (38 features, weighted variance formula)
- `src/sideE/score.js` — scoring module (built but disconnected from pipeline)
- `src/sideE/insights.js` — rule-based + AI-generated insights
- `src/routes/analysis.js` — Analysis API (`/api/analysis/*`)
- Analysis tab UI — model config, train button, factor importance list, bucket analysis, insights panel

#### Key design decisions

- Scoring was **disconnected from the pipeline** pending the PCA scoring engine redesign.
- Walk-forward backtest was **removed entirely** by user request.
- Regime labels: simplified to 7, then **restored to full 15** by user request.

#### Settings keys added

| Key | Default | Description |
|---|---|---|
| `analysisEntryType` | `A` | Entry type for R4A training (A = 9:37, B = 9:40) |
| `analysisDirectionalBias` | `Up` | Directional filter |
| `analysisSuccessThreshold` | `1.5` | Win condition R-multiple |
| `analysisTrainingWindow` | `90` | Training window in days |
| `aiApiKey` | `''` | AI provider key (masked) |
| `aiModel` | `anthropic/claude-haiku-4-5` | AI model ID |

---

### Session 5 — PCA Scoring Engine (Phase 2 Complete) + Shortlist Fix

#### Scoring Engine — Full PCA Factor Analysis Model

Replaced the disconnected placeholder with a production-ready two-process architecture:

**Architecture:**
- **Process 1** — Node.js (`trade-desk`): runs the pipeline, builds card dicts, calls Flask
- **Process 2** — Python Flask (`scorer`): loads trained PCA models, scores cards, returns `_score`
- Flask runs at `127.0.0.1:3001`, Node calls `/score` endpoint per ticker (parallel via `Promise.all`)

**Files changed/added:**
- `src/scoring/processor.py` — `FactorAnalysisProcessor`: trains PCA model from R4A/R4B CSVs
- `src/scoring/scorer.py` — `LiveScorer`: loads trained model outputs, scores live card dicts
- `src/scoring/server.py` — Flask app: `/score`, `/train`, `/health`, `/model-info` endpoints
- `src/sideE/score.js` — `buildCard()`, `resolveCardBias()`, `scoreAllRows()` — Node side
- `scripts/verify_irdm_score.py` — manual score verification script with hardcoded IRDM card data

**Settings keys added:**
| Key | Default | Description |
|---|---|---|
| `scorerEntryTime` | `9:40` | Entry time for base selection (9:37 or 9:40) |

#### Bug Fixes

**1. `_score` circular feedback in PCA**

| What | Detail |
|---|---|
| Bug | `_score` was in `NUMERIC_COLS` in both `processor.py` and `scorer.py`. Model was trained on its own previous output — circular feedback. |
| Fix | Removed `_score` from `NUMERIC_COLS` in `processor.py`, `scorer.py`, and removed `_score: row._score` from `buildCard()` in `score.js`. |

**2. Auto bias mismatch (UI vs scorer)**

| What | Detail |
|---|---|
| Bug | When context was neutral (no clear long/short signal), scorer returned `'Undefined'` → selected B6 (max direction) model. UI displayed `AUTO (long)`. Mismatch caused confusing score swings when bias was changed. |
| Fix | `resolveCardBias()` in `score.js` now always returns `'Long'` or `'Short'`, never `'Undefined'`. Priority chain: bearish signals → Short, bullish signals → Long, neutral → Long (default). `computeAutoBias()` in `public/index.html` updated to match identical logic. |

**3. Shortlist auto-rule blocked by existing manual entry**

| What | Detail |
|---|---|
| Bug | Auto-rule guard was `if (existing) return null` — blocked re-run if ANY entry existed today (including manual stars added before 9:35 AM). Rule never fired if user had starred anything. |
| Fix | Guard now checks `if (existing && existing.items.some(i => i.method === 'auto'))` — only blocks if an auto entry already exists. Manual trigger (`force: true`) always re-runs and merges auto picks with existing manual picks. |

#### Score Verification

Manually verified IRDM scores against PCA math using `scripts/verify_irdm_score.py`:
- B4 (LONG bias, 9:40 entry): computed 12.54 → rounds to **13** ✅
- B5 (SHORT bias, 9:40 entry): computed 11.70 → rounds to **12** ✅

#### Bias Resolution Logic (Final)

```
Priority chain (highest to lowest):

1. shortTerm=BEARISH  AND  secBias=BEARISH    → Short
2. shortTerm=BEARISH  AND  secBias≠BULLISH    → Short
3. secBias=BEARISH    AND  shortTerm≠BULLISH  → Short
4. shortTerm=BULLISH  OR   secBias=BULLISH    → Long
5. longTerm=BEARISH                           → Short
6. (all neutral)                              → Long  ← default
```

#### Base Selection Table (Final)

| Bias | Entry Time | Base | Target |
|---|---|---|---|
| Long | 9:40 | B4 | upR_B (long moves from 9:40 entry) |
| Short | 9:40 | B5 | downR_B (short moves from 9:40 entry) |
| Long | 9:37 | B1 | upR_A (long moves from 9:37 entry) |
| Short | 9:37 | B2 | downR_A (short moves from 9:37 entry) |

---

### Session 4 — AI Provider Support + UI Polish

#### API key live test buttons

Added `GET /api/settings/test/:service` endpoint with real round-trip tests:

| Service | What it tests | Shows |
|---|---|---|
| `finnhub` | Fetches SPY quote | SPY current price |
| `github` | Fetches `/user` | GitHub username |
| `alpaca` | Fetches `/v2/account` | Account number + status |
| `ai` | Sends "Reply with exactly: OK" | Provider + model + reply |

#### Multi-provider AI support

Auto-detects provider from key prefix — no separate field stored:

| Key prefix | Provider | API endpoint |
|---|---|---|
| `sk-ant-` | Anthropic (Claude) | `api.anthropic.com/v1/messages` |
| `AIza` | Google Gemini | `generativelanguage.googleapis.com/v1beta/models/...` |
| anything else | OpenRouter | `openrouter.ai/api/v1/chat/completions` |

#### Settings UI — AI Provider dropdown

- Provider selector switches key placeholder, hint text, and model preset list
- Model presets per provider: 4 options each (Claude, Gemini, OpenRouter)
- Free-text model ID input alongside preset dropdown
- Provider auto-detected from stored model ID on settings load

#### Scheduler UI redesign

- Jobs rendered as cards (name, cron, status, last run)
- Edit opens a modal with day-of-week toggles, hour + minute inputs, live cron preview + human description
- Tap outside modal to dismiss

---

## Implementation Status

| Component | Status | Notes |
|---|---|---|
| Side A — TradingView Scanner | ✅ Complete | |
| Side B — Derived Calculations | ✅ Complete | |
| Side C — News & Catalyst | ✅ Complete | Finnhub + Yahoo + SEC EDGAR |
| Side D — Market Context | ✅ Complete | 15 regime labels, Morningstar sector mapping |
| Side E — Analysis Report | ✅ Complete | Feature importance, bucket analysis, AI insights |
| Side E — PCA Scoring Engine | ✅ Complete | Flask service, 6 bases, live scoring every scan |
| Side F — Shortlist | ✅ Complete | Auto-rule fixed; force flag; merges with manual picks |
| Side G — Stale Ticker Refresh | ✅ Complete | |
| Side H — R3 EOD Capture | ✅ Complete | Alpaca-based, 4:05 PM |
| Settings System | ✅ Complete | All keys, validation, masking, live test buttons |
| AI Insights | ✅ Complete | OpenRouter, Anthropic, Gemini |
| Backup / Restore | ✅ Complete | GitHub push/restore |
| Monitor Tab | ✅ Complete | Pipeline report + scheduler job history + modal editor |
| Data Warehouse | ✅ Complete | R1–R4B viewer |

---

## Full Development Roadmap

### Phase 1 — Test & Debug (current) ✅ / 🔄

Goal: validate all existing systems work correctly end-to-end on live market days.

- [ ] Run full scan on a live market day, verify all pipeline stages pass
- [ ] Confirm R1 captured at 9:36 AM with correct fields
- [ ] Confirm R2 market snapshots captured every 5 min through 10 AM
- [ ] Confirm R3 EOD capture fires at 4:05 PM with correct entry prices and R-values
- [ ] Run `POST /api/analysis/train` — verify model trains on R4A data
- [ ] View Analysis tab — verify factor importance list, bucket table, AI insights render
- [ ] Test all settings API test buttons (Finnhub, GitHub, Alpaca, AI)
- [ ] Test scheduler modal editor — edit a cron, save, verify job reschedules

---

### Phase 2 — Scoring Engine ✅ Complete

Goal: build a proper scoring model that assigns a 0–100 score to each r0 row based on historical factor performance.

**Architecture:** Two-process system — Node.js pipeline calls Python Flask scorer at `127.0.0.1:3001`.

**Tasks:**
- [x] Review Analysis report — identify top factors and meaningful bucket boundaries
- [x] Define scoring formula — PCA factor analysis with decile bucket win rates
- [x] Update `src/sideE/score.js` with final formula and bias resolution
- [x] Connect scoring to pipeline — `_score` live on every scan
- [x] Expose `_score` on Screener cards — score badge visible
- [x] Add `_score` to r0 field docs in SYSTEM_FLOW.md
- [x] Fix `_score` circular feedback — removed from PCA feature set
- [x] Fix auto bias mismatch — `resolveCardBias()` never returns Undefined
- [x] Fix shortlist auto-rule — force flag, merge with manual picks
- [x] Verify scores mathematically — IRDM B4=13, B5=12 confirmed ✅

---

### Phase 3 — Setup Detection & Live Alerts

Goal: define specific trading setups as rules, scan shortlisted stocks for matches in real time, push notifications when a match is found.

**Concept:**
A "setup" is a named checklist of conditions (price action, indicator alignment, market context, sector conditions). The tool scans all shortlisted stocks after each pipeline run and fires an alert if any stock satisfies a setup's criteria.

**Tasks:**
- [ ] Define setup schema: `{ id, name, conditions[], minScore, requireHotSector, requireRegime[] }`
- [ ] Build `src/sideI/setups.js` — setup registry + match engine
- [ ] Run setup scan after Side F in pipeline — check all shortlisted rows
- [ ] Store matches in DB table `setup_alerts (date, ticker, setupId, matchedAt, conditions_snapshot)`
- [ ] Build UI panel in Screener tab — "Live Alerts" section showing today's setup matches
- [ ] Push notification (browser push API or webhook) when new match detected
- [ ] Settings: enable/disable individual setups, configure notification target

---

### Phase 4 — Dynamic Position Sizing Engine

Goal: generate a recommended position size for each trade based on market conditions, setup quality, and historical performance of this setup in similar conditions.

**Sizing inputs:**
- **Market regime** — weight multiplier: STRONG_UP → 1.0×, CORRECTION → 0.5×, STRONG_DOWN → 0×
- **Setup quality grade** (A+/A/B/C/D) — maps to size tier
- **Historical win rate of this setup in current regime** — from analysis model
- **Account risk parameters** — max risk per trade as % of account (from settings)

**Tasks:**
- [ ] Define regime multiplier table (user-configurable in Settings)
- [ ] Define grade → base size mapping (% of max risk)
- [ ] Build `src/sideJ/sizing.js` — `computeSize(setup, regime, grade, account)` → `{ shares, dollarRisk, rationale }`
- [ ] Expose sizing recommendation in setup alert cards and trade execution panel
- [ ] Settings: account size, max risk per trade %, regime multipliers

---

### Phase 5 — Broker Integration & Trade Execution

Goal: connect to Alpaca paper/live trading API to send orders directly from the tool.

**Tasks:**
- [ ] Extend `src/alpaca/client.js` with order functions: `submitOrder`, `getPositions`, `getOrders`, `cancelOrder`
- [ ] Build `src/routes/trading.js` — order management endpoints
- [ ] Build Trade Execution panel in UI: setup summary + sizing recommendation + confirm button
- [ ] Show open positions and today's orders in a Positions tab or Screener sidebar
- [ ] Enforce pre-trade checklist before order is submitted (setup conditions, regime filter, score gate)
- [ ] Settings: toggle paper vs live trading, hard max position size limit

---

### Phase 6 — Trade Journal & Data Collection

Goal: capture rich context at entry and exit for every trade — market conditions, setup alignment, checklist state — to build a proprietary trade dataset.

**Entry snapshot (captured on order fill):**
- Timestamp, ticker, entry price, shares, dollar risk
- Setup ID, grade, score at entry
- Market regime, sector bias, sector HOT status
- Entry checklist: which conditions were met vs missed
- r0 row snapshot: full stock fields at moment of entry

**Exit snapshot (captured on position close):**
- Exit timestamp, exit price, P&L in $ and R-multiples
- Market regime at exit, sector bias at exit
- Exit checklist: conditions met at exit (trend still intact? volume confirm? etc.)
- Duration, time of day, day of week

**Tasks:**
- [ ] Define `trades` DB table schema capturing all above fields
- [ ] Build `src/sideK/journal.js` — `recordEntry(orderId, snapshot)`, `recordExit(orderId, snapshot)`
- [ ] Hook into Alpaca order fill webhooks (or poll order status)
- [ ] Build Journal tab in UI — filterable trade log, P&L summary, win rate by setup/regime/grade
- [ ] Export trades to CSV

---

### Phase 7 — Setup Grading Engine (A+/A/B/C/D)

Goal: automatically classify each trade's setup quality based on the collected journal data. The grade reflects how well the trade aligned with the model's ideal conditions.

**Grading inputs (post-trade):**
- How many entry checklist conditions were met (% alignment)
- Score at entry vs threshold (how far above the gate)
- Market regime alignment (was regime favorable for this setup?)
- Sector conditions (HOT, BULLISH)
- Historical win rate of this exact setup + regime combination

**Grade thresholds (starting point — to be tuned from data):**

| Grade | Criteria |
|---|---|
| A+ | ≥90% checklist alignment, score ≥85, regime LONG-biased, sector HOT |
| A  | ≥80% alignment, score ≥70, regime LONG-biased |
| B  | ≥70% alignment, score ≥60 |
| C  | ≥60% alignment, score ≥50, some conditions missed |
| D  | <60% alignment or score <50 — taken outside ideal conditions |

**Tasks:**
- [ ] Build `src/sideK/grading.js` — `gradeSetup(entrySnapshot)` → `{ grade, score, breakdown }`
- [ ] Store grade in `trades` table on entry
- [ ] Re-grade past trades when scoring model is updated (backfill job)
- [ ] Show grade badge on journal entries and position cards
- [ ] Feed grade distribution back into sizing engine (Phase 4)

---

## Dependency Graph

```
Phase 1 (test/debug)
    └── Phase 2 (scoring engine)
            ├── Phase 3 (setup detection) — needs score gate
            ├── Phase 4 (sizing) — needs setup + regime
            └── Phase 5 (broker) — needs sizing + setups
                    └── Phase 6 (journal) — needs trade fills
                            └── Phase 7 (grading) — needs journal data
```
