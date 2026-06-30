# Trade Desk Server

A self-hosted Node.js + Python trading research tool. Scans TradingView for momentum stocks, enriches them with market context, news, and catalysts, scores them via a PCA-based factor analysis model, manages a daily shortlist, and stores historical trade data for model training.

---

## Stack

- **Runtime:** Node.js + Express (port 3000)
- **Scoring service:** Python Flask (port 3001, PM2 process `scorer`)
- **Database:** SQLite via `better-sqlite3` (WAL mode)
- **Process manager:** PM2 (two processes: `trade-desk` + `scorer`)
- **Frontend:** Single-file SPA (`public/index.html`) — all JS inline, no build step
- **External APIs:** TradingView scanner, Finnhub, Yahoo Finance, SEC EDGAR, Alpaca Market Data, Anthropic / OpenRouter / Google Gemini AI

---

## Quick Start

```bash
# Install Node dependencies
npm install

# Install Python dependencies
pip3 install -r src/scoring/requirements.txt

# Start (production via PM2)
bash deploy.sh
```

Server UI at `http://localhost:3000`. Scoring service at `http://127.0.0.1:3001`.

---

## Project Structure

```
src/
  index.js              # Entry point — Express app, route registration, scheduler start
  pipeline.js           # Full scan orchestrator (Sides A → B → D → E → G → C → F)
  db/index.js           # SQLite setup, table creation, default settings
  scheduler.js          # Cron jobs (scan, R1, R2, R3, backup, scorer auto-train, midnight flush)
  r0/registry.js        # In-memory ticker registry (Map) + SQLite checkpoint
  sideA/                # TradingView scanner — fetch + merge
  sideB/                # Derived field calculations
  sideC/                # News & catalyst (Finnhub, Yahoo, SEC EDGAR)
  sideD/                # Market context — regime, sector bias, hot state
  sideE/score.js        # Live scoring — calls Flask service, builds card dict
  sideF/shortlist.js    # Shortlist management and auto-rule
  sideG/staleFetch.js   # Stale ticker quote refresh
  sideH/capture.js      # R3 EOD capture (Alpaca)
  scoring/
    server.py           # Flask scoring service (port 3001)
    scorer.py           # LiveScorer — loads model outputs, scores a live card
    processor.py        # FactorAnalysisProcessor — trains PCA model from R4A/R4B CSVs
    requirements.txt    # Python dependencies
  alpaca/               # Alpaca API client
  backup/               # GitHub backup push/restore
  warehouse/            # Register read paths (R1, R2, R3A, R3B, R4A, R4B)
  routes/               # Express route handlers
scripts/
  convert_legacy_to_r4.py   # Convert legacy mergedregister CSV → R4A/R4B
  verify_irdm_score.py      # Manual score verification (run on EC2)
public/
  index.html            # Full browser UI — 7 tabs, all logic inline
data/
  tradedesk.db          # SQLite database (created on first run)
tmp/
  r4a.csv               # Training data — 9:37 entry outcomes
  r4b.csv               # Training data — 9:40 entry outcomes
```

---

## Tabs

| Tab | Purpose |
|---|---|
| Screener | Live r0 registry — stocks returned by current/recent scans with scores, bias, context |
| Market | Market regime, sector bias heatmap, index data (SPY/QQQ/IWM/VIX) |
| Shortlist | Daily watchlist — auto-rule and manual picks, TradingView export |
| Warehouse | Historical data viewer — R1, R2, R3A, R3B, R4A, R4B registers |
| Analysis | Model Factors panel (PCA factor compositions, sub-table chips, download all tables) |
| Settings | Thresholds, API keys (Finnhub/Alpaca/GitHub/AI), live connection tests |
| Monitor | Pipeline stage report, scheduler job history with toggle + schedule editor |

---

## Scoring Engine

The scoring engine runs as a Python Flask service on port 3001. It uses PCA factor analysis trained on historical R4A/R4B data to score every stock on each scan.

### 6 Scoring Bases

