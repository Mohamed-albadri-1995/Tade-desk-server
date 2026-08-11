# Trade Desk — Complete System Flow

This document describes exactly how the tool runs: startup sequence, scan pipeline,
scheduler, data stores, registers, API, and browser. Read top to bottom.

---

## 1. Server Startup

**Two processes start via PM2:**

### Process 1 — Node.js (`trade-desk`, port 3000)

Entry point: `src/index.js`

1. `require('./db')` — opens `data/tradedesk.db` (SQLite, WAL mode). Creates all
   tables if they do not exist. Inserts default values for any missing settings keys.

2. Express app starts on port 3000. All routes are registered.

3. Static files in `public/` are served (the browser UI).

4. `startScheduler()` is called — registers all cron jobs (see Section 4).

5. **r0 checkpoint restore** — reads `r0_checkpoint` table. If a checkpoint exists
   for today's ET date, restores r0 from it. This means a mid-day server restart
   recovers all ticker data from the last completed scan.

**At this point:**
- r0 is either empty (no checkpoint) or restored from today's last scan
- DB is open with all historical data intact
- All scheduled jobs are armed

### Process 2 — Python Flask (`scorer`, port 3001)

Entry point: `src/scoring/server.py`

Loads `LiveScorer` from `src/scoring/scorer.py`. On startup, checks if trained model
outputs exist in `src/scoring/outputs/`. If `B6/main/metadata.pkl` exists, model is
ready. Otherwise reports `ready: false` — scoring returns null until trained.

Node.js calls this service via HTTP on every scan (sideE). If the service is down
or not ready, scoring is skipped and `_score` stays null.

---

## 2. The r0 Registry

**File:** `src/r0/registry.js`

r0 is a `Map<ticker, row>` stored in Node.js process memory. It is checkpointed to
SQLite after every successful scan and restored on startup if the checkpoint date
matches today.

**What a row contains:**

| Field | Source | Notes |
|---|---|---|
| `id` | registry (uuid) | Set once on first insert, never changes |
| `ticker` | Side A | e.g. `AAPL` |
| `firstSeen` | registry | Epoch ms when first inserted today |
| `lastUpdated` | registry | Epoch ms of most recent write |
| `date` | registry | ET date string `YYYY-MM-DD` |
| `liveNow` | registry | `true` = in current scan, `false` = seen today but not in last scan |
| `inShortlist` | Side F | `true` if in today's shortlist DB entry |
| `bias` | user / auto | `'auto'` \| `'long'` \| `'short'` — user-set bias for scoring |
| `stock.*` | Side A + B | All price/volume/technical fields (see Section 3.1) |
| `screenerKeys` | Side A | Which scanners returned this ticker: `['Trend','Pre-Mkt','Big Move']` |
| `context.*` | Side D | Regime, sector bias, themes (see Section 3.4) |
| `news` | Side C | `{ finnhub: [...], yahoo: [...], edgar: [...], fetchedAt: ISO }` or `null` |
| `catalyst` | Side C | `{ label, sentiment, color }` or `null` |
| `_score` | Side E | Integer 0–100 from scoring service, or `null` if service unavailable |
| `_scoreDetails` | Side E | `{ table, base, tableType, cardRegime, confidence, samples, factorScores, bucketScores, bias, entryTime, ... }` |

**Key behaviors:**
- `upsertRows(rows)`: if ticker exists → merge (preserves `id`, `firstSeen`,
  `news`, `catalyst`, `inShortlist`, `bias`; updates stock, context, screenerKeys,
  `_score`, `_scoreDetails`). If ticker is new → inserts with defaults.
- `updateBias(ticker, bias)`: sets bias without touching any other field.
- `markAllStale()`: sets `liveNow = false` on every row.
- `clearAll()`: empties the entire Map.
- `getTodayRows()`: returns only rows where `date === today ET`.
- `getAll()`: returns every row regardless of date.
- `serialize()` / `restore()`: used for SQLite checkpoint.

