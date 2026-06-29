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
| Analysis tab content | Medium | Sub-tabs are empty placeholders |
| Browser settings for scheduler | Low | User flagged as future item |

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
