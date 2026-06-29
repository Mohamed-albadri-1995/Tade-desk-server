# Trade Desk — Complete System Flow

This document describes exactly how the tool runs: startup sequence, scan pipeline,
scheduler, data stores, registers, API, and browser. Read top to bottom.

---

## 1. Server Startup

**Entry point:** `src/index.js`

Executed once when PM2 starts the process:

1. `require('./db')` — opens `data/tradedesk.db` (SQLite, WAL mode). Creates all
   tables if they do not exist. Inserts default values for any missing settings keys.

2. Express app starts on port 3000. All routes are registered.

3. Static files in `public/` are served (the browser UI).

4. `startScheduler()` is called — registers all cron jobs (see Section 4).

**At this point:**
- r0 is empty (it is in-memory only, does not survive restarts)
- DB is open with all historical data intact
- All scheduled jobs are armed
- No scan has run yet

---

## 2. The r0 Registry

**File:** `src/r0/registry.js`

r0 is a `Map<ticker, row>` stored in Node.js process memory. It resets to empty
on every server restart.

**What a row contains:**

| Field | Source | Notes |
|---|---|---|
| `id` | registry (uuid) | Set once on first insert, never changes |
| `ticker` | Side A | e.g. `AAPL` |
| `firstSeen` | registry | Epoch ms when first inserted today |
| `lastUpdated` | registry | Epoch ms of most recent write |
| `date` | registry | ET date string `YYYY-MM-DD` |
| `liveNow` | registry | `true` = returned by current scan, `false` = was seen today but not in last scan |
| `inShortlist` | Side F | `true` if in today's shortlist DB entry |
| `stock.*` | Side A + B | All price/volume/technical fields (see Section 3.1) |
| `screenerKeys` | Side A | Which scanners returned this ticker: `['Trend','Pre-Mkt','Big Move']` |
| `context.*` | Side D | Regime, sector bias, hot status (see Section 3.4) |
| `news` | Side C | `{ finnhub: [...], yahoo: [...], edgar: [...], fetchedAt: ISO }` or `null` |
| `catalyst` | Side C | `{ label, sentiment, color }` or `null` |
| `_score` | Side E | Always `null` — scoring engine disconnected pending design review |

**Key behaviors:**
- `upsertRows(rows)`: if ticker exists → merge (preserves `id`, `firstSeen`,
  `news`, `catalyst`, `inShortlist`; updates stock, context, screenerKeys).
  If ticker is new → inserts with defaults.
- `markAllStale()`: sets `liveNow = false` on every row.
- `clearAll()`: empties the entire Map.
- `getTodayRows()`: returns only rows where `date === today ET`.
- `getAll()`: returns every row regardless of date.

---

## 3. The Full Scan Pipeline

**Function:** `runFullScan()` in `src/pipeline.js`

**Triggered by:** Scheduled cron jobs (Section 4) or manual button in UI.

**Concurrency guard:** If a scan is already running, the new call returns immediately
without running. Only one scan runs at a time.

### Step 0 — Day Boundary Guard

Before anything else, check if r0 contains rows from a previous date:

```
today = toETDate(now)
if any row in r0 has date ≠ today:
    clearAll()     ← wipes r0 completely
    log "Day boundary detected"
```

This is the primary cleanup. Even if the midnight cron misses, the first scan
of the new day flushes the old data.

### Step 1 — Side A: TradingView Scanners (FATAL)

**Files:** `src/sideA/tvScanner.js`, `src/sideA/merge.js`

Three POST requests to `scanner.tradingview.com/america/scan` run in parallel
(`Promise.allSettled`):

| Scanner | Filter logic | Sort |
|---|---|---|
| Trend | close > SMA5, VWAP, EMA50>EMA120, RVOL>3, avg vol>1M | change desc |
| Premarket | premarket_volume > 1.5M, RVOL > 3 | premarket_volume desc |
| Big Moves | RVOL > 10, close > $2, avg vol > 2M | RVOL desc |

