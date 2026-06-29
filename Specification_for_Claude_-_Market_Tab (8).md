# Specification for Claude - Market Tab

## Part 1: Implementation Directives and Architecture Rules

### IMPLEMENTATION DIRECTIVE

**Purpose**

This document is the authoritative specification for this module.

The implementation MUST exactly reproduce the behavior, formulas, thresholds, classifications, dependencies, and outputs defined in this specification.

Any deviation from this specification is considered a defect.

---

### ARCHITECTURE RULES

**AR-1 Server as Source of Truth**

The server is the only source of truth.

All business logic, calculations, scoring, classification, state transitions, statistical analysis, and decision making MUST be performed on the server.

The browser MUST only display data returned by server APIs.

No business logic is allowed in the frontend.

---

**AR-2 Frontend Restrictions**

The frontend MAY:

- Render tables.
- Render charts.
- Render cards.
- Render heat maps.
- Render badges.
- Handle user interaction.
- Handle sorting.
- Handle filtering.
- Handle pagination.
- Trigger API requests.

The frontend MUST NOT:

- Calculate scores.
- Determine market regime.
- Determine sector bias.
- Determine hot sectors.
- Classify themes.
- Determine scanner qualification.
- Perform factor analysis.
- Perform statistical calculations.
- Determine registry status.
- Make trading decisions.

---

### IMPLEMENTATION RULES

**IR-1 Exact Formula Reproduction**

Every mathematical formula in this document MUST be implemented exactly as specified.

The AI MUST NOT:

- simplify formulas;
- optimize formulas;
- approximate formulas;
- replace formulas;
- reinterpret formulas.

---

**IR-2 Exact Threshold Reproduction**

Every threshold value MUST be implemented exactly.

Thresholds MUST NOT be:

- modified;
- rounded;
- tuned;
- optimized;
- inferred.

Examples:

If specification states:

`SPY daily change > +0.30%`

then implementation MUST use:

`0.30%`

and not:

`0.25%`
`0.50%`
`0.35%`

---

**IR-3 No Hidden Logic**

The AI MUST NOT add:

- hidden heuristics;
- additional indicators;
- fallback logic;
- extra filters;
- extra weights;
- extra states;
- extra scoring adjustments.

Only logic explicitly defined in the specification is permitted.

---

**IR-4 Ambiguity Handling**

If any requirement is incomplete, ambiguous, or contradictory:

STOP implementation.

Ask questions.

Do NOT make assumptions.

---

### TRACEABILITY REQUIREMENT

Every visible UI component MUST have complete traceability.

For every UI component provide:

| UI Component | Source Function | API Field |
|---|---|---|

Example:

| Market Bias Badge | computeMarketBias() | market.bias |
| Final Regime Card | computeRegime() | market.regime |
| Sector Heat Map | computeSectorBias() | market.sectors |

No UI element may exist without traceability.

---

### DEPENDENCY REQUIREMENT

Each module MUST explicitly declare:

**Inputs**

Data consumed from:

- APIs
- Database tables
- Other modules

**Outputs**

Data published to:

- APIs
- Database tables
- Other modules

Circular dependencies are prohibited.

---

### ACCEPTANCE TEST REQUIREMENT

Before implementation, create deterministic tests for every rule.

Example:

Input:

`SPY daily change = +0.31%`

Expected output:

`Signal = +1`

Input:

`SPY daily change = +0.30%`

Expected output:

`Signal = 0`

Input:

`SPY daily change = -0.31%`

Expected output:

`Signal = -1`

Implementation is considered complete only when all tests pass.

---

### FORBIDDEN ACTIONS

The AI MUST NOT:

- omit any requirement;
- omit any field;
- omit any calculation;
- omit any state;
- omit any UI element;
- move calculations to frontend;
- invent missing logic;
- replace indicators;
- change formulas;
- change thresholds;
- change weights;
- silently simplify implementation.

Any omission is considered a defect.

---

### COMPLETION REQUIREMENT

Before marking the implementation complete, provide:

1. List of implemented requirements.
2. List of API endpoints.
3. List of database schema changes.
4. List of new functions.
5. List of tests created.
6. List of assumptions made.

If assumptions were made, implementation is NOT complete until approved.

---

# Trade Desk Rebuild — Screener Tab (r0‑Centric Design, V8 — Final with Integration)

---

## 0. Server vs Browser Split

| Component | Runs On | Responsibility |
|---|---|---|
| All Sides (A, B, C, D, E) | Server | Full data pipeline: fetch, calculate, enrich, score, store in r0. |
| Scheduler | Server | Triggers the pipeline on the defined schedule. |
| Shortlist Auto‑Rule | Server | Runs once per day at 9:35 AM ET. Time trigger is server‑side. Creates that day's shortlist registry entry. Never updates previous days. |
| Shortlist Registry | Server | Stored in the database on the server. Contains one entry per day, each with its own list of items. |
| Shortlist Export | Server | Generates TradingView‑formatted export for any saved date. |
| API Endpoints | Server | Serve r0 data, serve shortlist registry, accept shortlist toggles, accept manual scan triggers, export shortlists. |
| Shortlist Toggle (POST) | Server | Updates inShortlist in r0 and adds/removes from today's shortlist registry entry. |
| Card Building | Browser | Reads r0 from API, renders cards. No data processing. |
| Shortlist Tab | Browser | UI display only. Reads from shortlist registry (server API). Displays date‑grouped list. |
| “Load News” Button | Browser | UI trigger only. Calls server API; server fetches news, updates r0, returns data. |

---

## 1. r0 — Complete Field List & Source Responsibility

