# Implementation Roadmap: Trade Desk Rebuild

This document outlines a phased implementation and testing strategy for the Trade Desk Rebuild project. It is updated after each session to reflect what has been built, what changed from the original spec, and what is pending.

---

## Guiding Principles for Implementation

*   **Specification as Authority**: The code agent MUST strictly adhere to the `Specification for Claude - Market Tab` document. Any deviation is considered a defect.
*   **Server-Side Logic**: All business logic, calculations, and state management MUST reside on the server, as per `AR-1 Server as Source of Truth`.
*   **Exact Reproduction**: Formulas, thresholds, and classifications MUST be implemented exactly as specified (`IR-1`, `IR-2`). No hidden logic or assumptions are permitted (`IR-3`).
*   **Test-Driven Development**: Each stage includes specific validation and testing steps. Implementation for a stage is considered complete only when all tests pass (`ACCEPTANCE TEST REQUIREMENT`).

---

## Session Change Log

### Session 1 (Build Session — All core stages implemented)

The following deviations from the original spec were made intentionally. Each must be tracked here.

#### Side A — TradingView Scanner

| What Changed | Spec Said | What We Did | Reason |
|---|---|---|---|
| `ignore_unknown_fields` | `false` | `true` | TV returns unexpected fields; `false` caused silent failures |
| Ticker extraction | `d[0]` (ticker-view column) | `rawTV.s` (symbol field from TV row) | TV changed `ticker-view` column from string to rich object mid-session |
| Common base filter | 3 OR-branches (common, preferred, dr) | 4 OR-branches (added `fund` type) | Old Chrome extension had 4 branches; missing `fund` excluded valid stocks |
| Resilience layer | Not in spec | Added `validateTVStructure()`, `COLUMN_EXPECTED_TYPES`, safe extractors `num()` / `str()` | Detects future TV API format changes; logs once per restart |

#### Side D — Market Context

| What Changed | Spec Said | What We Did | Reason |
|---|---|---|---|
| Sector taxonomy | GICS names only in mapping table | Added Morningstar taxonomy to `TV_SECTOR_TO_MARKET_KEY` | TV stock scanner returns Morningstar names, not GICS; sectors were always NEUTRAL without this fix |
| `context.regime` | Store `regime.label` string | Store `regime.slug` (e.g. `CORRECTION`) | Slug is stable for programmatic comparison; label is human-readable display only |
| `context.regimeLabel` | Not in spec | Added as separate field | Carries the human-readable label for UI display |

#### Side E — Scoring Engine

| What Changed | Spec Said | What We Did | Reason |
|---|---|---|---|
| Regime comparison | Compare label string | Compare slug directly | Label string matching was fragile; slug is deterministic |
| Score display | Show `_score` | Show `—` (blank) | Scoring engine not yet finalized; will be rebuilt from scratch |

#### New: Settings System (Not in Original Spec)

A browser-accessible settings panel was added to allow runtime control of key variables without server restart.

**New DB keys added to `settings` table:**

| Key | Default | Description |
|---|---|---|
| `hotImmediateThreshold` | 60 | Score to enter HOT instantly |
| `hotSustainedThreshold` | 40 | Score to sustain toward HOT |
| `hotSustainedSessions` | 3 | Consecutive sessions needed for sustained HOT |
| `hotFloorThreshold` | 20 | Score floor to remain HOT |
| `coolOffDays` | 2 | Sessions below floor before losing HOT |
| `sectorBullishThreshold` | 20 | Score above this = BULLISH |
| `sectorBearishThreshold` | -20 | Score below this = BEARISH |
| `shortlistMinScore` | 70 | Min score for auto-shortlist |
| `shortlistTopN` | 5 | Max picks for auto-shortlist |
| `finnhubApiKey` | `''` | Finnhub key (stored in DB, masked in API) |

