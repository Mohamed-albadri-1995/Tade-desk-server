# Implementation Roadmap: Trade Desk Rebuild

This document outlines a phased implementation and testing strategy for the Trade Desk Rebuild project, based on the comprehensive specification. The goal is to guide the code agent through a structured development process, ensuring each component is built correctly and validated thoroughly before proceeding to the next stage. This approach minimizes integration issues and ensures strict adherence to the specification.

## Guiding Principles for Implementation

*   **Specification as Authority**: The code agent MUST strictly adhere to the `Specification for Claude - Market Tab` document. Any deviation is considered a defect.
*   **Server-Side Logic**: All business logic, calculations, and state management MUST reside on the server, as per `AR-1 Server as Source of Truth`.
*   **Exact Reproduction**: Formulas, thresholds, and classifications MUST be implemented exactly as specified (`IR-1`, `IR-2`). No hidden logic or assumptions are permitted (`IR-3`).
*   **Test-Driven Development**: Each stage includes specific validation and testing steps. Implementation for a stage is considered complete only when all tests pass (`ACCEPTANCE TEST REQUIREMENT`).

## Implementation Stages

### Stage 1: Core r0 Data Ingestion & Basic Calculations (Side A & B)

**Scope**: This stage focuses on establishing the foundation of the `r0` data. It covers fetching raw data from TradingView and performing initial server-side calculations to enrich the `r0` object.

**Specification Sections Covered**:
*   Part 2, Section 0: Server vs Browser Split (relevant server-side components)
*   Part 2, Section 1: r0 — Complete Field List & Source Responsibility (fields populated by Side A & B)
*   Part 2, Section 3: Side A — TradingView Scanner (Complete Details)
*   Part 2, Section 4: Side B — Internal Calculations (Complete)

**Implementation Tasks**:
1.  **TradingView API Integration**: Implement the logic to make `POST` requests to the TradingView scanner endpoint (`Part 2, Section 3.1`).
2.  **Scanner Filters & Columns**: Implement the common base filter (`Part 2, Section 3.3`) and common columns (`Part 2, Section 3.2`) for all scanners.
3.  **Individual Scanners**: Implement the filters and sorting for `Trend`, `Premarket`, and `Big Moves` scanners (`Part 2, Sections 3.4, 3.5, 3.6`).
4.  **TV Response Mapping**: Develop the mapping logic from TradingView's raw response to the internal `stock` object fields in `r0` (`Part 2, Section 3.7`).
5.  **rvol Resolution**: Implement the `rvol` resolution logic (`Part 2, Section 3.8`) to correctly populate `stock.rvol`.
6.  **Scanner Merge Logic**: Implement the logic to merge results from all three scanners into a single set of `r0` rows, handling `screenerKeys` and keeping the best available `stock.*` values (`Part 2, Section 3.9`).
7.  **Internal Calculations (Side B)**: Implement all derived `stock.*` fields based on the specified formulas (`Part 2, Section 4`).

**Validation & Testing (Stage 1)**:
*   **What to Test**:
    *   Successful API calls to TradingView.
    *   Correct parsing and mapping of raw TV data to `r0.stock.*` fields.
    *   Accurate `rvol` resolution based on `intraday_rvol` and `tenDay_rvol`.
    *   Correct merging of scanner results, including `screenerKeys` and `stock.*` field prioritization.
    *   Precise calculation of all `Side B` derived fields (e.g., `stock.prevClose`, `stock.gapPct`, `stock.pmRange`, `stock.adrPct`, `stock.monthRangePos`, `stock.pmAdrRatio`).
*   **How to Test (Agent)**:
    *   Create mock TradingView API responses to simulate various scenarios (e.g., missing `intraday_rvol`).
    *   Write unit tests for each calculation in `Side B` using known inputs and expected outputs (as per `ACCEPTANCE TEST REQUIREMENT`).
    *   Verify the structure and content of `r0` objects after Side A and Side B processing.
*   **How to Test (User)**:
    *   Inspect sample `r0` data (e.g., via a debug endpoint) to confirm correct population of `stock.*` fields and derived values.

### Stage 2: Market Context Engine (Side D)

**Scope**: This stage implements the Market Tab's core logic for determining market regime, sector biases, and themes, and integrating these into the `r0` object.

**Specification Sections Covered**:
*   Part 2, Section 1: r0 — Complete Field List & Source Responsibility (fields populated by Side D)
*   Part 2, Section 6: Side D — Market Context (Complete)
*   Part 3: Regime Matrix, Sector Bias, and Themes Engine
*   Part 4, Section 1: Market Snapshot Object Schema
*   Part 4, Section 3: Integration Requirements (specifically Sector Mapping and Theme Registry Lookup)