---

## 3. The Full Scan Pipeline

**Function:** `runFullScan()` in `src/pipeline.js`

**Triggered by:** Scheduled cron jobs (Section 4) or manual Run Scan button in UI.

**Concurrency guard:** If a scan is already running, the new call returns immediately.
Only one scan runs at a time.

### Step 0 — Day Boundary Guard

```
today = toETDate(now)
if any row in r0 has date ≠ today:
    clearAll()     ← wipes r0 completely
    log "Day boundary detected"
```

Primary cleanup. Even if the midnight cron misses, the first scan of the new day
flushes old data.

### Step 1 — Side A: TradingView Scanners (FATAL)

**Files:** `src/sideA/tvScanner.js`, `src/sideA/merge.js`

Three POST requests to `scanner.tradingview.com/america/scan` run in parallel
(`Promise.allSettled`):

| Scanner | Filter logic | Sort |
|---|---|---|
| Trend | close > SMA5, VWAP, EMA50>EMA120, RVOL>3, avg vol>1M | change desc |
| Premarket | premarket_volume > 1.5M, RVOL > 3 | premarket_volume desc |
| Big Moves | RVOL > 10, close > $2, avg vol > 2M | RVOL desc |

Each request returns up to 50 rows using 25 common columns. Each TV row is mapped
via `mapTVRow()`:
- Ticker: read from `rawTV.s` (NOT the `ticker-view` column — TV changed that format)
- `stock.tvSymbol` = full symbol e.g. `NASDAQ:AAPL` (needed for Side G)
- `stock.rvol` = intraday RVOL if available and > 0, else 10-day RVOL

After all three scanners run, results are merged:
- One row per ticker
- `screenerKeys` = union of which scanners returned it
- If same field appears in multiple scanners, first non-null value wins

**If ALL scanners fail: scan aborts. Nothing writes to r0.**
**If Side A (merge step) throws: scan aborts.**

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

Division-safe: `monthRangePos` returns 0 when range is zero; `pmAdrRatio` returns 0 when atr is zero.

**If Side B fails: scan aborts.**

**Result:** `withDerived` — same rows, enriched stock fields

### Step 3 — Side D: Market Context (NON-FATAL)

**Files:** `src/sideD/engine.js`, `src/sideD/marketContext.js`,
`src/sideD/regime.js`, `src/sideD/sectors.js`, `src/sideD/themes.js`

**3a — `buildMarketSnapshot()`:**
Fetches SPY, QQQ, IWM, DIA, VIX + 15 sector ETFs (XLK, XLF, XLI, XLY, XLE,
XLV, XLC, XLU, XLB, XLRE, XLP, SMH, IBB, XRT, XTN) via TradingView symbol mode.

Computes and stores in memory as `latestSnapshot`:
- Short-term bias from SPY/QQQ/IWM daily moves + VIX
- Mid-term stage from moving average relationships and Bollinger Band position
- Long-term bias from 50/200 SMA cross
- Regime: combines all three into one of 15 slugs (see below)
- Per-sector bias (BULLISH/NEUTRAL/BEARISH) and HOT status

**3b — `enrichR0WithContext()`:**
For every row, looks up the stock's sector → maps to market sector key →
gets sectorData from snapshot. Adds to each row:

```
row.context = {
    regime,          // slug e.g. 'UP'
    regimeLabel,     // human label e.g. 'Uptrend'
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

**If Side D fails:** rows have no `context`. Existing rows keep their previous context. Scan continues.

**Result:** `withContext`

### Step 4 — Side E: Live Scoring (NON-FATAL)

**File:** `src/sideE/score.js` → calls `http://127.0.0.1:3001/score`

For each row, builds a flat card dict and calls the Flask scoring service:

**Bias resolution (`resolveCardBias`):**
```
if bias = 'long'  → 'Long'
if bias = 'short' → 'Short'
if bias = 'auto':
    if shortTerm=BEARISH and secBias≠BULLISH → 'Short'
    if secBias=BEARISH and shortTerm≠BULLISH  → 'Short'
    if shortTerm=BULLISH or secBias=BULLISH   → 'Long'
    if longTerm=BEARISH                        → 'Short'
    default                                    → 'Long'
```

**Base selection (in Flask scorer.py):**

| Bias | Entry Time | Base |
|---|---|---|
| Long | 9:40 | B4 |
| Short | 9:40 | B5 |
| Long/Short/Undefined | 9:37 | B1/B2/B3 |

**Critical:** existing bias (`row.bias`) is preserved from r0 before scoring. This prevents a fresh scan from resetting user-set bias to 'auto'.

**Scorer health check** is cached 30s. If scorer is unavailable (not started, not trained, or timed out), all rows receive `_score: null, _scoreDetails: null`. Scan continues.

All rows scored in parallel (`Promise.all`). Individual row timeout: 5s.

**Result:** `withScores`

### Step 5 — Write to r0

```
r0.markAllStale()         ← every existing row: liveNow = false
r0.upsertRows(withScores) ← current scan rows: liveNow = true
```

After this step, r0 is checkpointed to SQLite:
```sql
INSERT OR REPLACE INTO r0_checkpoint (id, date, data, saved_at) VALUES (1, today, json, now)
```

### Step 6 — Side G: Stale Ticker Refresh (NON-FATAL)

**File:** `src/sideG/staleFetch.js`

Collects all r0 rows where `liveNow = false` AND `date = today`.
Extracts their `stock.tvSymbol` values.
Fetches fresh quotes from TradingView in symbol mode.
Re-runs `computeDerivedFields`. Updates only `row.stock`. Does NOT change:
`liveNow`, `context`, `date`, `id`, `firstSeen`, `inShortlist`, `_score`,
`_scoreDetails`, `bias`, `screenerKeys`, `news`, `catalyst`.

**If Side G fails:** stale rows keep data from when they were last live.

### Step 7 — Side C: News & Catalyst (NON-FATAL)

**File:** `src/sideC/news.js`

All `liveNow = true` rows, fetched in parallel (3 sources per ticker):
- Finnhub: last 7 days of company news (key from DB settings)
- Yahoo Finance: search endpoint
- SEC EDGAR: 8-K and S-3 filings

Headlines run through `classifyCatalyst()` — 13 patterns:
FDA approval/rejection, earnings beat/miss, M&A, dilution, upgrade, downgrade,
short squeeze, insider buy/sell, partnership, legal risk.

Writes to r0 via `r0.updateNews(ticker, news, catalyst)`.

**If news fails per-ticker:** that ticker's `news` and `catalyst` stay at previous values.

### Step 8 — Side F: Shortlist Sync (NON-FATAL)

**File:** `src/sideF/shortlist.js`

Reads today's shortlist entry from DB. For every ticker in that entry, calls
`r0.setInShortlist(ticker, true)`. This restores `inShortlist` flags after
every scan so manually-starred tickers do not lose their flag.

### Step 9 — Pipeline Report

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
        "sideE": { "ok": true, "rowCount": 28, "scored": 25, "duration": 1100 },
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

---

## 4. Scheduler

**File:** `src/scheduler.js`

All times are Eastern Time (America/New_York). All weekdays only (Mon–Fri)
unless noted. Every job records last run time, status, duration, and error.
Jobs can be toggled on/off and rescheduled via the Monitor tab.

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
| Scorer Auto-Train | `20 16 * * 1-5` | 4:20 PM ET |
| Daily Backup | `30 17 * * 1-5` | 5:30 PM ET |
| Midnight r0 Flush | `0 0 * * *` | 12:00 AM ET (every day) |

---

## 5. r0 Lifecycle Through a Trading Day