Each request uses the same 25 columns (close, change, VWAP, ATR, sector, etc.)
and the same base filter (common stock/preferred/dr/fund types, excludes pre-IPO).

Each TV row is mapped via `mapTVRow()`:
- Ticker: read from `rawTV.s` (NOT the `ticker-view` column — TV changed that format)
- `stock.tvSymbol` = full symbol e.g. `NASDAQ:AAPL` (needed for export + Side G)
- `stock.rvol` = intraday RVOL if available and > 0, else 10-day RVOL

After all three scanners run, results are merged:
- One row per ticker
- `screenerKeys` = union of which scanners returned it
- If same field appears in multiple scanners, first non-null value wins

**If Side A fails: scan aborts. Nothing writes to r0.**

**Result:** `merged` — array of `{ ticker, stock, screenerKeys }`

### Step 2 — Side B: Internal Calculations (FATAL)

**File:** `src/sideB/calculations.js`

Adds derived fields to `row.stock` for every row from Side A:

| Field | Formula |
|---|---|
| `prevClose` | `price / (1 + change/100)` |
| `gapPct` | `(open - prevClose) / prevClose * 100` |
| `pmRange` | `pmHigh - pmLow` |
| `adrPct` | `atr / price * 100` |
| `monthRangePos` | `(price - monthLow) / (monthHigh - monthLow) * 100` |
| `pmAdrRatio` | `pmRange / atr` |

**If Side B fails: scan aborts.**

**Result:** `withDerived` — same rows, enriched stock fields

### Step 3 — Side D: Market Context (NON-FATAL)

**Files:** `src/sideD/engine.js`, `src/sideD/marketContext.js`,
`src/sideD/regime.js`, `src/sideD/sectors.js`, `src/sideD/themes.js`

Two sub-steps:

**3a — `buildMarketSnapshot()`:**
Fetches SPY, QQQ, IWM, DIA, VIX + 15 sector ETFs (XLK, XLF, XLI, XLY, XLE,
XLV, XLC, XLU, XLB, XLRE, XLP, SMH, IBB, XRT, XTN) via TradingView symbol mode.

Computes and stores in memory as `latestSnapshot`:
- Short-term bias (bullish/neutral/bearish) from SPY/QQQ/IWM daily moves + VIX
- Mid-term stage from moving average relationships and Bollinger Band position
- Long-term bias from 50/200 SMA cross
- Regime: combines all three into one of 15 slugs (see Regime section below)
- Per-sector bias (BULLISH/NEUTRAL/BEARISH) and HOT status based on ETF score
  relative to thresholds read from the `settings` DB table

**3b — `enrichR0WithContext()`:**
For every row, looks up the stock's sector → maps to market sector key →
gets sectorData from snapshot. Adds to each row:

```
row.context = {
    regime,          // slug e.g. 'STRONG_UP'
    regimeLabel,     // human label e.g. 'Strong Uptrend'
    longTerm,        // 'BULLISH' | 'RECOVERING' | 'WEAKENING' | 'BEARISH'
    midTerm,         // 'UPTREND' | 'PULLBACK' | 'REBOUND' | 'SIDEWAYS' | 'DOWNTREND'
    shortTerm,       // 'BULLISH' | 'NEUTRAL' | 'BEARISH'
    secBias,         // 'BULLISH' | 'NEUTRAL' | 'BEARISH'
    secScore,        // numeric score
    secHot,          // true | false
    themes,          // array from industry keywords
    broadResolved,   // which market sector key was matched
}
```

**Regime slugs (15 total):**

