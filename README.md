# Trade Desk Server

A self-hosted Node.js trading research tool. Scans TradingView for momentum stocks, enriches them with market context, news, and catalysts, manages a daily shortlist, and runs an analysis engine on historical trade data.

---

## Stack

- **Runtime:** Node.js + Express
- **Database:** SQLite via `better-sqlite3` (WAL mode)
- **Process manager:** PM2
- **Frontend:** Single-file SPA (`public/index.html`) — all JS inline, no build step
- **External APIs:** TradingView scanner, Finnhub, Yahoo Finance, SEC EDGAR, Alpaca Market Data, Anthropic / OpenRouter / Google Gemini AI

---

## Quick Start

```bash
# Install
npm install

# Start (development)
node src/index.js

# Start (production via PM2)
bash deploy.sh
```

Server listens on **port 3000**. Browser UI at `http://localhost:3000`.

---

## Project Structure

```
src/
  index.js              # Entry point — Express app, route registration, scheduler start
  pipeline.js           # Full scan orchestrator (Sides A → B → D → E → G → C → F)
  db/index.js           # SQLite setup, table creation, default settings
  scheduler.js          # Cron jobs (scan, R1, R2, R3, backup, midnight flush)
  r0/registry.js        # In-memory ticker registry (Map)
  sideA/                # TradingView scanner — fetch + merge
  sideB/                # Derived field calculations
  sideC/                # News & catalyst (Finnhub, Yahoo, SEC EDGAR)
  sideD/                # Market context — regime, sector bias, hot state
  sideE/                # Analysis engine — feature importance, insights, AI
  sideG/                # Stale ticker quote refresh
  sideH/                # R3 EOD capture (Alpaca)
  alpaca/               # Alpaca API client
  backup/               # GitHub backup push/restore
  warehouse/            # Register read paths (R1, R2, R3A, R3B, R4A, R4B)
  routes/               # Express route handlers
public/
  index.html            # Full browser UI — 7 tabs, all logic inline
data/
  tradedesk.db          # SQLite database (created on first run)
tests/                  # Unit tests
```

---

## Tabs

| Tab | Purpose |
|---|---|
| Screener | Live r0 registry — stocks returned by current/recent scans with full context |
| Market | Market regime, sector bias heatmap, index data (SPY/QQQ/IWM/VIX) |
| Shortlist | Daily watchlist — auto-rule and manual picks, TradingView export |
| Warehouse | Historical data viewer — R1, R2, R3A, R3B, R4A, R4B registers |
| Analysis | Feature importance engine, bucket analysis, AI-generated insights (Side E) |
| Settings | Thresholds, API keys (Finnhub/Alpaca/GitHub/AI), live connection tests |
| Monitor | Pipeline stage report, scheduler job history |

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

### API Keys (masked)
| Key | Used by |
|---|---|
| `finnhubApiKey` | Side C — news fetch |
| `githubBackupToken` | Backup push/restore |
| `alpacaApiKey` | Side H — R3 EOD capture |
| `alpacaApiSecret` | Side H — R3 EOD capture |
| `aiApiKey` | Side E — AI-generated insights |

### AI Settings
| Key | Default | Description |
|---|---|---|
| `aiModel` | `anthropic/claude-haiku-4-5` | Model ID for the selected provider |

**Supported providers** (selected in UI — detected from key prefix on the server):
- **OpenRouter** — key starts with `sk-or-` — model IDs use `provider/model` format
- **Claude (Anthropic)** — key starts with `sk-ant-` — model IDs use `claude-*` format
- **Gemini (Google)** — key starts with `AIza` — model IDs use `gemini-*` format

### Analysis Engine
| Key | Default | Description |
|---|---|---|
| `analysisEntryType` | `A` | Entry type for training (A = 9:37 open, B = 9:40 open) |
| `analysisDirectionalBias` | `Up` | Which direction to train on |
| `analysisSuccessThreshold` | `1.5` | Minimum R-multiple to count as a win |
| `analysisTrainingWindow` | `90` | Number of days of historical data to use |

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
| Daily Backup | 5:30 PM | Push DB export to GitHub |
| Midnight Flush | 12:00 AM (every day) | Clear r0 in-memory registry |

---

## Data Registers

| Register | Storage | Description |
|---|---|---|
| r0 | Memory only | Live ticker registry — resets on restart |
| R1 | DB (`r1_frozen`) | 9:36 AM frozen snapshot per ticker |
| R2 | DB (`r2_market_snapshots`) | Market context snapshots throughout open |
| R3A | DB (`r3a`) | Entry A (9:37 open), HH/LL/ATR/R-values |
| R3B | DB (`r3b`) | Entry B (9:40 open), HH/LL/ATR/R-values |
| R4A | Computed | R1 joined with R3A — used for analysis training |
| R4B | Computed | R1 joined with R3B |

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/registry/today` | GET | Today's r0 rows (live first) |
| `/api/registry/all` | GET | All r0 rows |
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
| `/api/analysis/report` | GET | Full analysis report (features, insights) |
| `/api/analysis/train` | POST | Train model on historical R4A data |
| `/api/analysis/insights` | GET | Get or regenerate insights (`?regenerate=true&ai=true`) |
| `/api/analysis/feature/:name` | GET | Bucket breakdown for one feature |
| `/api/settings` | GET | All settings (sensitive keys masked) |
| `/api/settings` | POST | Save settings with validation |
| `/api/settings/test/:service` | GET | Live connection test (`finnhub`/`github`/`alpaca`/`ai`) |
| `/api/settings/reset-hot` | POST | Clear hot sector state |
| `/api/backup/status` | GET | Last backup time and config |
| `/api/backup/push` | POST | Run backup now |
| `/api/backup/restore` | POST | Restore from GitHub (`{ date? }`) |
| `/api/monitor` | GET | Pipeline report + scheduler job statuses |
| `/health` | GET | `{ ok: true, ts }` |