| Field Name | Type | Populated By | Card Location |
|---|---|---|---|
| **Identity & Lifecycle** | | | |
| id | string | Scheduler | — |
| ticker | string | Side A (TV) | Top of card |
| date | string | Scheduler | — |
| firstSeen | timestamp | Scheduler | — |
| lastUpdated | timestamp | Scheduler | "Live now · updated X" |
| liveNow | boolean | Scheduler | "● Live now" indicator |
| screenerKeys | array | Side A (Merge) | Badges: "Trend", "Pre-Mkt", "Big Move" |
| **Stock Data (from TV)** | | | |
| stock.tvSymbol | string | Side A (TV) | — |
| stock.price | number | Side A (TV) | "Price: $21.45" |
| stock.open | number | Side A (TV) | (used in calculations) |
| stock.change | number | Side A (TV) | "+247.09%" (next to ticker) |
| stock.vwap | number | Side A (TV) | "VWAP: $18.00" |
| stock.ema9 | number | Side A (TV) | "9: $13.27" |
| stock.ema13 | number | Side A (TV) | "13: $13.17" |
| stock.ema20 | number | Side A (TV) | "20: $12.88" |
| stock.ema50 | number | Side A (TV) | "50: $16.23" |
| stock.sma5 | number | Side A (TV) | "5-day MA: $10.85" |
| stock.monthHigh | number | Side A (TV) | "H $39.86" |
| stock.monthLow | number | Side A (TV) | "L $2.63" |
| stock.dayHigh | number | Side A (TV) | (used for Move calculation) |
| stock.dayLow | number | Side A (TV) | (used for Move calculation) |
| stock.atr | number | Side A (TV) | "ADR: $7.61" |
| stock.mcap | number | Side A (TV) | "Market cap: $15.97M" |
| stock.floatShares | number | Side A (TV) | "Float: 740.9K sh" |
| stock.shortFloat | number | Side A (TV) | — |
| stock.sector | string | Side A (TV) | "Sector: Consumer Durables" |
| stock.industry | string | Side A (TV) | "Restaurants" |
| stock.pmHigh | number | Side A (TV) | "H $17.86" (PM Range line) |
| stock.pmLow | number | Side A (TV) | "L $6.71" (PM Range line) |
| **Stock Data (Derived / Internal)** | | | |
| stock.prevClose | number | Side B (Calc) | "Prev close: $6.18" |
| stock.gapPct | number | Side B (Calc) | — |
| stock.pmRange | number | Side B (Calc) | "PM Range: $11.15" |
| stock.adrPct | number | Side B (Calc) | "35.5% of price" |
| stock.monthRangePos | number | Side B (Calc) | "51% into range" |
| stock.pmAdrRatio | number | Side B (Calc) | "PM / ADR: 1.47x" |
| stock.rvol | number | Side A (TV mapping) | "RVOL: 52.2x" |
| **Market Context** | | | |
| context.themes | array | Side D (Market) | "Themes: · RESTAURANTS" |
| context.broadResolved | string | Side D (Market) | (for sector mapping) |
| context.regime | string | Side D (Market) | "Regime: 🟠⤵ Correction (bull intact)" |
| context.longTerm | string | Side D (Market) | "Long term: BULLISH" |
| context.midTerm | string | Side D (Market) | "Mid term: DOWNTREND" |
| context.shortTerm | string | Side D (Market) | "Short term: NEUTRAL" |
| context.secBias | string | Side D (Market) | "Sector: Consumer Durables — BULLISH" |
| context.secScore | number | Side D (Market) | "▲ leading +37" |
| context.secHot | boolean | Side D (Market) | (used for hot badge) |
| **News & Catalyst** | | | |
| news | object | Side C (News) | News list + "Fetched X ET" |
| catalyst | object or null | Side C (Catalyst) | "⚡ M&A" (at top of news) |
| **Scoring** | | | |
| score_at_entry | number or null | Side E (Scoring) | — |
| score_model_ts | string | Side E (Scoring) | — |
| _score | number or null | Side E (Scoring) | "Score: 51" |
| **User Action** | | | |
| inShortlist | boolean | Side F (Shortlist) | "☆ Shortlist" / "★ In List" |

---

## 2. r0 Completeness Confirmation

| Card Element | r0 Field | ✅ |
|---|---|---|
| Ticker + Change % | ticker, stock.change | ✅ |
| Screener badges | screenerKeys | ✅ |
| Score | _score | ✅ |
| Shortlist star | inShortlist | ✅ |
| Sector · Industry | stock.sector, stock.industry | ✅ |
| Live now indicator | liveNow, lastUpdated | ✅ |
| Themes | context.themes | ✅ |
| Sector with bias + score | context.broadResolved, context.secBias, context.secScore | ✅ |
| Long term | context.longTerm + label | ✅ |
| Mid term | context.midTerm + label | ✅ |
| Short term | context.shortTerm | ✅ |
| Regime | context.regime + stance + guidance | ✅ |
| Price · Prev close | stock.price, stock.prevClose | ✅ |
| VWAP | stock.vwap | ✅ |
| Daily EMAs | stock.ema9, stock.ema13, stock.ema20, stock.ema50 | ✅ |
| 5‑day MA | stock.sma5, stock.price, stock.atr | ✅ |
| 1‑month range | stock.monthHigh, stock.monthLow, stock.price | ✅ |
| Monthly position | stock.monthRangePos | ✅ |
| Market cap | stock.mcap | ✅ |
| Float | stock.floatShares | ✅ |
| RVOL | stock.rvol | ✅ |
| Move (× ATR) | stock.atr, stock.dayHigh, stock.dayLow, stock.prevClose | ✅ |
| ADR | stock.atr, stock.adrPct | ✅ |
| PM Range | stock.pmHigh, stock.pmLow, stock.pmRange | ✅ |
| PM / ADR | stock.pmAdrRatio | ✅ |
| News list | news | ✅ |
| Catalyst | catalyst | ✅ |
| News fetch time | news.fetchedAt | ✅ |

r0 is complete. No additional data is needed to render the card.

---

## 3. Side A — TradingView Scanner (Complete Details)

### 3.1. Endpoint

```
POST https://scanner.tradingview.com/america/scan?label-product=screener-stock
```

### 3.2. Common Columns (Requested for Every Scanner)

```json
[
  "ticker-view",
  "open",
  "close",
  "change",
  "relative_volume_10d_calc",
  "relative_volume_intraday|5",
  "market_cap_basic",
  "sector",
  "industry",
  "change_from_open",
  "VWAP",
  "High.1M",
  "Low.1M",
  "high",
  "low",
  "ATR",
  "short_percentage_of_float",
  "float_shares_outstanding",
  "EMA9",
  "EMA13",
  "EMA20",
  "EMA50",
  "SMA5",
  "premarket_high",
  "premarket_low"
]
```

### 3.3. Common Base Filter (Applied to All Scanners)

```json
{
  "operator": "and",
  "operands": [
    {
      "operation": {
        "operator": "or",
        "operands": [
          {
            "operation": {
              "operator": "and",
              "operands": [
                { "expression": { "left": "type", "operation": "equal", "right": "stock" } },
                { "expression": { "left": "typespecs", "operation": "has", "right": ["common"] } }
              ]
            }
          },
          {
            "operation": {
              "operator": "and",
              "operands": [
                { "expression": { "left": "type", "operation": "equal", "right": "stock" } },
                { "expression": { "left": "typespecs", "operation": "has", "right": ["preferred"] } }
              ]
            }
          },
          {
            "operation": {
              "operator": "and",
              "operands": [
                { "expression": { "left": "type", "operation": "equal", "right": "dr" } }
              ]
            }
          },
          {
            "operation": {
              "operator": "and",
              "operands": [
                { "expression": { "left": "type", "operation": "equal", "right": "fund" } },
                { "expression": { "left": "typespecs", "operation": "has_none_of", "right": ["etf", "mutual", "closedend"] } }
              ]
            }
          }
        ]
      }
    },
    {
      "expression": {
        "left": "typespecs",
        "operation": "has_none_of",
        "right": ["pre-ipo"]
      }
    }
  ]
}
```

---

### 3.4. Scanner 1 — Trend

**Filters:**

| Left | Operation | Right |
|---|---|---|
| close | egreater | 20 |
| close | egreater | SMA5 |
| close | egreater | VWAP |
| close\|1W | greater | VWAP\|1W |
| close\|1M | greater | VWAP\|1M |
| EMA50\|1 | greater | EMA120\|1 |
| close\|1 | egreater | EMA50\|1 |
| average_volume_90d_calc | greater | 1000000 |
| VWAP | egreater | SMA75\|5 |
| relative_volume_intraday\|5 | greater | 3 |
| relative_volume_10d_calc | greater | 1.5 |
| close | egreater | 1 |

**Sort:**

```json
{
  "sortBy": "change",
  "sortOrder": "desc"
}
```

**Full Request Body:**