**New API endpoints:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/settings` | GET | Returns all settings; Finnhub key masked as `"set"/""`  |
| `/api/settings` | POST | Validates and saves settings; allowlist + range validation per key |
| `/api/settings/reset-hot` | POST | Clears in-memory `hotState`; all sectors re-evaluated on next scan |

**What previously was hardcoded, now reads from DB:**
- `sideD/sectors.js`: all 5 hot sector thresholds + 2 bias thresholds
- `sideF/shortlist.js`: `shortlistMinScore` and `shortlistTopN`
- `sideC/news.js`: Finnhub key (DB first, then `process.env` fallback)

**`hotState` behavior:**
- Lives in memory in `sideD/sectors.js`
- Resets on server restart or when `POST /api/settings/reset-hot` is called
- Changing thresholds in DB does NOT retroactively change HOT status — it only affects entry/exit logic on the next scan

#### New: UI Additions (Not in Original Spec)

| Addition | Location | Notes |
|---|---|---|
| Analysis tab (5th tab) | `public/index.html` | Empty placeholder; two sub-tabs: Screener Analysis, Trade Analysis |
| Settings tab (6th tab) | `public/index.html` | 4 sections: Hot Sector, Sector Bias, Shortlist, API Keys |
| Mobile tab scroll | `public/index.html` | Tab bar now `overflow-x: auto; white-space: nowrap` |

#### Frontend Fixes

| Fix | Root Cause |
|---|---|
| Frontend showed 0 stocks | API returns `{count, rows}` but frontend assigned whole object; fixed to extract `.rows` |
| Screener filter never matched | Filter checked `keys.includes('trend')` but keys are `['Trend','Pre-Mkt','Big Move']`; fixed to `keys.some(k => k.includes('trend'))` |
| Market tab not refreshing after scan | `runScan()` only called `loadRegistry()`; fixed to also call `loadMarket()` in parallel |
| Card showed regime slug not label | Card used `ctx.regime` which was now slug; fixed to use `ctx.regimeLabel` |

---

## Current Implementation Status

| Stage | Status | Notes |
|---|---|---|
| Stage 1: Side A + B (TV Scanner + Calculations) | ✅ Complete | With deviations documented above |
| Stage 2: Side D (Market Context) | ✅ Complete | With deviations documented above |
| Stage 3: Side C + E (News + Scoring) | ⚠️ Partial | News/catalyst implemented; scoring engine shows `—` pending redesign |
| Stage 4: Side F (Shortlist) | ✅ Complete | Now reads min score and topN from DB |
| Stage 5: Data Warehouse | ✅ Complete | All registers implemented; APIs working |
| Stage 6: Scheduler | ✅ Complete | Reviewed; safe concurrency guard in place |
| Stage 7: Settings System | ✅ Complete | New addition; not in original spec |

---

## Pending Work

| Item | Priority | Notes |
|---|---|---|
| Scoring engine redesign | High | User will design from scratch; `_score` currently shows `—` |
| Side G — Stale Ticker Refresh | High | See full design below |
| Pipeline Orchestration & Monitor | High | See full design below |
| R3A / R3B capture path | High | ✅ Complete — Alpaca-based, 4:05 PM EOD job, tickers from R1 |
| Analysis tab content | Medium | Sub-tabs are empty placeholders |
| Browser settings for scheduler | Low | User flagged as future item |

---

## Design: Side G — Stale Ticker Refresh

### Problem

After every scan, stocks that no longer meet scanner filter criteria are marked `liveNow: false` but remain in r0 with frozen price data from the last time the scanner returned them. The user needs those stocks to stay visible on cards until EOD but with continuously updated prices — not stale numbers.

### Why a new Side

This is a separate data-fetch concern from the scanner (Side A). The scanner is filter-driven — it only returns tickers that qualify. Side G is quote-driven — it fetches specific tickers by name regardless of whether they qualify for any scanner. It uses the same TradingView API and same column definitions, but the request structure is different (ticker list instead of filter rules).

### TradingView API — Quote Mode

The same endpoint (`scanner.tradingview.com/america/scan`) accepts a `symbols` field with a list of full TV symbols (`EXCHANGE:TICKER`). When `symbols` is populated, the `filter` array is ignored — TV returns data for exactly those tickers.

```js
{
  columns: COMMON_COLUMNS,        // identical to scanner
  symbols: { tickers: ['NASDAQ:AAPL', 'NYSE:GME'] },
  range: [0, 200],
  markets: ['america'],
  options: { lang: 'en' },
  ignore_unknown_fields: true,
}
```

The response shape is identical to the scanner response. The same `mapTVRow` function works without modification.

### File: `src/sideG/staleFetch.js`

```
fetchStaleQuotes(tvSymbols)          → calls TV API, returns [{ ticker, stock }]
refreshStaleInR0(staleRows)          → extracts tvSymbols, calls fetchStaleQuotes,
                                        updates r0 stock fields + derived fields,
                                        preserves liveNow: false + context + inShortlist