| Base | File | Target | Entry |
|---|---|---|---|
| B1 | R4A | upR_A (long moves) | 9:37 |
| B2 | R4A | downR_A (short moves) | 9:37 |
| B3 | R4A | max(upR_A, downR_A) | 9:37 |
| B4 | R4B | upR_B (long moves) | 9:40 |
| B5 | R4B | downR_B (short moves) | 9:40 |
| B6 | R4B | max(upR_B, downR_B) | 9:40 |

Base is selected from card `bias` (long/short/auto) + `scorerEntryTime` setting.

### Bias Resolution

`auto` bias is resolved from market context:
- Any bearish signal (shortTerm or secBias BEARISH) → Short
- Any bullish signal → Long
- Default → Long

### Score Formula

```
RawScore   = (0.5 × Mean_Norm + 0.5 × WinRate_Norm) × 100
Confidence = n / (n + 5)
FinalScore = RawScore × Confidence
Score      = mean(FinalScore across all k PCA factors)
```

At 22 training rows: max score ~28. At 100 rows: ~67. At 200+ rows: ~80+.

### Training

Training runs automatically at **4:20 PM ET** each trading day, consuming the R4A/R4B CSVs in `tmp/`. Manual training available via the Analysis tab or `POST /api/analysis/train`.

---

## Settings

All settings are stored in the `settings` DB table and editable from the Settings tab. Sensitive keys are masked in the API (returned as `"set"` or `""`).

### Hot Sector Thresholds
| Key | Default | Description |
|---|---|---|
| `hotImmediateThreshold` | 60 | Sector score that instantly marks a sector HOT |
| `hotSustainedThreshold` | 40 | Score needed to sustain progression toward HOT |
| `hotSustainedSessions` | 3 | Consecutive sessions at threshold before HOT |
| `hotFloorThreshold` | 20 | Score floor to remain HOT |
| `coolOffDays` | 2 | Sessions below floor before losing HOT status |

### Sector Bias
| Key | Default |
|---|---|
| `sectorBullishThreshold` | 20 |
| `sectorBearishThreshold` | -20 |

### Shortlist
| Key | Default |
|---|---|
| `shortlistMinScore` | 70 |
| `shortlistTopN` | 5 |

### Scoring
| Key | Default | Description |
|---|---|---|
| `scorerEntryTime` | `9:40` | Entry time used for base selection (9:37 or 9:40) |

### API Keys (masked)
| Key | Used by |
|---|---|
| `finnhubApiKey` | Side C — news fetch |
| `githubBackupToken` | Backup push/restore |
| `alpacaApiKey` | Side H — R3 EOD capture |
| `alpacaApiSecret` | Side H — R3 EOD capture |
| `aiApiKey` | AI-generated insights |

### AI Settings
| Key | Default | Description |
|---|---|---|
| `aiModel` | `anthropic/claude-haiku-4-5` | Model ID for the selected provider |

**Supported providers** (auto-detected from key prefix):
- **OpenRouter** — key starts with `sk-or-` — model IDs use `provider/model` format
- **Claude (Anthropic)** — key starts with `sk-ant-` — model IDs use `claude-*` format
- **Gemini (Google)** — key starts with `AIza` — model IDs use `gemini-*` format

---

## Scheduler

All times Eastern (America/New_York), Mon–Fri unless noted.

| Job | Time | Description |
|---|---|---|
| Full Scan | 7:00, 7:30, 8:00, 8:30 AM | Pre-market every 30 min |
| Full Scan | Every 5 min, 9:00–9:55 AM | Market open hour |
| Full Scan | 10 AM, 1 PM, 4 PM, 7 PM, 10 PM | Off-hours every 3 hours |
| Shortlist Auto-Rule | 9:35 AM | Auto-picks top-N by score |
| R1 Capture | 9:36 AM | Freezes r0 snapshot to DB |
| R2 Snapshot | 9:25–10:00 AM (every 5 min) | Market context snapshots |
| R3 EOD Capture | 4:05 PM | Alpaca bars → trade levels → DB |
| Scorer Auto-Train | 4:20 PM | Retrains model from tmp/r4a.csv + tmp/r4b.csv |
| Daily Backup | 5:30 PM | Push DB export to GitHub |
| Midnight Flush | 12:00 AM (every day) | Clear r0 in-memory registry |