```
12:00 AM ET    — Midnight cron: clearAll() — r0 is empty

7:00 AM ET     — First scan
                 Day-boundary guard: r0 empty (or checkpoint date mismatch)
                 Sides A→B→D→E→upsert→G→C→F
                 r0 checkpoint saved to SQLite

9:05 AM ET     — High-frequency scan (every 5 min)
                 Bias preservation: existing r0 bias copied onto fresh scan rows
                 before sideE so user-set bias survives scan overwrite

9:35 AM ET     — Shortlist Auto-Rule
                 Reads r0.getTodayRows()
                 Filters to _score >= shortlistMinScore (default 70)
                 Saves top-N to shortlist DB if no entry exists for today

9:36 AM ET     — R1 Capture
                 Reads r0.getTodayRows() (all today's rows, live AND stale)
                 Writes one row per ticker to r1_frozen

9:25–10:00 AM  — R2 Snapshots (every 5 min)
                 Writes latestSnapshot from Side D to r2_market_snapshots

4:05 PM ET     — R3 EOD Capture (Side H)
                 Fetches Alpaca 1-min bars for all R1 tickers
                 Writes entry prices, HH/LL, R-values to r3a and r3b

4:20 PM ET     — Scorer Auto-Train
                 Checks tmp/r4a.csv and tmp/r4b.csv exist
                 Calls POST /api/analysis/train → Flask /train
                 Flushes scorer cache so next /score uses new model

5:30 PM ET     — Daily Backup
                 Exports DB to JSON, pushes to GitHub

12:00 AM ET    — Midnight flush: clearAll() — r0 empty again
```

---

## 6. Data Registers

### r0 — In-Memory Live Registry

Only exists in RAM during the session. Checkpointed to `r0_checkpoint` SQLite table
after every successful scan. Restored on startup if today's date matches.