**Implementation Tasks**:
1.  **Data Fetching**: Implement fetching of index data (SPY, QQQ, etc.) and 15 sector ETFs (`Part 2, Section 6.1`).
2.  **Short-Term Market Bias**: Implement `computeMarketBiasDetail()` and its associated signals and classification logic (`Part 3, Section 2`).
3.  **Mid-Term Market Stage**: Implement `computeMarketStage()` and its signals and classification logic (`Part 3, Section 3`).
4.  **Bollinger Position**: Implement `BB%` calculation and classification (`Part 3, Section 4`).
5.  **Long-Term Market Bias**: Implement `computeLongTermBias()` and its classification logic (`Part 3, Section 5`).
6.  **Final Regime Classification**: Implement `computeRegime()` using the `REGIME_MATRIX` and Bollinger position adjustments (`Part 3, Section 6`).
7.  **Sector Short-Term Bias Engine**: Implement `sectorShortTermBias()` including relative strength, trend structure conditions, ADX filter, and score calculation (`Part 3, Section 2`).
8.  **Hot Sector Engine**: Implement the state machine for `Hot Sector` determination (Immediate Entry, Sustained Entry, Hold Rule, Cool-Off Rule) (`Part 3, Section 3`).
9.  **Themes Engine**: Implement `themesForTicker()` using `EE_TICKER_TO_THEMES` and `classifyByIndustry()` with `EE_INDUSTRY_TO_THEME` (`Part 3, Section 5`).
10. **Market Context Merge Logic**: Implement the logic to merge all computed market context data into `r0` rows, including sector matching using the provided mapping table (`Part 2, Section 6.3` and `Part 4, Section 3.2`).
11. **Market Snapshot API**: Implement the `/api/market/snapshot` endpoint to return the `Market Snapshot Object` (`Part 4, Section 2`).

**Validation & Testing (Stage 2)**:
*   **What to Test**:
    *   Correct calculation and classification of Short-Term Bias, Mid-Term Stage, Bollinger Position, and Long-Term Bias.
    *   Accurate final regime classification based on the `REGIME_MATRIX` and Bollinger adjustments.
    *   Precise sector bias and score calculations, including relative strength and ADX interpretation.
    *   Correct `Hot Sector` status transitions based on the state machine logic.
    *   Accurate theme resolution for various tickers and industries.
    *   Correct population of all `context.*` fields in `r0`.
    *   The `/api/market/snapshot` endpoint returns a valid `Market Snapshot Object` with correct data and schema, including the `slot` derived from `capturedAt`.
*   **How to Test (Agent)**:
    *   Create mock data for index and sector ETF inputs to test all possible classification paths (e.g., all `BULLISH`, all `BEARISH`, `PULLBACK`, `REBOUND` scenarios).
    *   Write unit tests for each market context calculation and classification function.
    *   Verify `r0` contents after `Side D` processing.
    *   Automated API tests for `/api/market/snapshot` endpoint.
*   **How to Test (User)**:
    *   Manually call `/api/market/snapshot` and inspect the returned JSON for correctness and schema compliance.
    *   Inspect sample `r0` data to verify `context.*` fields are populated as expected.

### Stage 3: Scoring & News/Catalyst (Side E & C)

**Scope**: This stage integrates the scoring engine and the news/catalyst fetching mechanisms, populating the remaining `r0` fields.

**Specification Sections Covered**:
*   Part 2, Section 1: r0 — Complete Field List & Source Responsibility (fields populated by Side C & E)
*   Part 2, Section 5: Side C — News & Catalyst (Complete)
*   Part 2, Section 7: Side E — Scoring Engine (Complete)

**Implementation Tasks**:
1.  **News Fetching**: Implement parallel fetching from Finnhub, Yahoo, and SEC EDGAR (`Part 2, Section 5.1`).
2.  **Catalyst Classification**: Implement the logic to classify catalysts based on patterns, assigning `label`, `color`, and `sentiment` (`Part 2, Section 5.2`).
3.  **News/Catalyst to r0**: Implement writing fetched news and classified catalyst data to `r0` (`Part 2, Section 5.3`).
4.  **Scoring Engine Input**: Ensure the scoring engine receives the full `r0` row and the current scoring model (`Part 2, Section 7.1`).
5.  **Scoring Logic**: Implement the actual scoring logic (details not provided in spec, assumed to be an external model or separate spec, but the integration point is clear). This task focuses on correctly invoking the scoring model and receiving its output.
6.  **Scoring to r0**: Implement writing the `_score` to `r0` (`Part 2, Section 1`).