| Slug | Label | Bias |
|---|---|---|
| `EXTENDED_UP` | Extended Up | LONG |
| `STRONG_UP` | Strong Uptrend | LONG |
| `UP` | Uptrend | LONG |
| `WEAK_UP` | Weak Uptrend | LONG |
| `PULLBACK_BULL` | Pullback (bull intact) | LONG |
| `RECOVERY` | Recovery | NEUTRAL |
| `BASING` | Basing | NEUTRAL |
| `CHOP_BULL` | Chop (bull bias) | NEUTRAL |
| `CHOP_BEAR` | Chop (bear bias) | NEUTRAL |
| `CORRECTION` | Correction (bull intact) | NEUTRAL |
| `TOPPING` | Topping | SHORT |
| `BEAR_RALLY` | Bear Rally | NEUTRAL |
| `DOWN` | Downtrend | SHORT |
| `STRONG_DOWN` | Strong Downtrend | SHORT |
| `CAPITULATION` | Capitulation | SHORT |

**If Side D fails:** `withContext` stays as `withDerived`. Rows have no `context`
key. New rows in r0 get `context: {}`. Existing rows keep their previous context.
Scan continues.

**Result:** `withContext`

### Step 4 — Side E: Scoring (ALWAYS SKIPPED)

The scoring engine is intentionally disconnected pending design review.

```
withScores = withContext.map(row => ({ ...row, _score: null }))
```

Every row gets `_score: null`. The analysis engine (`src/sideE/`) exists for
the Analysis tab but is not called from the scan pipeline.

### Step 5 — Write to r0

```
r0.markAllStale()         ← every existing row: liveNow = false
r0.upsertRows(withScores) ← current scan rows: liveNow = true
```

After this step:
- Tickers in the current scan: `liveNow: true`, fresh stock + context data,
  `news`/`catalyst` preserved from last time they were live
- Tickers seen earlier today but not in this scan: `liveNow: false`,
  stock data is from their last scan, `news`/`catalyst` preserved

### Step 6 — Side G: Stale Ticker Refresh (NON-FATAL)

**File:** `src/sideG/staleFetch.js`

Collects all r0 rows where `liveNow = false` AND `date = today`.
Extracts their `stock.tvSymbol` values.
Calls TradingView in symbol mode (same API, `symbols.tickers` instead of filter)
to get fresh quotes for all of them.
Runs fresh data through `mapTVRow` + `computeDerivedFields`.
Updates only `row.stock` on each stale row. Does NOT change:
`liveNow`, `context`, `date`, `id`, `firstSeen`, `inShortlist`, `_score`, `screenerKeys`, `news`, `catalyst`.

Reports: `{ staleCount, refreshed, noSymbol }` to pipeline monitor.

**If Side G fails:** stale rows keep their data from the last time they were live.
Scan continues.

### Step 7 — Side C: News & Catalyst (NON-FATAL)

**File:** `src/sideC/news.js`

Collects all r0 rows where `liveNow = true`.
For each ticker, fetches in parallel (Promise.allSettled, 3 sources each):
- Finnhub: `finnhub.io/api/v1/company-news` (last 7 days, key from DB settings)
- Yahoo Finance: `query1.finance.yahoo.com/v1/finance/search`
- SEC EDGAR: `efts.sec.gov/LATEST/search-index` (8-K and S-3 filings)

Combines all headlines, runs through `classifyCatalyst()` pattern matching
(13 patterns: FDA approval, earnings beat, M&A, dilution, upgrade, downgrade,
short squeeze, insider buy/sell, partnership, legal risk).

Writes to r0 via `r0.updateNews(ticker, news, catalyst)`.

Reports: `{ rowCount, failed }` to pipeline monitor.

**If Side C fails entirely or per-ticker:** that ticker's `news` and `catalyst`
stay at their previous values. Scan continues.

### Step 8 — Side F: Shortlist Sync (NON-FATAL)

**File:** `src/sideF/shortlist.js`

Reads today's shortlist entry from the DB (`shortlist` table).
For every ticker in that entry, calls `r0.setInShortlist(ticker, true)`.

This restores `inShortlist` flags into r0 after every scan. Without this,
upsertRows would reset `inShortlist` to the existing value (which is `false`
for a new row, or preserved for an existing one). The explicit sync ensures
tickers manually added to the shortlist between scans do not lose their flag.