Read by: `/api/registry/today` (today's rows, live first)

### R1 — Opening Snapshot (DB)

**Table:** `r1_frozen` | **Primary key:** `(date, ticker)`

Frozen snapshot of r0 at 9:36 AM. Stores full row as JSON. Used as the feature
source for training R4A/R4B.

### R2 — Market Context Snapshots (DB)

**Table:** `r2_market_snapshots` | **Primary key:** auto-increment id

Multiple snapshots per day. Full `latestSnapshot` object every 5 minutes 9:25–10:00 AM.

### R3A / R3B — Trade Levels (DB)

**Tables:** `r3a`, `r3b` | **Primary key:** `(date, ticker)`

| Field | Description |
|---|---|
| `entry_price_a` | Open of the 9:37 ET 1-min bar |
| `entry_price_b` | Open of the 9:40 ET 1-min bar |
| `hh_a / ll_a` | Highest high / lowest low from 9:37 → 16:00 |
| `hh_b / ll_b` | Highest high / lowest low from 9:40 → 16:00 |
| `atr14` | 14-day ATR from daily bars before today |
| `up_r_a` | `(hh_a − entry_price_a) / atr14` |
| `down_r_a` | `(entry_price_a − ll_a) / atr14` |
| `up_r_b / down_r_b` | Same formulas for B entry |

### R4A / R4B — Training CSVs

**Files:** `tmp/r4a.csv`, `tmp/r4b.csv`

Built by joining R1 + R3A (or R3B). Contain all R1 feature fields plus outcome
columns (`upR_A`, `downR_A` for R4A; `upR_B`, `downR_B` for R4B).
These are the direct training inputs for the PCA processor.

Can also be created from legacy data via `scripts/convert_legacy_to_r4.py`.
Uploaded via the Analysis tab (POST /api/analysis/upload-csv).

### Shortlist (DB)

**Table:** `shortlist` | **Primary key:** `date`

One entry per day. Items: `{ ticker, tvSymbol, addedAt, method, score, price, change, sector }`.
`method` = `'auto'` or `'manual'`.

---

## 7. Side E — Scoring Engine

**Files:** `src/sideE/score.js` (Node), `src/scoring/server.py` + `scorer.py` + `processor.py` (Python)

### Architecture

```
Node pipeline (sideE/score.js)
    │  POST /score  { card, bias, entry_time }
    ▼
Flask service (src/scoring/server.py, port 3001)
    │
    ▼
LiveScorer (src/scoring/scorer.py)
    │  loads metadata.pkl (scaler + PCA) + factor_N_buckets.csv
    ▼
Score returned: { final_score, used_table, factor_scores, bucket_scores, confidence, ... }
```

### 6 Scoring Bases

| Base | File | Target outcome |
|---|---|---|
| B1 | R4A | upR_A — 9:37 long moves |
| B2 | R4A | downR_A — 9:37 short moves |
| B3 | R4A | max(upR_A, downR_A) |
| B4 | R4B | upR_B — 9:40 long moves |
| B5 | R4B | downR_B — 9:40 short moves |
| B6 | R4B | max(upR_B, downR_B) |

### Score Calculation

1. **Preprocess card:** standardize numerics using training scaler; one-hot encode categoricals
2. **PCA project:** multiply feature vector by k component vectors → k factor scores
3. **Bucket lookup:** for each factor, find which decile bucket the live score falls in
4. **FinalScore per bucket:**
   ```
   RawScore   = (0.5 × Mean_Norm + 0.5 × WinRate_Norm) × 100
   Confidence = n / (n + 5)
   FinalScore = RawScore × Confidence
   ```
5. **Aggregate:** `final_score = mean(FinalScore across k factors)`, rounded to int

### Sub-Table Selection

If the card's `regime` matches a trained sub-table (e.g. `B4/sub_Uptrend`) AND
that sub-table has ≥ 10 training samples, the sub-table is used instead of main.

### Model Outputs Location

`src/scoring/outputs/`
```
B1/main/metadata.pkl, factor_importance.csv, factor_1_buckets.csv, ...
B1/sub_UP/metadata.pkl, ...
...
B6/main/...
```

### Training

**File:** `src/scoring/processor.py`

Reads `tmp/r4a.csv` and `tmp/r4b.csv`. For each of the 6 bases:
1. Selects target column
2. Filters regime (sub-tables only)
3. One-hot encodes categoricals, standardizes numerics
4. Fits PCA, selects k factors by Kaiser criterion (eigenvalue > 1)
5. Splits each factor into 10 decile buckets, computes stats
6. Saves metadata.pkl + CSV files

**Triggered by:**
- `POST /api/analysis/train` (manual from Analysis tab)
- 4:20 PM ET scheduler job (`autoTrainScorer`)
- `POST http://127.0.0.1:3001/train` (Flask direct)

---

## 8. Analysis Tab

The Analysis tab shows the trained model's structure — not a separate analysis engine.

### Model Factors Panel

- Loads via `GET /api/analysis/model-info` → Flask `/model-info`
- Shows 6 base selectors (B1–B6)
- For selected base: lists k PCA factors with explained variance % and top 6 feature loadings per factor
- Sub-table chips load via `GET /api/analysis/available-tables` — clicking a chip opens Table Inspector
- "Download All Tables (JSON)" exports all 6 bases × all tables as a dated JSON file

### Bias Change Flow

When user taps the bias button on a card (auto → long → short → auto):
1. `PUT /api/registry/:ticker/bias` — cycles or sets bias in r0
2. Server immediately calls `scoreRow()` with updated bias
3. Returns new `_score` and `_scoreDetails` in the same response
4. Card updates in the browser without a full scan

---

## 9. Settings

**Table:** `settings` — key/value pairs read per-request (no caching).

| Key | Default | Used by |
|---|---|---|
| `hotImmediateThreshold` | 60 | Side D sectors |
| `hotSustainedThreshold` | 40 | Side D sectors |
| `hotSustainedSessions` | 3 | Side D sectors |
| `hotFloorThreshold` | 20 | Side D sectors |
| `coolOffDays` | 2 | Side D sectors |
| `sectorBullishThreshold` | 20 | Side D sectors |
| `sectorBearishThreshold` | -20 | Side D sectors |
| `shortlistMinScore` | 70 | Side F auto-rule |
| `shortlistTopN` | 5 | Side F auto-rule |
| `scorerEntryTime` | `9:40` | Side E base selection |
| `finnhubApiKey` | '' | Side C news |
| `githubBackupToken` | '' | Backup |
| `alpacaApiKey` | '' | Side H R3 capture |
| `alpacaApiSecret` | '' | Side H R3 capture |
| `aiApiKey` | '' | AI insights |
| `aiModel` | `anthropic/claude-haiku-4-5` | AI insights |

`finnhubApiKey`, `githubBackupToken`, `alpacaApiKey`, `alpacaApiSecret`, and `aiApiKey`
are masked in `GET /api/settings` (returns `'set'` or `''`).

`hotState` lives in memory in `src/sideD/sectors.js`. Resets on restart or via
`POST /api/settings/reset-hot`.

---

## 10. API Endpoints

| Endpoint | Method | What it does |
|---|---|---|
| `/api/registry/today` | GET | Today's r0 rows. Live rows first, then stale. |
| `/api/registry/all` | GET | All r0 rows regardless of date. |
| `/api/registry/:ticker/bias` | PUT | Set/cycle bias; triggers immediate rescore. Returns new `_score`. |
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
| `/api/analysis/model-info` | GET | PCA factor compositions for all trained bases. |
| `/api/analysis/available-tables` | GET | All trained bases and sub-table names. |
| `/api/analysis/train` | POST | Trigger retraining from tmp/r4a.csv + tmp/r4b.csv. |
| `/api/analysis/upload-csv` | POST | Upload R4A or R4B CSV. Query: `?register=r4a&mode=replace\|append` |
| `/api/settings` | GET | All settings (sensitive keys masked). |
| `/api/settings` | POST | Validate and save settings. Body: `{ key: value, ... }` |
| `/api/settings/test/:service` | GET | Live API connectivity test (`finnhub`/`github`/`alpaca`/`ai`). |
| `/api/settings/reset-hot` | POST | Clear hotState in memory. |
| `/api/backup/status` | GET | Last backup time, token configured, repo name. |
| `/api/backup/push` | POST | Run backup now → push to GitHub. |
| `/api/backup/restore` | POST | Restore from GitHub. Body: `{ date? }` (omit for latest). |
| `/api/monitor` | GET | Pipeline lastReport + all scheduler job statuses. |
| `/health` | GET | `{ ok: true, ts }` — Node process health check. |

**Flask service (port 3001, internal only):**

| Endpoint | Method | What it does |
|---|---|---|
| `/health` | GET | `{ ok, ready }` — ready = model trained |
| `/score` | POST | Score a card. Body: `{ card, bias, entry_time }` |
| `/train` | POST | Retrain from R4A/R4B paths. Body: `{ r4a?, r4b? }` |
| `/model-info` | GET | Factor compositions for all bases |

---

## 11. The Browser (Frontend)

**File:** `public/index.html` — single HTML file, all JS inline.

The browser does NO business logic. It only fetches from the API, renders, and
passes actions back to the server.

### Tabs and their data sources

| Tab | Primary API call | When it loads |
|---|---|---|
| Screener | `GET /api/registry/today` | On tab open and after scan |
| Market | `GET /api/market/snapshot` | On tab open and after scan |
| Shortlist | `GET /api/shortlist/today` + `GET /api/shortlist/all` | On tab open |
| Warehouse | `GET /api/warehouse/registers` + `GET /api/warehouse/data/:register` | On tab open + date change |
| Analysis | `GET /api/analysis/model-info` | On Load / Refresh button |
| Settings | `GET /api/settings` + `GET /api/backup/status` | On tab open |
| Monitor | `GET /api/monitor` | On tab open + Refresh button |

### Scanner card fields

- `row.stock.price`, `row.stock.change`, etc. — from Side A + B
- `row.context.regime`, `row.context.secBias`, etc. — from Side D
- `row.catalyst` — from Side C
- `row._score`, `row._scoreDetails` — from Side E
- `row.bias` — user-set, displayed as button that cycles auto→long→short→auto
- `row.inShortlist` — star shown filled/empty
- `row.liveNow` — green `●Live` dot or grey `●Stale` dot with amber border

### Bias button behavior

Tapping the bias button calls `PUT /api/registry/:ticker/bias` (no body = cycle).
The response immediately includes the new `_score` and `_scoreDetails` — the card
updates without a full scan. `auto` bias displays its resolved direction in
parentheses: `AUTO (long)` or `AUTO (short)`.

### Monitor tab

Two sections:

**Scheduled Jobs** — card per job showing name, cron, last run, status, duration.
Each card has:
- ON/OFF toggle → `POST /api/monitor/jobs/:jobId/toggle`
- Edit button → modal with day-of-week toggles, hour/minute inputs, live cron
  preview, Save/Cancel/Reset Default buttons

**Last Pipeline Run** — stage-by-stage table from `lastReport`.

---

## 12. Backup System

**Files:** `src/backup/index.js`, `src/routes/backup.js`

### Push (daily 5:30 PM ET or manual)

1. Reads GitHub token from `settings` table
2. Exports: `settings`, `shortlist`, `r1_frozen`, `r2_market_snapshots`, `r3a`, `r3b`
3. Pushes to repo `Mohamed-albadri-1995/trade-desk-data`, branch `fresh`:
   - `backups/YYYY-MM-DD.json`
   - `backups/latest.json`
4. Records `lastBackupAt` in settings

### Restore (manual from Settings tab)

1. Fetches `backups/latest.json` (or dated file)
2. Clears and repopulates all exported tables in a DB transaction
3. r0 is not affected — rebuilds on next scan

---

## 13. Current Status

| Item | Status |
|---|---|
| Side A — TradingView Scanner | ✅ Complete |
| Side B — Derived Calculations | ✅ Complete |
| Side C — News & Catalyst | ✅ Complete |
| Side D — Market Context & Regime | ✅ Complete (15 regime labels) |
| Side E — Live Scoring (pipeline) | ✅ Complete — scores every scan |
| Side E — Bias preservation across scans | ✅ Complete |
| Side E — Auto-bias resolution | ✅ Complete — always Long or Short, never Undefined |
| Side E — Scoring Engine (Flask) | ✅ Complete — B1–B6, PCA, buckets, confidence |
| Side E — Scorer auto-train (4:20 PM) | ✅ Complete |
| Side F — Shortlist | ✅ Complete |
| Side G — Stale Ticker Refresh | ✅ Complete |
| Side H — R3 EOD Capture (Alpaca) | ✅ Complete |
| r0 checkpoint (survive restart) | ✅ Complete |
| Settings System | ✅ Complete |
| Backup / Restore | ✅ Complete |
| Monitor Tab (toggle + schedule editor) | ✅ Complete |
| Analysis Tab (Model Factors + sub-tables) | ✅ Complete |
| Shortlist Auto-Rule | ⚠️ Wired — fires at 9:35 AM but needs score ≥ 70 (unlikely until 100+ training rows) |
| Setup Detection & Alerts | ⏳ Phase 3 |
| Dynamic Sizing Engine | ⏳ Phase 4 |
| Broker Integration | ⏳ Phase 5 |
| Trade Journal | ⏳ Phase 6 |
| Grading Engine | ⏳ Phase 7 |