```

**Important constraints on `refreshStaleInR0`:**
- MUST NOT change `liveNow` — it stays `false`
- MUST NOT change `date`, `id`, `firstSeen`, `inShortlist`
- MUST NOT change `context` (regime, secBias etc.) — that is only refreshed by Side D during a full scan
- MUST update: all `stock.*` fields + re-run `applyDerivedFields` to recompute derived values

### When it runs

After `upsertRows()` in the pipeline, before `syncShortlistToR0()`:

```
markAllStale()
upsertRows(withScores)           ← live tickers, liveNow: true
Side G: refreshStaleInR0()       ← stale tickers, liveNow: false, fresh price data
syncShortlistToR0()
```

### Failure behavior

If Side G fails (TV timeout, network error), pipeline continues. The stale rows keep their last known data. This is logged in the pipeline monitor (see below).

### Batching

TV API has no documented rate limit for this endpoint but we cap the symbol list at 200 per request (same as scanner `range`). If more than 200 stale tickers exist (unlikely on a normal day), batch in groups of 200.

### What happens at midnight flush

`r0.clearAll()` removes everything. Side G has nothing to clean up — it only reads from and writes to r0.

---

## Design: Pipeline Orchestration & Monitor

### Problem

Currently `runFullScan()` runs all stages silently. There is no way to know which stage succeeded, how many rows it processed, how long it took, or whether the cards being served reflect a complete or partial run. Side F (shortlist sync) also has no visibility.

### Design

Replace the current minimal `scanStatus` object with a full `PipelineReport` that is built during every scan and exposed via API.

#### `PipelineReport` shape

```js
{
  scanId: string,           // uuid, unique per run
  startedAt: number,        // epoch ms
  completedAt: number,      // epoch ms, null if in progress
  ok: boolean,              // true only if ALL non-optional stages succeeded
  stages: {
    sideA: { ok, rowCount, duration, error },    // TV scanners → merge result
    sideB: { ok, rowCount, duration, error },    // derived fields applied
    sideD: { ok, duration, error },              // market snapshot built
    sideG: { ok, staleCount, refreshed, duration, error }, // stale refresh
    sideE: { ok: true, note: 'disconnected — _score null' },
    sideF: { ok, shortlistCount, duration, error },  // syncShortlistToR0
  },
  r0Summary: {
    total: number,       // all rows in r0 after scan
    liveNow: number,     // rows with liveNow: true
    stale: number,       // rows with liveNow: false
    inShortlist: number, // rows with inShortlist: true
  },
}
```

#### Storage

- Last completed report stored in memory in `src/pipeline.js` as `lastReport`
- Previous `scanStatus` object updated to include `lastReport`

#### API

`GET /api/scan/status` — already exists, extend to include `lastReport` in response

#### UI

Settings tab or new Monitor section: shows last scan's stage breakdown as a table — which stage ran, how many rows, how long, any error.

### Stage reporting pattern (inside pipeline.js)

Each stage is wrapped:
```js
const t0 = Date.now();
try {
  const result = await sideX();
  report.stages.sideX = { ok: true, rowCount: result.length, duration: Date.now() - t0 };
} catch (err) {
  report.stages.sideX = { ok: false, duration: Date.now() - t0, error: err.message };
  // decide: fatal (throw) or non-fatal (continue with partial data)
}
```

Side A failure → fatal (nothing to scan)
Side B failure → fatal (derived fields are required downstream)
Side D failure → non-fatal (context is enriched best-effort; already handled this way)
Side G failure → non-fatal (stale rows keep last data)
Side E → always ok (disconnected, no failure possible)
Side F failure → non-fatal (inShortlist flags may be wrong until next scan)

---

## Design: R3A (Target Entry) / R3B (Alternative Entry) — IMPLEMENTED

**Status: ✅ Complete**

### Names
- **R3A = Target Entry** — first entry scenario, earlier in the session
- **R3B = Alternative Entry** — second entry scenario, later in the session

### Data Source
Alpaca Market Data API v2 (credentials stored in settings: `alpacaApiKey`, `alpacaApiSecret`).

### Ticker Universe
All tickers from today's R1 snapshot (`r1_frozen WHERE date = today`). R3 shares the same universe as R1. If R1 is empty for today, R3 capture is skipped and the reason is reported to the Monitor tab.

### Entry Points
| Register | Entry Bar | Entry Price |
|---|---|---|
| R3A | 9:37 ET 1-min bar | **open** of that bar |
| R3B | 9:40 ET 1-min bar | **open** of that bar |

### HH / LL
- `hh_a / ll_a`: highest high / lowest low of all 1-min bars from 9:37 ET through 16:00 ET (inclusive)
- `hh_b / ll_b`: highest high / lowest low of all 1-min bars from 9:40 ET through 16:00 ET (inclusive)
- Source: intraday 1-min bars from Alpaca, full session 9:30–16:00 ET in one call per batch

### ATR14
- Computed from the 14 most recent completed trading days **before today** (today excluded)
- Source: daily bars from Alpaca, ~30 calendar days back ending the day before capture
- Formula: `ATR_i = max(H−L, |H−prevC|, |L−prevC|)`, ATR14 = mean of last 14 values

### R Values
- `up_r_a = (hh_a − entry_price_a) / atr14`
- `down_r_a = (entry_price_a − ll_a) / atr14`
- Same formula for B

### Trigger
Single scheduler job: **`5 16 * * 1-5`** (4:05 PM ET, Mon–Fri).
Runs after market close so all bars (including 15:59–16:00) are settled.
Both R3A and R3B are written in a single transaction per ticker.

### Files
- `src/alpaca/client.js` — `fetchIntradayBars`, `fetchDailyBars`, `computeATR14`
- `src/sideH/capture.js` — `captureR3(date)` with R1 pre-flight check
- `src/scheduler.js` — "R3 EOD Capture 4:05 PM" job
- `src/routes/settings.js` — `alpacaApiKey`, `alpacaApiSecret` (masked)
- `src/db/index.js` — default empty values for both keys

### Read Path (already existed)
- `getRegisterData('R3A', date)` and `getRegisterData('R3B', date)` in `src/warehouse/registers.js`
- `getRegisterData('R4A', date)` and `getRegisterData('R4B', date)` join R1 + R3A/B for combined analysis

---

## Test Coverage Plan

The following 8 parts divide the codebase for systematic test coverage. Each part must be tested in order. Tests live in `tests/`.

| Part | Files | What to Test |
|---|---|---|
| **Part 1** | `sideB/calculations.js` | All 6 derived field formulas (exact values) |
| **Part 2** | `sideA/tvScanner.js` | TV row mapping, rvol resolution, ticker extraction, safe extractors |
| **Part 3** | `sideA/merge.js` | Scanner merge logic, screenerKeys union, field prioritization |
| **Part 4** | `sideD/regime.js` | Short-term bias, mid-term stage, BB%, long-term bias, regime matrix |
| **Part 5** | `sideD/sectors.js` | Sector score formula, bias classification, hot state machine |
| **Part 6** | `sideE/scoring.js` | Score calculation for each factor, clamp 0–100 |
| **Part 7** | `sideF/shortlist.js` | Auto-rule logic, manual toggle, min score / topN from DB |
| **Part 8** | `routes/settings.js` | Allowlist validation, range validation, GET masking, reset-hot |

---

## Implementation Stages (Original, with current status)

### Stage 1: Core r0 Data Ingestion & Basic Calculations (Side A & B)
**Status: ✅ Complete (with deviations — see change log)**

**Implementation Tasks**:
1.  **TradingView API Integration**: Implement the logic to make `POST` requests to the TradingView scanner endpoint (`Part 2, Section 3.1`).
2.  **Scanner Filters & Columns**: Implement the common base filter (`Part 2, Section 3.3`) and common columns (`Part 2, Section 3.2`) for all scanners.
3.  **Individual Scanners**: Implement the filters and sorting for `Trend`, `Premarket`, and `Big Moves` scanners (`Part 2, Sections 3.4, 3.5, 3.6`).
4.  **TV Response Mapping**: Develop the mapping logic from TradingView's raw response to the internal `stock` object fields in `r0` (`Part 2, Section 3.7`).
5.  **rvol Resolution**: Implement the `rvol` resolution logic (`Part 2, Section 3.8`) to correctly populate `stock.rvol`.
6.  **Scanner Merge Logic**: Implement the logic to merge results from all three scanners into a single set of `r0` rows, handling `screenerKeys` and keeping the best available `stock.*` values (`Part 2, Section 3.9`).
7.  **Internal Calculations (Side B)**: Implement all derived `stock.*` fields based on the specified formulas (`Part 2, Section 4`).

### Stage 2: Market Context Engine (Side D)
**Status: ✅ Complete (with deviations — see change log)**

### Stage 3: Scoring & News/Catalyst (Side E & C)
**Status: ⚠️ Partial**

News and catalyst fetching is implemented. Scoring engine shows `—` pending redesign.

### Stage 4: Shortlist Registry & Logic (Side F)
**Status: ✅ Complete**

`shortlistMinScore` and `shortlistTopN` now read from DB instead of hardcoded.

### Stage 5: Data Warehouse Integration & APIs (Part 5)
**Status: ✅ Complete**

### Stage 6: Scheduler & End-to-End Flow
**Status: ✅ Complete**

Scheduler reviewed. Safe concurrency guard (`scanStatus.running`) prevents double-scans.

### Stage 7: Settings System (New — Not in Original Spec)
**Status: ✅ Complete**

See "New: Settings System" in the change log above for full details.