**Validation & Testing (Stage 3)**:
*   **What to Test**:
    *   Successful fetching of news from all sources (mock external APIs if necessary).
    *   Correct catalyst classification for various news patterns.
    *   Accurate population of `news` and `catalyst` objects in `r0`.
    *   The scoring engine receives the correct `r0` input.
    *   The `_score` field in `r0` is populated after scoring.
*   **How to Test (Agent)**:
    *   Create mock external API responses for news sources.
    *   Write unit tests for catalyst classification logic.
    *   Verify `r0` contents after `Side C` and `Side E` processing.
*   **How to Test (User)**:
    *   Inspect sample `r0` data to verify `news` and `catalyst` fields are populated correctly.
    *   Verify `_score` values in `r0` for a set of test cases.

### Stage 4: Shortlist Registry & Logic (Side F)

**Scope**: This stage implements the server-side Shortlist Registry, including the auto-shortlisting rule and manual override mechanisms.

**Specification Sections Covered**:
*   Part 2, Section 0: Server vs Browser Split (Shortlist Auto-Rule, Shortlist Registry, Shortlist Toggle)
*   Part 2, Section 1: r0 — Complete Field List & Source Responsibility (`inShortlist` field)
*   Part 2, Section 8: Side F — Shortlist Registry (Complete)
*   Part 2, Section 9: API Endpoints (relevant shortlist APIs)

**Implementation Tasks**:
1.  **Shortlist Registry Schema**: Implement the database schema for the Shortlist Registry, including `date`, `items` (with `ticker`, `addedAt`, `method`, `score`, `price`, `change`, `sector`), `exported`, and `exportedAt` (`Part 2, Section 8.1`).
2.  **Auto Rule Logic**: Implement the daily auto-shortlisting rule, including fetching `r0` rows, filtering by `_score >= 70`, sorting, taking the top 5, capturing `r0` data, and saving to the database (`Part 2, Section 8.2`).
3.  **Manual Override Logic**: Implement the logic for toggling shortlist status, including creating/updating today's entry, adding/removing tickers, and capturing `r0` data (`Part 2, Section 8.3`).
4.  **Manual Override Rules**: Ensure all manual override rules are strictly enforced (`Part 2, Section 8.4`).
5.  **`inShortlist` Field**: Implement updating the `inShortlist` boolean field in `r0` when a stock is added or removed from the shortlist.
6.  **Shortlist APIs**: Implement the API endpoints for toggling, retrieving today's shortlist, retrieving all shortlists, and exporting (`Part 2, Section 9`).

**Validation & Testing (Stage 4)**:
*   **What to Test**:
    *   The auto-shortlist rule correctly identifies and stores the top 5 stocks based on `_score`.
    *   Captured `score`, `price`, `change`, and `sector` values in the Shortlist Registry match the `r0` state at the time of shortlisting.
    *   Manual toggling correctly adds/removes tickers and updates `inShortlist` in `r0`.
    *   Manual override rules (e.g., manual additions persist) are correctly applied.
    *   Shortlist API endpoints return correct data and adhere to the schema.
*   **How to Test (Agent)**:
    *   Simulate `r0` states to test auto-shortlisting under various conditions (e.g., no eligible stocks, fewer than 5 eligible stocks).
    *   Write unit tests for manual override logic, covering add, remove, and rule enforcement.
    *   Automated API tests for all `/api/shortlist/*` endpoints.
    *   Direct database inspection to verify Shortlist Registry entries.
*   **How to Test (User)**:
    *   Manually trigger the auto-shortlist rule (if a debug API is available) and inspect the resulting shortlist.
    *   Use the Shortlist Tab UI (if available, otherwise API calls) to manually add/remove stocks and verify persistence.
    *   Call shortlist API endpoints to confirm data.

### Stage 5: Data Warehouse Integration & APIs (Part 5)

**Scope**: This stage focuses on implementing the Data Warehouse, including its various registers and the APIs to access them.

**Specification Sections Covered**:
*   Part 5: Data Warehouse Tab (Register Management & Storage)