```json
{
  "columns": [/* common columns */],
  "filter": [/* filters above */],
  "filter2": { /* common base filter */ },
  "ignore_unknown_fields": true,
  "markets": ["america"],
  "options": { "lang": "en" },
  "range": [0, 50],
  "sort": { "sortBy": "change", "sortOrder": "desc" },
  "symbols": {}
}
```

---

### 3.5. Scanner 2 — Premarket

**Filters:**

| Left | Operation | Right |
|---|---|---|
| close | egreater | 0.5 |
| close | egreater | 1 |
| average_volume_10d_calc | greater | 2000000 |
| relative_volume_10d_calc | greater | 3 |
| premarket_volume | greater | 1500000 |

**Sort:**

```json
{
  "sortBy": "premarket_volume",
  "sortOrder": "desc"
}
```

**Full Request Body:**

```json
{
  "columns": [/* common columns */],
  "filter": [/* filters above */],
  "filter2": { /* common base filter */ },
  "ignore_unknown_fields": true,
  "markets": ["america"],
  "options": { "lang": "en" },
  "range": [0, 50],
  "sort": { "sortBy": "premarket_volume", "sortOrder": "desc" },
  "symbols": {}
}
```

---

### 3.6. Scanner 3 — Big Moves

**Filters:**

| Left | Operation | Right |
|---|---|---|
| relative_volume_10d_calc | greater | 10 |
| close | egreater | 2 |
| average_volume_10d_calc | greater | 2000000 |

**Sort:**

```json
{
  "sortBy": "relative_volume_10d_calc",
  "sortOrder": "desc"
}
```

**Full Request Body:**

```json
{
  "columns": [/* common columns */],
  "filter": [/* filters above */],
  "filter2": { /* common base filter */ },
  "ignore_unknown_fields": true,
  "markets": ["america"],
  "options": { "lang": "en" },
  "range": [0, 50],
  "sort": { "sortBy": "relative_volume_10d_calc", "sortOrder": "desc" },
  "symbols": {}
}
```

---

### 3.7. Mapping TV Response → Internal stock Object

Each scanner returns data in the same format. The server maps each item using the following table:

| TV Column | Internal Field | Notes |
|---|---|---|
| rawTV.s (row symbol field) | ticker | Use `rawTV.s`, not `ticker-view` column. TV changed `ticker-view` to a rich object. Strip exchange prefix: `NASDAQ:AAPL → AAPL`. Store full symbol as `stock.tvSymbol` before stripping. |
| rawTV.s (row symbol field) | stock.tvSymbol | Store full exchange-prefixed symbol (e.g. `NASDAQ:AAPL`). Used for TradingView watchlist export and stale ticker refresh (Side G). |
| close | stock.price | |
| open | stock.open | |
| change | stock.change | Percentage change from previous close |
| VWAP | stock.vwap | |
| EMA9 | stock.ema9 | |
| EMA13 | stock.ema13 | |
| EMA20 | stock.ema20 | |
| EMA50 | stock.ema50 | |
| SMA5 | stock.sma5 | |
| High.1M | stock.monthHigh | |
| Low.1M | stock.monthLow | |
| high | stock.dayHigh | |
| low | stock.dayLow | |
| ATR | stock.atr | |
| market_cap_basic | stock.mcap | |
| float_shares_outstanding | stock.floatShares | |
| short_percentage_of_float | stock.shortFloat | |
| relative_volume_intraday\|5 | → decision point → stock.rvol | Preferred. Use if present and > 0. |
| relative_volume_10d_calc | → decision point → stock.rvol | Fallback. Use if intraday is missing or ≤ 0. |
| premarket_high | stock.pmHigh | |
| premarket_low | stock.pmLow | |
| sector | stock.sector | |
| industry | stock.industry | |

Note: change_from_open is not stored directly. It is used in Side B to calculate gapPct.

---

### 3.8. rvol Resolution (Step‑by‑Step)

```
For each stock returned by TV:

Step 1: Get intraday_rvol = rawTV["relative_volume_intraday|5"]
Step 2: Get tenDay_rvol    = rawTV["relative_volume_10d_calc"]

Step 3: if (intraday_rvol !== null && intraday_rvol !== undefined && intraday_rvol > 0) {
            stock.rvol = intraday_rvol
        } else {
            stock.rvol = tenDay_rvol
        }

Step 4: Store stock.rvol in r0.
```

Important: There is only one stock.rvol field in r0. The server decides which TV column populates it during the mapping stage. This single field is displayed on the card as RVOL.

---

### 3.9. Merge Logic (After All Three Scanners Run)

```
Input: trendResults[], premarketResults[], bigmovesResults[]

Step 1: Create an empty map keyed by ticker.
Step 2: For each result array:
          For each stock in the array:
            If ticker not in map:
              Add ticker with stock data and screenerKey = [scannerName]
            Else:
              Merge screenerKeys (union)
              Merge stock data (keep first non‑null value for each field)

Step 3: The merged map becomes the set of rows to upsert into r0.
Step 4: For each merged row:
          - Set screenerKeys = merged keys
          - Keep best available stock.* values
          - All other fields (context, news, scoring) are added by other sides.
```

---

## 3.10. Side G — Stale Ticker Refresh (Added)

**Purpose:** After every scan, stocks that no longer meet scanner filter criteria are marked `liveNow: false` but must stay on cards until EOD with fresh price data. Side G fetches updated quotes for those tickers from TradingView using the same API in quote mode (specific symbols, no filter).

**When it runs:** Inside `runFullScan()`, after `upsertRows()` writes the live scan results and before `syncShortlistToR0()`.

**Request format:** Same endpoint as scanners. Use `symbols.tickers` instead of `filter`. No `filter2` needed when fetching by symbol list.

```json
{
  "columns": [/* same COMMON_COLUMNS as scanners */],
  "symbols": { "tickers": ["NASDAQ:AAPL", "NYSE:GME"] },
  "range": [0, 200],
  "markets": ["america"],
  "options": { "lang": "en" },
  "ignore_unknown_fields": true
}
```

**Response mapping:** Identical to scanner — use the same `mapTVRow` function and `applyDerivedFields`.

**What gets updated in r0:** Only `stock.*` fields (all of them, via the same mapping). `liveNow` stays `false`. `context`, `date`, `id`, `firstSeen`, `inShortlist`, `_score` are NOT changed.

**Batching:** Cap at 200 symbols per request. If more than 200 stale tickers exist, batch in groups of 200.

**Failure behavior:** Non-fatal. If Side G fails, pipeline continues. Stale rows keep their last known data. Logged in pipeline monitor.

---

## 4. Side B — Internal Calculations (Complete)

Server‑side. Runs after Side A populates the stock.* fields.

| Field | Formula | Inputs |
|---|---|---|
| stock.prevClose | price / (1 + change/100) | stock.price, stock.change |
| stock.gapPct | (open - prevClose) / prevClose * 100 | stock.open, stock.prevClose |
| stock.pmRange | pmHigh - pmLow | stock.pmHigh, stock.pmLow |
| stock.adrPct | atr / price * 100 | stock.atr, stock.price |
| stock.monthRangePos | (price - monthLow) / (monthHigh - monthLow) * 100 | stock.price, stock.monthHigh, stock.monthLow |
| stock.pmAdrRatio | pmRange / atr | stock.pmRange, stock.atr |