**If Side F fails:** `inShortlist` flags may be wrong until the next scan.
Scan continues.

### Step 9 — Pipeline Report

Assembled after all stages complete:

```json
{
    "scanId": "uuid",
    "startedAt": 1234567890,
    "completedAt": 1234567890,
    "ok": true,
    "stages": {
        "sideA": { "ok": true, "rowCount": 28, "duration": 1240 },
        "sideB": { "ok": true, "rowCount": 28, "duration": 2 },
        "sideD": { "ok": true, "rowCount": 28, "duration": 890 },
        "sideE": { "ok": true, "note": "disconnected — _score null" },
        "sideG": { "ok": true, "staleCount": 5, "refreshed": 5, "noSymbol": 0, "duration": 420 },
        "sideC": { "ok": true, "rowCount": 28, "failed": 0, "duration": 3100 },
        "sideF": { "ok": true, "duration": 1 }
    },
    "r0Summary": {
        "total": 33,
        "liveNow": 28,
        "stale": 5,
        "inShortlist": 2
    }
}
```

Stored in memory. Available at `GET /api/monitor` → `pipeline.lastReport`.

---

## 4. Scheduler

**File:** `src/scheduler.js`

All times are Eastern Time (America/New_York). All weekdays only (Mon–Fri)
unless noted. Every job records its last run time, status, duration, and any
error — visible in the Monitor tab.

| Job | Cron | When |
|---|---|---|
| Full Scan (30 min) | `*/30 7-8 * * 1-5` | 7:00, 7:30, 8:00, 8:30 AM ET |
| Full Scan (5 min) | `*/5 9 * * 1-5` | Every 5 min 9:00–9:55 AM ET |
| Full Scan (3 hr) | `0 10,13,16,19,22 * * 1-5` | 10 AM, 1 PM, 4 PM, 7 PM, 10 PM ET |
| Shortlist Auto-Rule | `35 9 * * 1-5` | 9:35 AM ET |
| R1 Capture | `36 9 * * 1-5` | 9:36 AM ET |
| R2 Snapshot | `25,30,35,40,45,50,55 9 * * 1-5` | Every 5 min 9:25–9:55 AM ET |
| R2 Snapshot | `0 10 * * 1-5` | 10:00 AM ET |
| R3 EOD Capture | `5 16 * * 1-5` | 4:05 PM ET |
| Daily Backup | `30 17 * * 1-5` | 5:30 PM ET |
| Midnight r0 Flush | `0 0 * * *` | 12:00 AM ET (every day) |

---

## 5. r0 Lifecycle Through a Trading Day