**Implementation Tasks**:
1.  **Data Warehouse Architecture**: Set up the database structure for all registers (R0, R1, R2, R3A, R3B, R4A, R4B, Shortlist) as described in the architecture diagram (`Part 5, Section 1`).
2.  **Register Population**: Implement the mechanisms to populate each register:
    *   **R0**: Continuously updated from the live `r0` data.
    *   **R1 (Frozen Screener)**: Capture `r0` data at 9:36 AM ET, setting `capturedAt` to `r0.lastUpdated` (`Part 5, Section 3, R1`).
    *   **R2 (Market Snapshots)**: Store `Market Snapshot Objects` from the Market Tab, deriving `slot` from `capturedAt` (`Part 5, Section 3, R2`).
    *   **R3A/R3B (EOD Outcome)**: Integrate with Yahoo Finance to fetch EOD outcomes and store them (`Part 5, Section 3, R3A/R3B`).
    *   **R4A/R4B (Merged)**: Implement logic to merge R1 with R3A/R3B data (`Part 5, Section 3, R4A/R4B`).
    *   **Shortlist**: Integrate with the existing Shortlist Registry to populate this view (`Part 5, Section 3, Shortlist Register`).
3.  **Data Warehouse APIs**: Implement all specified API endpoints for the Data Warehouse (`Part 5, Section 1, API Layer`):
    *   `GET /api/warehouse/:register/:date`
    *   `GET /api/warehouse/:register/latest`
    *   `GET /api/warehouse/available-dates`
    *   `GET /api/warehouse/export/:register/:date`
    *   `GET /api/warehouse/export/all`
    *   `POST /api/warehouse/import`
    *   `POST /api/warehouse/collect`

**Validation & Testing (Stage 5)**:
*   **What to Test**:
    *   Each register (R0-R4B, Shortlist) is correctly populated with data adhering to its schema.
    *   R1 captures `r0` data at the precise time and `capturedAt` is correctly set.
    *   R2 correctly stores Market Snapshots and derives the `slot` field.
    *   R3A/R3B successfully fetch and store EOD data.
    *   R4A/R4B correctly merge data from R1 and R3A/R3B.
    *   All Data Warehouse API endpoints function correctly, returning expected data for various registers and dates.
*   **How to Test (Agent)**:
    *   Write integration tests to verify data flow from source systems (r0, Market Tab, Yahoo Finance mocks) into the respective registers.
    *   Automated API tests for all `/api/warehouse/*` endpoints, covering different `register` and `date` parameters.
    *   Direct database queries to inspect the contents of each register.
*   **How to Test (User)**:
    *   Use the Data Warehouse Tab UI (if available, otherwise API calls) to browse registers, select dates, and verify data accuracy.
    *   Test export/import functionalities.

### Stage 6: Scheduler & End-to-End Flow

**Scope**: This final stage integrates all components with the central scheduler to ensure automated, timely execution of the entire Trade Desk pipeline.

**Specification Sections Covered**:
*   Part 2, Section 10: Scheduler (Complete)
*   Overall system architecture and data flow.

**Implementation Tasks**:
1.  **Scheduler Implementation**: Implement the server-side scheduler to trigger the full scan pipeline and the Shortlist Auto-Rule according to the defined schedules (`Part 2, Section 10.1` and `10.2`).
2.  **Full Scan Pipe Orchestration**: Ensure the full scan pipeline (TV → r0 → Market Context → Scoring → News) runs in the correct sequence and all components are properly chained.
3.  **Error Handling & Logging**: Implement robust error handling and comprehensive logging across all modules to facilitate debugging and monitoring.

**Validation & Testing (Stage 6)**:
*   **What to Test**:
    *   The full scan pipeline executes automatically at the specified frequencies (7:00 AM – 9:00 AM ET every 30 minutes, 9:00 AM – 10:00 AM ET every 5 minutes, etc.).
    *   The Shortlist Auto-Rule runs precisely at 9:35 AM ET daily.
    *   All `r0` fields are updated correctly after a full scan cycle.
    *   The Shortlist Registry is updated correctly after the auto-rule runs.
    *   No data inconsistencies or errors occur during automated runs.
*   **How to Test (Agent)**:
    *   Configure the scheduler with short intervals for testing purposes (e.g., run every minute) and monitor system behavior.
    *   Automated end-to-end tests that simulate a full day's operation, verifying all outputs.
    *   Review logs for errors or unexpected behavior.
*   **How to Test (User)**:
    *   Observe the system over a full market day (or simulated day) to confirm all scheduled tasks execute as expected.
    *   Verify the freshness of data in the Screener Tab and Data Warehouse registers at various points throughout the day.
    *   Check system logs for any critical errors or warnings.

This roadmap provides a clear, actionable plan for implementing the Trade Desk Rebuild, with built-in validation to ensure the final product meets all specified requirements. The code agent should follow these stages sequentially, performing the specified tests at each step.