---

## 5. Side C — News & Catalyst (Complete)

Server‑side, async. Runs after the initial r0 write. Does not block the scan.

### 5.1. Sources (Fetched in Parallel)

| Source | Endpoint | What It Writes |
|---|---|---|
| Finnhub (optional) | finnhub.io/api/v1/company-news?symbol={ticker} | news.finnhub |
| Yahoo (unofficial) | query1.finance.yahoo.com/v1/finance/search?q={ticker} | news.yahoo |
| SEC EDGAR | efts.sec.gov/LATEST/search-index?q={ticker}&forms=8-K,S-3 | news.edgar |

### 5.2. Catalyst Classification

| Priority | Pattern | Label | Sentiment | Color |
|---|---|---|---|---|
| 1 | FDA approval\|PDUFA approval\|clinical trial success | FDA Approval | Bull | #4ade80 |
| 2 | FDA CRL\|clinical trial fail\|FDA rejection | FDA Rejection | Bear | #ef4444 |
| 3 | earnings beat\|EPS beat\|revenue beat | Earnings Beat | Bull | #34d399 |
| 4 | earnings miss\|EPS miss\|revenue miss | Earnings Miss | Bear | #f87171 |
| 5 | acquisition\|takeover\|buyout\|M&A | M&A | Bull | #a78bfa |
| 6 | offering\|dilution\|secondary\|shelf\|at-the-market | Dilution | Bear | #f87171 |
| 7 | analyst upgrade\|outperform\|overweight\|buy rating | Upgrade | Bull | #86efac |
| 8 | analyst downgrade\|underperform\|underweight\|sell rating | Downgrade | Bear | #f87171 |
| 9 | short interest\|short squeeze | Short Squeeze | Bull | #fb923c |
| 10 | insider buying\|CEO bought\|director bought | Insider Buy | Bull | #fbbf24 |
| 11 | insider selling\|CEO sold\|director sold | Insider Sell | Bear | #f87171 |
| 12 | partnership\|contract\|deal\|collaboration | Partnership | Bull | #67e8f9 |
| 13 | lawsuit\|investigation\|SEC charge | Legal Risk | Bear | #f472b6 |

### 5.3. Written to r0

```
r0[ id ].news = {
  finnhub: [...],
  yahoo: [...],
  edgar: [...],
  fetchedAt: timestamp
}

r0[ id ].catalyst = {
  label: "...",
  color: "...",
  sentiment: "bull" | "bear" | "neutral"
}
```

---

## 6. Side D — Market Context (Complete)

Server‑side. Runs during the scan pipeline. Refreshes the Market Tab data each time it runs.

### 6.1. Data Fetched

- Index data: SPY, QQQ, IWM, DIA, VIX (price, change, week change, SMAs, BB, ADX)
- Sector ETFs: 15 sector ETFs (price, change, week change, ADX, RVOL, VWAP)

### 6.2. Computed Outputs

| Computed Value | Written To |
|---|---|
| Themes (array) | context.themes |
| Regime (slug) | context.regime |
| Long‑term bias (BULLISH/BEARISH/etc) | context.longTerm |
| Mid‑term stage (UPTREND/DOWNTREND/etc) | context.midTerm |
| Short‑term bias (BULLISH/NEUTRAL/BEARISH) | context.shortTerm |
| Sector bias (BULLISH/NEUTRAL/BEARISH) | context.secBias |
| Sector score (-100 to +100) | context.secScore |
| Sector hot status (boolean) | context.secHot |
| Broad sector resolution | context.broadResolved |

### 6.3. Merge Logic

```
Step 1: Get latest Market Snapshot from Side D engine.
Step 2: For each r0 row:
          - Match stock.sector to sector data in Snapshot.
          - Set context.broadResolved, context.secBias, context.secScore, context.secHot.
          - Set context.regime, context.longTerm, context.midTerm, context.shortTerm from Snapshot.
          - Resolve themes using themesForTicker() and set context.themes.
Step 3: Write context to r0 row.
```

---

## 7. Side E — Scoring Engine (Complete)

Server‑side. Runs after all other sides (A, B, D) have populated their fields.

### 7.1. Input

- The full r0 row (all stock.*, context.*, catalyst, etc.)
- The current scoring model (loaded from the database)



---

## 8. Side F — Shortlist Registry (Complete)

Server‑side. Stored in the database.

### Overview: Shortlist Tab Design and Process

The Shortlist Tab provides users with a curated list of stocks, generated either automatically by server-side rules or manually by user interaction. This section details the server-side **Shortlist Registry**, which is the authoritative source for all shortlisted items. The registry captures a snapshot of key `r0` data (score, price, change, sector) at the moment a stock is added, ensuring data integrity and historical accuracy. The browser-side Shortlist Tab is purely a display layer, consuming data from this server-side registry via dedicated APIs and reflecting the current state of the user's shortlisted stocks.



### 8.1. Shortlist Registry Schema

```javascript
{
  date: "2026-06-28",           // ET date (primary key)
  items: [
    {
      ticker: "SDOT",
      addedAt: 1782627624934,   // timestamp when added
      method: "manual" | "auto", // how it was added
      score: 75,                  // score at time of shortlisting
      price: 123.45,                // price at time of shortlisting
      change: 1.23,                 // change % at time of shortlisting
      sector: "Technology"          // sector at time of shortlisting
    }
  ],
  exported: false,              // whether it has been exported to TV
  exportedAt: null              // timestamp of last export
}
```

### 8.2. Auto Rule Logic (Runs Once Per Day at 9:35 AM ET)

```
Step 1: Get today's date (ET).

Step 2: Check if a shortlist entry for today already exists in the database.
        - If exists, log "Shortlist already created for today" and exit.

Step 3: Get all today's r0 rows where `_score >= 70`.
        - If no rows, log "No eligible stocks" and exit.

Step 4: Sort by `_score` descending.

Step 5: Take the top 5.

Step 6: Create a new shortlist entry for today. For each of the top 5 `r0` rows, capture the following fields:
        - `ticker`
        - `addedAt` (current timestamp)
        - `method`: "auto"
        - `score`: `r0._score`
        - `price`: `r0.stock.price`
        - `change`: `r0.stock.change`
        - `sector`: `r0.stock.sector`

        The full shortlist entry will be:
        {
          date: today,
          items: [ { ticker: "T1", addedAt: now, method: "auto", score: S1, price: P1, change: C1, sector: Sec1 }, ... ],
          exported: false,
          exportedAt: null
        }

Step 7: For each selected ticker:
          - Set `inShortlist = true` in r0.

Step 8: Save the shortlist entry to the database.

Step 9: (Optional) Push WebSocket notification.
```

### 8.3. Manual Override Logic (User Clicks Star)

```
Step 1: Get today's date (ET).

Step 2: Get today's shortlist entry (create if not exists).

Step 3: If the ticker is already in the items list:
          - Remove it
          - Set `inShortlist = false` in r0
        Else:
          - Add it with method: "manual". When adding, capture the following fields from the current `r0` row:
            - `score`: `r0._score`
            - `price`: `r0.stock.price`
            - `change`: `r0.stock.change`
            - `sector`: `r0.stock.sector`
          - Set `inShortlist = true` in r0

Step 4: Save the shortlist entry to the database.
```