---

## Data Registers

| Register | Storage | Description |
|---|---|---|
| r0 | Memory + SQLite checkpoint | Live ticker registry — resets on restart, checkpoint restored if same day |
| R1 | DB (`r1_frozen`) | 9:36 AM frozen snapshot per ticker |
| R2 | DB (`r2_market_snapshots`) | Market context snapshots throughout open |
| R3A | DB (`r3a`) | Entry A (9:37 open), HH/LL/ATR/R-values |
| R3B | DB (`r3b`) | Entry B (9:40 open), HH/LL/ATR/R-values |
| R4A | `tmp/r4a.csv` | Training data: R1 fields + upR_A/downR_A outcomes |
| R4B | `tmp/r4b.csv` | Training data: R1 fields + upR_B/downR_B outcomes |

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/registry/today` | GET | Today's r0 rows (live first) |
| `/api/registry/all` | GET | All r0 rows |
| `/api/registry/:ticker/bias` | PUT | Set/cycle bias for a ticker; triggers immediate rescore |
| `/api/scan/run` | POST | Run full scan now |
| `/api/scan/status` | GET | Last run, row count, pipeline report |
| `/api/market/snapshot` | GET | Latest Side D market snapshot |
| `/api/news/:ticker` | GET | Fetch news on-demand for one ticker |
| `/api/shortlist/today` | GET | Today's shortlist |
| `/api/shortlist/all` | GET | All shortlist entries |
| `/api/shortlist/toggle/:ticker` | POST | Add/remove ticker from shortlist |
| `/api/shortlist/export/:date` | GET | TradingView `.txt` export |
| `/api/shortlist/run-rule` | POST | Trigger shortlist auto-rule manually |
| `/api/warehouse/registers` | GET | Available registers and dates |
| `/api/warehouse/data/:register` | GET | Register data (`?date=YYYY-MM-DD`) |
| `/api/analysis/model-info` | GET | PCA factor compositions for all trained bases |
| `/api/analysis/available-tables` | GET | List all trained bases and sub-tables |
| `/api/analysis/train` | POST | Trigger retraining from tmp/r4a.csv + tmp/r4b.csv |
| `/api/analysis/upload-csv` | POST | Upload R4A or R4B CSV (`?register=r4a&mode=replace\|append`) |
| `/api/settings` | GET | All settings (sensitive keys masked) |
| `/api/settings` | POST | Save settings with validation |
| `/api/settings/test/:service` | GET | Live connection test (`finnhub`/`github`/`alpaca`/`ai`) |
| `/api/settings/reset-hot` | POST | Clear hot sector state |
| `/api/backup/status` | GET | Last backup time and config |
| `/api/backup/push` | POST | Run backup now |
| `/api/backup/restore` | POST | Restore from GitHub (`{ date? }`) |
| `/api/monitor` | GET | Pipeline report + scheduler job statuses |
| `/health` | GET | `{ ok: true, ts }` |

---

## Development Roadmap

| Phase | Goal | Status |
|---|---|---|
| 1 — Test & Debug | Validate all systems end-to-end on live market days | ✅ Complete |
| 2 — Scoring Engine | PCA factor model, Flask service, live scoring every scan | ✅ Complete |
| 3 — Setup Detection & Alerts | Named condition checklists; scan shortlist after each scan; push notification on match | ⏳ Next |
| 4 — Dynamic Sizing Engine | Position size = `base_risk × regime_multiplier × grade_multiplier` | ⏳ |
| 5 — Broker Integration | Alpaca order submission from UI; positions tab; pre-trade checklist gate | ⏳ |
| 6 — Trade Journal | Full entry + exit snapshot: conditions, market state, checklist, P&L in R-multiples | ⏳ |
| 7 — Grading Engine | Auto-grade trades A+/A/B/C/D from checklist alignment, score, and regime | ⏳ |
