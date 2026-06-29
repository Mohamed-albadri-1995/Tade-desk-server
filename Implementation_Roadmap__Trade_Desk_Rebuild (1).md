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

**API endpoints:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/settings` | GET | All settings; sensitive keys masked as `"set"/""`  |
| `/api/settings` | POST | Validates and saves; allowlist + range validation per key |
| `/api/settings/reset-hot` | POST | Clears in-memory `hotState` |

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

- Scoring is **disconnected from the pipeline** by user request. `_score` is always `null`.
  The analysis report is view-only until the user reviews it and decides to reconnect scoring.
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

### Session 4 — AI Provider Support

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
- Model presets per provider: 4 options each
- Free-text model ID input alongside preset dropdown
- Provider auto-detected from stored model ID on settings load

---

## Implementation Status

| Component | Status | Notes |
|---|---|---|
| Side A — TradingView Scanner | ✅ Complete | Deviations documented above |
| Side B — Derived Calculations | ✅ Complete | |
| Side C — News & Catalyst | ✅ Complete | Finnhub + Yahoo + SEC EDGAR |
| Side D — Market Context | ✅ Complete | 15 regime labels, Morningstar sector mapping |
| Side E — Analysis Report | ✅ Complete | Feature importance, bucket analysis, AI insights |
| Side E — Scoring (pipeline) | ⏸ Disconnected | `_score` always null — pending design review |
| Side F — Shortlist | ✅ Complete | Auto-rule wired; produces nothing until scoring reconnected |
| Side G — Stale Ticker Refresh | ✅ Complete | |
| Side H — R3 EOD Capture | ✅ Complete | Alpaca-based, 4:05 PM |
| Settings System | ✅ Complete | All keys, validation, masking, live test buttons |
| AI Insights | ✅ Complete | OpenRouter, Anthropic, Gemini — auto-detected from key |
| Backup / Restore | ✅ Complete | GitHub push/restore |
| Monitor Tab | ✅ Complete | Pipeline report + scheduler job history |
| Data Warehouse | ✅ Complete | R1–R4B viewer |

---

## Pending Work

| Item | Priority | Notes |
|---|---|---|
| Side E scoring reconnect | High | User will review analysis report first, then decide |
| Shortlist auto-rule (auto picks) | High | Depends on scoring reconnect |