### 8.4. Manual Override Rules

- If a ticker is manually added, it stays even if it later fails the auto rule.
- If a ticker is manually removed, it is removed from the shortlist registry even if it meets the auto rule conditions.
- Manual entries are never touched by the auto rule.
- The auto rule never runs on a day that already has a shortlist entry.

---

## 9. API Endpoints (Complete)

| Endpoint | Method | Description |
|---|---|---|
| `/api/registry/today` | GET | Returns today's r0 rows (sorted: liveNow first, then _score desc) |
| `/api/registry/all` | GET | Returns all r0 rows (for debugging) |
| `/api/scan/run` | POST | Manually trigger a scan |
| `/api/scan/status` | GET | Returns current scan status (last run, next run) |
| `/api/shortlist/toggle/:ticker` | POST | Toggle manual shortlist status for today |
| `/api/shortlist/today` | GET | Returns today's shortlist registry entry |
| `/api/shortlist/all` | GET | Returns all shortlist days (date‑grouped) |
| `/api/shortlist/export/:date` | GET | Exports a specific date's shortlist in TradingView format (comma‑separated) |
| `/api/shortlist/run-rule` | POST | Manually trigger the auto rule for today (dev/debug) |
| `/api/news/:ticker` | GET | Fetch news for a specific ticker (on‑demand) |

---

## 10. Scheduler (Complete)

Server‑side. Runs on the defined schedule.

### 10.1. Full Scan Schedule

| Time Period | Frequency | What Runs |
|---|---|---|
| 7:00 AM – 9:00 AM ET | Every 30 minutes | Full scan pipeline (TV → r0 → Market Context → Scoring → News). |
| 9:00 AM – 10:00 AM ET | Every 5 minutes | Full scan pipeline. |
| 10:00 AM – 7:00 AM (next day) | Every 3 hours | Full scan pipeline. |

### 10.2. Shortlist Auto‑Rule