```
12:00 AM ET    — Midnight cron: clearAll() — r0 is empty

7:00 AM ET     — First scan of day
                 Day-boundary guard: r0 is empty, nothing to flush
                 Sides A→B→D run
                 markAllStale() (nothing to mark)
                 upsertRows() — e.g. 15 tickers, all liveNow: true
                 Side G: 0 stale rows, nothing to do
                 Side C: news fetched for 15 live tickers
                 Side F: syncs shortlist flags (probably none yet)

7:30 AM ET     — Second scan
                 Day-boundary guard: all rows are today's, no flush
                 Sides A→B→D run (e.g. 18 tickers returned)
                 markAllStale() — all 15 existing rows: liveNow = false
                 upsertRows() — 18 tickers written: liveNow = true
                   (13 existing rows updated, 5 new rows inserted)
                   (2 tickers from 7:00 AM scan not in this scan:
                    they stay in r0 with liveNow = false)
                 Side G: 2 stale tickers refreshed with fresh TV quotes
                 Side C: news fetched for 18 live tickers
                 Side F: syncs shortlist

9:05 AM ET     — High-frequency scan (every 5 min)
                 Same pattern: stale, upsert, G, C, F

9:35 AM ET     — Shortlist Auto-Rule runs (separate job, not part of scan)
                 Reads r0.getTodayRows()
                 Filters to _score >= minScore (currently no rows pass — _score is null)
                 If no eligible rows: logs and exits, nothing saved

9:36 AM ET     — R1 Capture
                 Reads r0.getTodayRows() (all today's rows, live AND stale)
                 Writes one row per ticker to r1_frozen table with (date, ticker, full_row_json)
                 PRIMARY KEY (date, ticker) — so re-running overwrites

9:25–10:00 AM  — R2 Snapshots (every 5 min, separate job)
                 Reads latestSnapshot from memory (set by last Side D run)
                 Writes to r2_market_snapshots with (date, slot, data_json)

4:05 PM ET     — R3 EOD Capture (Side H)
                 Checks R1 has rows for today — if not, skips with logged reason
                 Reads tickers from r1_frozen WHERE date = today
                 Fetches full-day 1-min bars from Alpaca (9:30–16:00 ET)
                 Fetches 14 daily bars before today from Alpaca for ATR14
                 Writes r3a: entry=open of 9:37 bar, hh/ll from 9:37→close
                 Writes r3b: entry=open of 9:40 bar, hh/ll from 9:40→close
                 Computes up_r/down_r = (hh−entry)/atr14, (entry−ll)/atr14

5:30 PM ET     — Daily Backup
                 Exports DB tables to JSON: settings, shortlist, r1_frozen,
                 r2_market_snapshots, r3a, r3b
                 Pushes to GitHub repo trade-desk-data/fresh branch:
                   backups/YYYY-MM-DD.json
                   backups/latest.json
                 Records lastBackupAt in settings table

12:00 AM ET    — Midnight flush: clearAll() — r0 empty again
```

---

## 6. Data Registers

### r0 — In-Memory Live Registry

Only exists in RAM. Resets on restart. Holds all stocks seen today (live + stale).
Not persisted anywhere. See Section 2 for full field list.