| Time | What Runs |
|---|---|
| 9:35 AM ET (once daily) | Shortlist auto‑rule (scans r0, creates today's shortlist entry). |

### 10.3. Full Scan Pipe

(Content from original file ends here.)

## Part 2: Actual Market Tab Implementation (from code)

### Actual Market Tab Implementation (from code)

The Market tab has 3 major layers:

1. Market Index Dashboard (idxRow)
2. Short/Mid/Long Market Analysis
3. Final Regime Classification

---

### 1. MARKET INDEX DASHBOARD (idxRow)

Displayed indices:

`SPY`
`QQQ`
`DIA`
`IWM`
`VIX`

For each index the UI displays:

`Name`
`Current Close`
`Daily % Change`
`Weekly % Change`

Example:

`SPY`
`$612.50`
`+1.35%`
`Week +2.8%`

No calculations are performed here except formatting.

The required input object is:

```json
{
    "close": 612.50,
    "change": 1.35,
    "weekChg": 2.8
}
```

---

### 2. SHORT-TERM MARKET BIAS

Function:

`computeMarketBiasDetail()`

Purpose:

Determine:

`BULLISH`
`NEUTRAL`
`BEARISH`

---

**Mathematical Logic**

The system generates points.

Final score:

`MarketScore = Σ signal_points`

---

**Signal 1**

SPY daily change

Formula:

```
if SPY_change > +0.3%
    points = +1

if SPY_change < -0.3%
    points = -1

otherwise
    points = 0
```

---

**Signal 2**

QQQ daily change

Exactly same formula.

---

**Signal 3**

IWM daily change

Exactly same formula.

---

**Signal 4**

VIX daily change

Formula:

```
if VIX_change > +3%
    points = -2

else if VIX_change > +1%
    points = -1

else if VIX_change < -2%
    points = +1

else
    points = 0
```

VIX has asymmetric weighting.

Rising VIX hurts market.

Falling VIX helps market.

---

**Signal 5**

SPY weekly change

Formula:

```
if SPY_week_change > +1%
    points = +1

if SPY_week_change < -1%
    points = -1

otherwise
    points = 0
```

---

**Signal 6**

QQQ weekly change

Same formula.

---

**Final Short-Term Score**

```
Score
=
SPY_day
+
QQQ_day
+
IWM_day
+
VIX
+
SPY_week
+
QQQ_week
```

---

**Classification**

```
if Score >= +3

→ BULLISH


if Score <= -3

→ BEARISH


otherwise

→ NEUTRAL
```

---

### 3. MID-TERM MARKET STAGE

Function:

`computeMarketStage()`

Source:

Prefer:

`SPY`

Fallback:

`QQQ`

Inputs:

`Close`
`5DMA`
`20DMA`

---

**Variables:**

Total signals:

`6`

---

**Daily Trend Signals**

**Signal 1**

`Close > 5DMA`

Bull if true.

---

**Signal 2**

`Close > 20DMA`

Bull if true.

---

**Signal 3**

`5DMA > 20DMA`

Bull if true.

---

**Signal 4**

`20DMA > 50DMA`

Bull if true.

---

**Hourly Signals**

**Signal 5**

`1H Close > 20H MA`

Bull if true.

---

**Signal 6**

`1H 5MA > 20H MA`

Bull if true.

---

**Bull Count**

Define:

`BullCount`

=

`number of bullish signals`

Range:

`0 → 6`

Additional variables:

`CA5`

=

`Close > 5DMA`

`S5A20`

=

`5DMA > 20DMA`

---

**Stage Classification**

**Uptrend**

`BullCount >= 5`

OR

`BullCount = 4`
AND
`Close > 5DMA`

Result:

`UPTREND`

---

**Pullback**

`BullCount ∈ [3,4]`

AND

`Close < 5DMA`

AND

`5DMA > 20DMA`

Result:

`PULLBACK`

Meaning:

Long-term structure intact.

Short-term correction.

---

**Rebound**

`BullCount ∈ [2,3]`

AND

`Close > 5DMA`

AND

`5DMA < 20DMA`

Result:

`REBOUND`

Meaning:

Countertrend bounce.

---

**Sideways**

`BullCount ∈ [2,3]`

All remaining cases.

---

**Downtrend**

Everything else.

---

### 4. BOLLINGER POSITION

The code computes:

```
BB%
=
(Close − LowerBand)
/
(UpperBand − LowerBand)
```

Constrained to:

`0 ≤ BB% ≤ 1`

---

**Classification:**

`BB% ≥ 0.75`

→ `UPPER`

`BB% ≤ 0.25`

→ `LOWER`

otherwise

`MID`

---

### 5. LONG-TERM MARKET BIAS

Function:

`computeLongTermBias()`

Source:

Prefer:

`SPY`

Fallback:

`QQQ`

Inputs:

`Close`
`50DMA`
`200DMA`

---

**Variables:**

`Above200`

=

`Close > 200DMA`

`GoldenCross`

=

`50DMA > 200DMA`

---

**Classification**

**Bullish**

`Above200 = TRUE`

AND

`GoldenCross = TRUE`

Result:

`BULLISH`

---

**Recovering**

`Above200 = TRUE`

AND

`GoldenCross = FALSE`

Result:

`RECOVERING`

---

**Weakening**

`Above200 = FALSE`

AND

`GoldenCross = TRUE`

Result:

`WEAKENING`

---

**Bearish**

`Above200 = FALSE`

AND

`GoldenCross = FALSE`

Result:

`BEARISH`

---

### 6. FINAL REGIME CLASSIFICATION

Function:

`computeRegime()`

Inputs:

`LongTermBias`
`MidTermStage`
`BollingerPosition`

Output:

`FinalRegime`

## Part 3: Regime Matrix, Sector Bias, and Themes Engine

### 1. REGIME MATRIX (Actual Code)

The final regime is produced by:

```
Final Regime
=
REGIME_MATRIX[
    LongTermBias
    +
    MidTermStage
]
```

The exact matrix from the code is:

| Long-Term Bias | Mid-Term Stage | Final Regime |
|---|---|---|
| BULLISH | UPTREND | STRONG_UP |
| BULLISH | PULLBACK | PULLBACK_BULL |
| BULLISH | REBOUND | UP |
| BULLISH | SIDEWAYS | CHOP_BULL |
| BULLISH | DOWNTREND | CORRECTION |
| RECOVERING | UPTREND | WEAK_UP |
| RECOVERING | PULLBACK | RECOVERY |
| RECOVERING | REBOUND | RECOVERY |
| RECOVERING | SIDEWAYS | BASING |
| RECOVERING | DOWNTREND | DOWN |
| WEAKENING | UPTREND | RECOVERY |
| WEAKENING | PULLBACK | TOPPING |
| WEAKENING | REBOUND | BEAR_RALLY |
| WEAKENING | SIDEWAYS | CHOP_BEAR |
| WEAKENING | DOWNTREND | DOWN |
| BEARISH | UPTREND | BEAR_RALLY |
| BEARISH | PULLBACK | DOWN |
| BEARISH | REBOUND | BEAR_RALLY |
| BEARISH | SIDEWAYS | BASING |
| BEARISH | DOWNTREND | STRONG_DOWN |

After this step Bollinger position modifies the regime:

```
STRONG_UP + BB Upper
            ↓
EXTENDED_UP

STRONG_DOWN + BB Lower
            ↓
CAPITULATION
```

---

**Regime Catalog**

Each regime also publishes a directional bias.

| Regime | Trading Bias |
|---|---|
| EXTENDED_UP | LONG |
| STRONG_UP | LONG |
| UP | LONG |
| WEAK_UP | LONG |
| PULLBACK_BULL | LONG |
| RECOVERY | NEUTRAL |
| BASING | NEUTRAL |
| CHOP_BULL | NEUTRAL |
| CHOP_BEAR | NEUTRAL |
| CORRECTION | NEUTRAL |
| TOPPING | SHORT |
| BEAR_RALLY | NEUTRAL |
| DOWN | SHORT |
| STRONG_DOWN | SHORT |
| CAPITULATION | SHORT |

This trading bias is later consumed by the Scanner and Registry.

---

### 2. SECTOR SHORT-TERM BIAS ENGINE

The code computes:

```
SectorBias
=
sectorShortTermBias(
    sector,
    sectorETF,
    SPY
)
```

Every sector receives:

`BULLISH`
`NEUTRAL`
`BEARISH`

plus a numerical score.

---

**Inputs**

For every sector ETF:

Examples:

`XLK`
`XLF`
`XLI`
`XLY`
`XLE`
`XLV`
`XLC`
`XLU`
`XLB`
`XLRE`
`XLP`

The following data are required:

`Close`
`Daily Change %`
`Weekly Change %`
`VWAP`
`ADX`
`SMA5`
`SMA20`
`SMA50`
`SMA200`

SPY data are also required.

---

**Sector Relative Strength**

The code compares sector performance against SPY.

Mathematically:

```
RelativeStrength
=
Sector Daily %
−
SPY Daily %
```

Example:

`XLK +2.5%`
`SPY +1.0%`

`RS = +1.5%`

Positive RS means sector leadership.

Negative RS means lagging sector.

---

**Trend Structure**

The following trend conditions are evaluated.

**Condition 1**

`Close > SMA20`

Bullish if true.

---

**Condition 2**

`SMA20 > SMA50`

Bullish if true.

---

**Condition 3**

`Close > VWAP`

Bullish if true.

---

**Condition 4**

`Relative Strength > 0`

Bullish if true.

---

**Condition 5**

`Weekly Change > 0`

Bullish if true.

---

**ADX Strength Filter**

Trend quality uses:

`ADX`

Interpretation:

| ADX | Meaning |
|---|---|
| <20 | weak trend |
| 20-25 | emerging trend |
| >25 | strong trend |

High ADX amplifies confidence.

---

**Sector Score**

The engine converts the above conditions into a total score.

Output:

`score ∈ [-100,+100]`

Classification:

```
score > threshold
        ↓
BULLISH

score < threshold
        ↓
BEARISH

otherwise
        ↓
NEUTRAL
```

The exact thresholds are configurable through settings.

---

### 3. HOT SECTOR ENGINE

The code contains a complete state machine.

A sector does not become hot immediately every time.

The logic is:

**Immediate Entry**

A sector becomes HOT instantly when:

```
SectorScore
≥
HotImmediateThreshold
```

---

**Sustained Entry**

If:

```
SectorScore
≥
HotSustainedThreshold
```

for

`N consecutive sessions`

the sector becomes HOT.

---

**Hold Rule**

Once HOT:

Remain HOT while:

```
SectorScore
≥
HotFloorThreshold
```

---

**Cool-Off Rule**

A HOT sector loses HOT status only after:

```
SectorScore
<
HotFloorThreshold
```

for

`More than CoolOffDays`

This introduces hysteresis and prevents:

`HOT`
`NOT HOT`
`HOT`
`NOT HOT`

flipping every day.

---

### 4. SECTOR HEAT MAP

The Heat Map displays all sectors sorted by:

`SectorScore descending`

For each sector the UI shows:

`Sector Name`
`ETF`
`Daily %`
`Weekly %`
`Bias`
`Bias Score`
`ADX`
`Hot Status`

Example:

`Technology`
`XLK`
`+2.1%`
`Week +4.5%`
`BULLISH +42`
`ADX 31`
`🔥 HOT`

Heatmap ordering:

`Highest Sector Score`
`        ↓`
`Lowest Sector Score`

The heatmap therefore acts as a sector ranking engine.

---

### 5. THEMES ENGINE

The code currently uses:

`themesForTicker()`

**Logic:**

**Step 1**

Check hardcoded mapping.

Example:

`NVDA → AI`
`PLTR → AI`
`RKLB → Space`

The mapping is stored in:

`EE_TICKER_TO_THEMES`

This is the primary source.

---

**Step 2**

If ticker is not found:

Use industry classification.

```
Industry
       ↓
classifyByIndustry()
       ↓
Theme
```

Example:

`Semiconductors`
`        ↓`
`AI`

or

`Uranium`
`        ↓`
`Nuclear`

---

**Theme Output**

Each stock receives:

```json
{
    "themes": [
        "AI",
        "Quantum",
        "Nuclear"
    ]
}
```

These themes are later consumed by:

Scanner scoring.

Registry scoring.

Theme leadership ranking.

Factor analysis.

## Part 4: Screener Tab Integration (Integration Point)

This section defines the contract for providing data to the Screener Tab.

### 1. Market Snapshot Object Schema

The Market Tab MUST provide a `Market Snapshot Object` with the following schema:

```javascript
{
  capturedAt: "2026-06-28T09:35:00.000Z",
  date: "2026-06-28",
  // Note: The 'slot' field used in the R2 Data Warehouse register is derived from the 'capturedAt' timestamp (e.g., "09:35").
  
  indices: {
    SPY: { close, change, weekChg, sma5, sma20, sma50, sma200, bbUpper, bbLower },
    QQQ: { close, change, weekChg, sma5, sma20, sma50, sma200, bbUpper, bbLower },
    IWM: { close, change, weekChg },
    DIA: { close, change },
    VIX: { close, change, weekChg }
  },
  
  shortTerm: { result: "BULLISH|NEUTRAL|BEARISH", score, signals: [] },
  midTerm: { result: "UPTREND|PULLBACK|SIDEWAYS|DOWNTREND", stageLabel, src, bull, unk, bb, bbPct, signals: [] },
  longTerm: { result: "BULLISH|RECOVERING|WEAKENING|BEARISH", label, src, dist, above200, goldenCross },
  
  regime: { slug, label, icon, color, stance, guidance, confidence, aligned },
  
  sectors: {
    "Technology": { etf, close, change, weekChg, adx, bias, score, hot, dRS, wRS },
    // ... all 15 sectors
  },
  
  breakoutNames: ["AAPL", "MSFT"]
}
```

### 2. API Endpoint

The Market Tab MUST expose the following endpoint:

| Endpoint | Method | Description |
|---|---|---|
| `/api/market/snapshot` | GET | Returns the latest Market Snapshot Object. |

### 3. Integration Requirements

1.  **Automatic Refresh**: The snapshot MUST be refreshed according to the Market Tab's defined schedule:
    - 7:00 AM – 9:00 AM ET: Every 30 minutes.
    - 9:00 AM – 10:00 AM ET: Every 5 minutes.
    - 10:00 AM – 7:00 AM (next day): Every 3 hours.
2.  **Sector Mapping**: Ensure all 15 sector ETFs (XLK, XLF, XLI, XLY, XLE, XLV, XLC, XLU, XLB, XLRE, XLU, SMH, IBB, XRT, XTN) are included. The Screener Tab MUST match TradingView's `stock.sector` to the Market Tab's `sectors[name]` key exactly. To facilitate this, the following mapping table MUST be used:

    | TradingView Sector Name | Market Tab ETF Key |
    |---|---|
    | Technology | Technology (XLK) |
    | Financial | Financial (XLF) |
    | Industrial | Industrial (XLI) |
    | Consumer Cyclical | Consumer Discretionary (XLY) |
    | Energy | Energy (XLE) |
    | Healthcare | Health Care (XLV) |
    | Communication Services | Communication Services (XLC) |
    | Utilities | Utilities (XLU) |
    | Basic Materials | Materials (XLB) |
    | Real Estate | Real Estate (XLRE) |
    | Consumer Defensive | Consumer Staples (XLP) |
    | Semiconductors | SMH |
    | Biotechnology | IBB |
    | Retail | XRT |
    | Transportation | XTN |

3.  **Regime Mapping**: The Screener Tab MUST use the `regime.label` string from the Market Snapshot to populate the `context.regime` field in `r0`.
4.  **Theme Registry Lookup**: Themes are not provided per-stock in the snapshot. The Screener Tab MUST use the provided `EE_TICKER_TO_THEMES` and `EE_INDUSTRY_TO_THEME` registries to resolve and populate `context.themes`.
5.  **Data Flow**: The Screener Tab consumes the latest available snapshot. During the 7:00 AM – 9:00 AM window, the Screener will use the snapshot updated every 30 minutes.

---

## Part 5: Data Warehouse Tab (Register Management & Storage)

### 1. Data Warehouse Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DATA WAREHOUSE (Server)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        REGISTERS (Database)                         │   │
│  │                                                                     │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │   │
│  │  │   R0     │  │   R1     │  │   R2     │  │  R3A     │  ┌──────┐ │   │
│  │  │ (Live)   │  │ (Frozen  │  │ (Market  │  │ (EOD     │  │Short-│ │   │
│  │  │          │  │  9:36)   │  │ Snap)    │  │  9:37)   │  │list  │ │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │Reg.  │ │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              └──────┘ │   │
│  │  │  R3B     │  │  R4A     │  │  R4B     │                       │   │
│  │  │ (EOD     │  │ (R1+     │  │ (R1+     │                       │   │
│  │  │  9:40)   │  │  R3A)    │  │  R3B)    │                       │   │
│  │  └──────────┘  └──────────┘  └──────────┘                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         API LAYER                                   │   │
│  │                                                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ GET /api/warehouse/:register/:date                         │   │   │
│  │  │ GET /api/warehouse/:register/latest                        │   │   │
│  │  │ GET /api/warehouse/available-dates                         │   │   │
│  │  │ GET /api/warehouse/export/:register/:date                  │   │   │
│  │  │ GET /api/warehouse/export/all                              │   │   │
│  │  │ POST /api/warehouse/import                                 │   │   │
│  │  │ POST /api/warehouse/collect                                │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP / WebSocket
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BROWSER (Display Only)                           │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      DATA WAREHOUSE TAB                             │   │
│  │                                                                     │   │
│  │  ┌───────────────────────────────────────────────────────────────┐ │   │
│  │  │ Date Selector │ Register Selector │ Export │ Import │ Backup  │ │   │
│  │  └───────────────────────────────────────────────────────────────┘ │   │
│  │                                                                     │   │
│  │  ┌───────────────────────────────────────────────────────────────┐ │   │
│  │  │                 EXCEL-LIKE TABLE VIEW                         │ │   │
│  │  │  ┌─────────────────────────────────────────────────────────┐  │ │   │
│  │  │  │ Col1 │ Col2 │ Col3 │ Col4 │ Col5 │ Col6 │ ... │ ColN  │  │ │   │
│  │  │  ├─────────────────────────────────────────────────────────┤  │ │   │
│  │  │  │ ...  │ ...  │ ...  │ ...  │ ...  │ ...  │ ... │ ...  │  │ │   │
│  │  │  └─────────────────────────────────────────────────────────┘  │ │   │
│  │  │  [Sortable] [Filterable] [Paginated]                          │ │   │
│  │  └───────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Register Descriptions

| Register Name | Description | Source | Trigger |
|---|---|---|---|
| R0 | Live Registry | Screener Tab (r0) | Real-time (read-only view) |
| R1 | Frozen Screener (9:36 AM ET) | Screener Tab (r0) | 9:36 AM daily |
| R2 | Market Snapshots | Market Tab | 9:25, 9:30, 9:35, 9:40, 9:45, 9:50, 9:55, 10:00 |
| R3A | EOD Outcome (9:37) | Yahoo Finance | After market close |
| R3B | EOD Outcome (9:40) | Yahoo Finance | After market close |
| R4A | Merged (R1 + R3A) | R1 + R3A | After R3A complete |
| R4B | Merged (R1 + R3B) | R1 + R3B | After R3B complete |
| Shortlist | User Shortlist | Shortlist Tab | Real-time |

### 3. Excel-Like Table Columns

#### R0 — Live Registry

| Column | Field | Type |
|---|---|---|
| Ticker | ticker | string |
| Date | date | string |
| Price | stock.price | number |
| Change % | stock.change | number |
| Gap % | stock.gapPct | number |
| VWAP | stock.vwap | number |
| RVOL | stock.rvol | number |
| ATR | stock.atr | number |
| ADR % | stock.adrPct | number |
| PM Range | stock.pmRange | number |
| PM/ADR | stock.pmAdrRatio | number |
| Sector | stock.sector | string |
| Industry | stock.industry | string |
| Screeners | screenerKeys | array |
| Score | _score | number |
| Regime | context.regime | string |
| Sec Bias | context.secBias | string |
| Sec Score | context.secScore | number |
| Live | liveNow | boolean |
| Last Updated | lastUpdated | timestamp |

#### R1 — Frozen Screener (9:36 AM)

| Column | Field | Type |
|---|---|---|
| Ticker | ticker | string |
| Price | stock.price | number |
| Change % | stock.change | number |
| Gap % | stock.gapPct | number |
| VWAP | stock.vwap | number |
| RVOL | stock.rvol | number |
| ATR | stock.atr | number |
| ADR % | stock.adrPct | number |
| PM Range | stock.pmRange | number |
| PM/ADR | stock.pmAdrRatio | number |
| Sector | stock.sector | string |
| Screeners | screenerKeys | array |
| Score | _score | number |
| Regime | context.regime | string |
| Sec Bias | context.secBias | string |
| Sec Score | context.secScore | number |
| Captured At | capturedAt | timestamp | (Set to `r0.lastUpdated` at 9:36 AM ET)

#### R2 — Market Snapshots

*Display: Each snapshot as a row, or expandable cards.*

| Column | Field | Type |
|---|---|---|
| Time | slot | string (09:25, 09:30, ...) | (Derived from `capturedAt`)
| SPY Close | indices.SPY.close | number |
| SPY Change | indices.SPY.change | number |
| QQQ Close | indices.QQQ.close | number |
| QQQ Change | indices.QQQ.change | number |
| VIX Close | indices.VIX.close | number |
| VIX Change | indices.VIX.change | number |
| Regime | regime.slug | string |
| Regime Label | regime.label | string |
| Short Bias | shortTerm.result | string |
| Mid Stage | midTerm.result | string |
| Long Bias | longTerm.result | string |
| Sector Bullish | (count of BULLISH sectors) | number |
| Sector Bearish | (count of BEARISH sectors) | number |
| Breakouts | breakoutNames | array |
| Captured At | capturedAt | timestamp |

#### R3A — EOD Outcome (9:37 AM Entry)

| Column | Field | Type |
|---|---|---|
| Ticker | ticker | string |
| Entry Price (9:37) | entryPriceA | number |
| HH (9:37→Close) | hhA | number |
| LL (9:37→Close) | llA | number |
| ATR (14-day) | atr14 | number |
| UpR | upR_A | number |
| DownR | downR_A | number |
| Captured At | capturedAt | timestamp |

#### R3B — EOD Outcome (9:40 AM Entry)

| Column | Field | Type |
|---|---|---|
| Ticker | ticker | string |
| Entry Price (9:40) | entryPriceB | number |
| HH (9:40→Close) | hhB | number |
| LL (9:40→Close) | llB | number |
| ATR (14-day) | atr14 | number |
| UpR | upR_B | number |
| DownR | downR_B | number |
| Captured At | capturedAt | timestamp |

#### R4A — Merged (R1 + R3A)

| Column | Source | Type |
|---|---|---|
| Ticker | R1.ticker | string |
| Price (9:36) | R1.stock.price | number |
| Score | R1._score | number |
| Sector | R1.stock.sector | string |
| Regime | R1.context.regime | string |
| Entry Price (9:37) | R3A.entryPriceA | number |
| HH (9:37→Close) | R3A.hhA | number |
| LL (9:37→Close) | R3A.llA | number |
| UpR | R3A.upR_A | number |
| DownR | R3A.downR_A | number |
| ATR (14-day) | R3A.atr14 | number |

#### R4B — Merged (R1 + R3B)

| Column | Source | Type |
|---|---|---|
| Ticker | R1.ticker | string |
| Price (9:36) | R1.stock.price | number |
| Score | R1._score | number |
| Sector | R1.stock.sector | string |
| Regime | R1.context.regime | string |
| Entry Price (9:40) | R3B.entryPriceB | number |
| HH (9:40→Close) | R3B.hhB | number |
| LL (9:40→Close) | R3B.llB | number |
| UpR | R3B.upR_B | number |
| DownR | R3B.downR_B | number |
| ATR (14-day) | R3B.atr14 | number |

#### Shortlist Register

| Column | Field | Type |
|---|---|---|
| Date | date | string |
| Ticker | ticker | string |
| Added At | addedAt | timestamp |
| Method | method | string (manual/auto) |
| Price (at time) | price | number |
| Change % | change | number |
| Sector | sector | string |
| Score | score | number |
| Exported | exported | boolean |

### 4. UI Layout

#### 4.1. Top Controls

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ 📊 Data Warehouse                                                             │
│                                                                                 │
│ ┌─────────────────────────────────────────────────────────────────────────────┐ │
│ │ Date: [2026-06-28 ▼]  │ Register: [R0 ▼]  │  [Export CSV]  [Export JSON] │ │
│ │                        │                    │  [Import]      [Backup All]  │ │
│ └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                 │
│ Status: ✅ Data loaded · 42 rows · Captured at 2026-06-28 09:36:00 ET          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 4.2. Register Selector Dropdown

```
┌──────────────────────┐
│ Select Register      │
├──────────────────────┤
│ ● R0 — Live Registry │
│ ○ R1 — Frozen 9:36   │
│ ○ R2 — Market Snap   │
│ ○ R3A — EOD 9:37     │
│ ○ R3B — EOD 9:40     │
│ ○ R4A — Merged 9:37  │
│ ○ R4B — Merged 9:40  │
│ ○ Shortlist           │
└──────────────────────┘
```

#### 4.3. System-Wide Integration Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                    TRADE DESK                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐ │
│  │   Screener    │    │    Market     │    │   Warehouse   │    │   Shortlist   │ │
│  │     Tab       │    │     Tab       │    │     Tab       │    │     Tab       │ │
│  │               │    │               │    │               │    │               │ │
│  │  • r0 (live)  │    │  • Indices    │    │  • R1 (frozen)│    │  • User picks │ │
│  │  • TV scans   │    │  • Regime     │───▶│  • R2 (snap)  │    │  • Export     │ │
│  │  • Scoring    │───▶│  • Sectors    │    │  • R3A (9:37) │    │               │ │
│  │  • Cards      │    │  • Heatmap    │    │  • R3B (9:40) │    │               │ │
│  │               │    │  • Themes     │    │  • R4A/R4B    │    │               │ │
│  └───────────────┘    └───────────────┘    │  • Import/    │    └───────────────┘ │
│         │                  │               │    Export     │                     │
│         │                  │               └───────────────┘                     │
│         │                  │                     │                               │
│         └──────────────────┼─────────────────────┘                               │
│                            │                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```