Read by: `/api/registry/today` (returns today's rows, live first)

### R1 — Opening Snapshot (DB)

**Table:** `r1_frozen` | **Primary key:** `(date, ticker)`

A frozen snapshot of r0 at 9:36 AM. Stores the full row as JSON.
One row per ticker per day. Used for analysis: "what did this stock look like
at the open?"

Captured once per day at 9:36 AM. If server is down at 9:36, no R1 for that day.
`INSERT OR REPLACE` — running R1 capture twice on the same day overwrites.

### R2 — Market Context Snapshots (DB)

**Table:** `r2_market_snapshots` | **Primary key:** auto-increment id

Multiple snapshots per day. Captures the full `latestSnapshot` object
(indices, regime, sectors) every 5 minutes from 9:25–10:00 AM ET.
Rows accumulate — no deletion. Used for analysis: "what was the market doing
during the open?"

### R3A / R3B — Trade Levels (DB)

**Tables:** `r3a`, `r3b` | **Primary key:** `(date, ticker)`
**Data source:** Alpaca Market Data API v2 (1-min and daily bars)
**Ticker universe:** All tickers from today's R1 snapshot
**Trigger:** Scheduler job at 4:05 PM ET (after market close)

**Entry prices:**
- `entry_price_a` = open of the 9:37 ET 1-min bar (Target Entry)
- `entry_price_b` = open of the 9:40 ET 1-min bar (Alternative Entry)

**HH / LL:**
- `hh_a / ll_a` = highest high / lowest low of all bars from 9:37 → 16:00 ET
- `hh_b / ll_b` = highest high / lowest low of all bars from 9:40 → 16:00 ET

**ATR14:** computed from the 14 most recent completed trading days before today.

**R values:**
- `up_r_a = (hh_a − entry_price_a) / atr14`
- `down_r_a = (entry_price_a − ll_a) / atr14`
- Same formula for B

**Files:** `src/alpaca/client.js`, `src/sideH/capture.js`

### R4A / R4B — Combined Analysis (computed)

Not stored. Computed on-demand by joining `r1_frozen` + `r3a`/`r3b` for a given date.
Only has data for dates where both R1 and R3 exist. Used as training data for Side E.

### Shortlist (DB)

**Table:** `shortlist` | **Primary key:** `date`

One entry per day, stores all tickers added that day as a JSON array.
Each item: `{ ticker, tvSymbol, addedAt, method, price, change, sector, score }`.

`method` is `'auto'` (from 9:35 AM rule) or `'manual'` (from star button or shortlist tab).

---

## 7. Side E — Analysis Engine

**Files:** `src/sideE/train.js`, `src/sideE/insights.js`, `src/routes/analysis.js`

The analysis engine trains on historical R4A data and produces feature importance
rankings and AI-generated insights. It is **completely disconnected from the scan
pipeline** — it runs only when triggered from the Analysis tab.

### Training Data (R4A)

Joins `r1_frozen` + `r3a` for a configurable number of past trading days.
Win condition: `up_r_a >= successThreshold` (default 1.5R).

### Features (38 total)

**Critical numerical (custom bucket boundaries):**
- `rvol` — [0, 2, 5, 10, 20, ∞]
- `change`, `gapPct` — [−∞, −10, −5, −2, 0, 2, 5, 10, ∞]
- `monthRangePos` — [0, 20, 40, 60, 80, 100]
- `secScore` — [−100, −40, −20, 0, 20, 40, 100]
- `pmAdrRatio` — [0, 0.5, 1, 2, 3, ∞]
- `adrPct` — [0, 5, 10, 15, 20, 30, ∞]

**Quantile numerical (6 equal-width buckets):**
price936, vwap, sma5, ema9, ema13, ema20, ema50, atr, mcap, floatShares,
pmRange, prevClose, monthHigh, monthLow, up_r_a, down_r_a, screenerCount,
pmVolume, volume, shortlistScore

**Categorical:**
regime, secBias, sector, longTerm, midTerm, shortTerm, catalyst, screenerKeys,
secHot, themes, dayOfWeek

### Feature Importance Formula

```
importance(f) = Σ_b [ (count_b / totalRows) × (winRate_b − globalWinRate)² ]
```

Normalized so all importances sum to 100%.

### AI Insights

After training, the engine optionally calls an AI provider to generate a
3–5 bullet point summary of the top 5 statistical insights.

**Provider detection (from stored key prefix):**
- `sk-ant-` → Anthropic API (`api.anthropic.com/v1/messages`)
- `AIza` → Google Gemini (`generativelanguage.googleapis.com/v1beta/models/...`)
- anything else → OpenRouter (`openrouter.ai/api/v1/chat/completions`)

### Analysis API

| Endpoint | Description |
|---|---|
| `POST /api/analysis/train` | Train model on R4A data, generate insights |
| `GET /api/analysis/report` | Full report: features, globalWinRate, totalRows, insights |
| `GET /api/analysis/insights?ai=true` | Get/regenerate insights (add `&regenerate=true` to force) |
| `GET /api/analysis/feature/:name` | Bucket breakdown with win rate and lift for one feature |

---

## 8. Settings

**Table:** `settings` — key/value pairs read per-request (no caching).

| Key | Default | Used by |
|---|---|---|
| `hotImmediateThreshold` | 60 | Side D sectors — enter HOT immediately |
| `hotSustainedThreshold` | 40 | Side D sectors — sustain toward HOT |
| `hotSustainedSessions` | 3 | Side D sectors — sessions needed |
| `hotFloorThreshold` | 20 | Side D sectors — floor to stay HOT |
| `coolOffDays` | 2 | Side D sectors — sessions below floor before losing HOT |
| `sectorBullishThreshold` | 20 | Side D sectors — score above = BULLISH |
| `sectorBearishThreshold` | -20 | Side D sectors — score below = BEARISH |
| `shortlistMinScore` | 70 | Side F auto-rule — minimum score |
| `shortlistTopN` | 5 | Side F auto-rule — max picks |
| `finnhubApiKey` | '' | Side C news |
| `githubBackupToken` | '' | Backup |
| `alpacaApiKey` | '' | Side H R3 capture |
| `alpacaApiSecret` | '' | Side H R3 capture |
| `analysisEntryType` | `A` | Side E — entry type (A or B) |
| `analysisDirectionalBias` | `Up` | Side E — directional filter |
| `analysisSuccessThreshold` | `1.5` | Side E — win R-multiple |
| `analysisTrainingWindow` | `90` | Side E — training days |
| `aiApiKey` | '' | Side E — AI insights key |
| `aiModel` | `anthropic/claude-haiku-4-5` | Side E — AI model ID |

`finnhubApiKey`, `githubBackupToken`, `alpacaApiKey`, `alpacaApiSecret`, and `aiApiKey`
are masked in `GET /api/settings` (returns `'set'` or `''`).

`hotState` (which sectors are currently HOT) lives in memory in `src/sideD/sectors.js`.
It resets on server restart or via `POST /api/settings/reset-hot`.

---

## 9. API Endpoints

| Endpoint | Method | What it does |
|---|---|---|
| `/api/registry/today` | GET | Today's r0 rows. Live rows first, then stale. |
| `/api/registry/all` | GET | All r0 rows regardless of date. |
| `/api/scan/run` | POST | Triggers `runFullScan()`. Waits for completion. |
| `/api/scan/status` | GET | `{ lastRun, lastRowCount, running, error, lastReport }` |
| `/api/market/snapshot` | GET | Latest market snapshot from Side D. |
| `/api/news/:ticker` | GET | Fetch news on-demand for one ticker. Updates r0. |
| `/api/shortlist/today` | GET | Today's shortlist entry from DB. |
| `/api/shortlist/all` | GET | All shortlist entries, newest first. |
| `/api/shortlist/toggle/:ticker` | POST | Add or remove ticker. Body: `{ date? }` |
| `/api/shortlist/export/:date` | GET | Download `.txt` file for TradingView import. |
| `/api/shortlist/run-rule` | POST | Manually trigger shortlist auto-rule. |
| `/api/warehouse/registers` | GET | List of available registers and their dates. |
| `/api/warehouse/data/:register` | GET | Data for a register. Query: `?date=YYYY-MM-DD` |
| `/api/analysis/report` | GET | Full analysis report (features, insights, stats). |
| `/api/analysis/train` | POST | Train model on R4A data. Body: `{ overrides? }` |
| `/api/analysis/insights` | GET | Get insights. Query: `?regenerate=true&ai=true` |
| `/api/analysis/feature/:name` | GET | Bucket breakdown for one feature with lift. |
| `/api/settings` | GET | All settings (sensitive keys masked). |
| `/api/settings` | POST | Validate and save settings. Body: `{ key: value, ... }` |
| `/api/settings/test/:service` | GET | Live API connectivity test (`finnhub`/`github`/`alpaca`/`ai`). |
| `/api/settings/reset-hot` | POST | Clear hotState in memory. |
| `/api/backup/status` | GET | Last backup time, token configured, repo name. |
| `/api/backup/push` | POST | Run backup now → push to GitHub. |
| `/api/backup/restore` | POST | Restore from GitHub. Body: `{ date? }` (omit for latest). |
| `/api/monitor` | GET | Pipeline lastReport + all scheduler job statuses. |
| `/health` | GET | `{ ok: true, ts }` — process health check. |

---

## 10. The Browser (Frontend)

**File:** `public/index.html` — single HTML file, all JS inline.

The browser does NO business logic. It only:
- Fetches from the API
- Renders what it receives
- Handles user interaction (clicks, inputs)
- Passes actions back to the server

### Tabs and their data sources

| Tab | Primary API call | When it loads |
|---|---|---|
| Screener | `GET /api/registry/today` | On tab open and after scan |
| Market | `GET /api/market/snapshot` | On tab open and after scan |
| Shortlist | `GET /api/shortlist/today` + `GET /api/shortlist/all` | On tab open |
| Warehouse | `GET /api/warehouse/registers` + `GET /api/warehouse/data/:register` | On tab open + date change |
| Analysis | `GET /api/analysis/report` | On tab open |
| Settings | `GET /api/settings` + `GET /api/backup/status` | On tab open |
| Monitor | `GET /api/monitor` | On tab open + Refresh button |

### Scanner card data flow

1. Browser calls `GET /api/registry/today`
2. Server returns array of r0 rows (sorted: live first)
3. Browser stores in `r0Data` array
4. `buildCard(row)` renders HTML for each row:
   - `row.stock.price`, `row.stock.change`, etc. — from Side A + B
   - `row.context.regime`, `row.context.secBias`, etc. — from Side D
   - `row.catalyst` — from Side C
   - `row.inShortlist` — star shown filled/empty
   - `row.liveNow` — green `●Live` dot or grey `●Stale` dot with amber border

### Analysis tab

Calls `GET /api/analysis/report` on open. Shows:
- Model stats (total rows, global win rate, trained date)
- Active config (entry type, bias, threshold, training window)
- AI-generated insights (with Regenerate + AI Insights buttons)
- Factor importance ranked list (top 20 with bar chart)
- Bucket analysis dropdown (select a feature → table with win rate and lift per bucket)

### Settings — AI Provider

A dropdown selects the provider. The UI updates the key placeholder, hint, and model preset list:
- **OpenRouter** — `sk-or-v1-` key prefix, `provider/model` format
- **Claude (Anthropic)** — `sk-ant-` key prefix, `claude-*` model format
- **Gemini (Google)** — `AIza` key prefix, `gemini-*` model format

The server auto-detects provider from the key prefix — no separate provider field is stored in DB.

---

## 11. Backup System

**Files:** `src/backup/index.js`, `src/routes/backup.js`

### Push (daily at 5:30 PM ET or manual)

1. Reads GitHub token from `settings` table
2. Exports DB to JSON — tables: `settings`, `shortlist`, `r1_frozen`,
   `r2_market_snapshots`, `r3a`, `r3b`
3. Base64-encodes and pushes two files to GitHub via REST API:
   - `backups/YYYY-MM-DD.json` (dated snapshot)
   - `backups/latest.json` (always overwritten with latest)
4. Target: repo `Mohamed-albadri-1995/trade-desk-data`, branch `fresh`
5. Records `lastBackupAt` in the `settings` table

### Restore (manual from Settings tab)

1. Fetches `backups/latest.json` (or `backups/YYYY-MM-DD.json` if date specified)
2. Decodes base64
3. Clears and repopulates all exported tables in a DB transaction
4. r0 is not affected — it is in-memory and rebuilds on next scan

---

## 12. Current Status

| Item | Status |
|---|---|
| Side A — TradingView Scanner | ✅ Complete |
| Side B — Derived Calculations | ✅ Complete |
| Side C — News & Catalyst | ✅ Complete |
| Side D — Market Context & Regime | ✅ Complete (15 regime labels) |
| Side E — Analysis Engine (report only) | ✅ Complete — disconnected from pipeline |
| Side E — Scoring (pipeline integration) | ⏸ Disconnected — `_score` always null |
| Side F — Shortlist | ✅ Complete |
| Side G — Stale Ticker Refresh | ✅ Complete |
| Side H — R3 EOD Capture (Alpaca) | ✅ Complete |
| Settings System | ✅ Complete — includes AI provider dropdown + live test buttons |
| Backup / Restore | ✅ Complete |
| Monitor Tab | ✅ Complete |
| AI Insights (Anthropic / OpenRouter / Gemini) | ✅ Complete |
| Shortlist Auto-Rule | ⏸ Wired but produces nothing — scoring disconnected |
