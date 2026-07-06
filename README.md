# Trade Desk Server

Real-time trading tool implementing the **v11 authoritative specification**
(`Comprehensive Specification for Trading Tool Development`): user-defined
trading logic via raw Python scripts, continuous market/screener monitoring,
and immutable entry cards with a zero-latency signal pipeline.

## Quick start

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ALPACA_API_KEY, ALPACA_SECRET_KEY, SCREENER_URL, SECRET_KEY
uvicorn main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000 for the UI (Watch, Journal, Setups, Conditions,
Watchlist, Gate & Sizing, Brokers, Settings — all live over WebSocket, no
refresh needed).

Run the tests:

```bash
pytest
```

## Architecture

| Piece | Where | Role |
| :--- | :--- | :--- |
| `qp/` | primitives library | **All** indicator math (`qp.REGISTRY[key].fn`); nothing is re-implemented in the tool |
| `app/services/sandbox.py` | sandbox | Raw scripts run via `exec()` with whitelisted imports (`typing`, `datetime`, `math`, `collections`) and removed built-ins |
| `app/services/market_proxy.py` | injected `market_data` | `get_ohlcv`, `get_current_price`, plus dynamic methods for every registered primitive (e.g. `market_data.sma(stock, length=9)`) |
| `app/services/market_data.py` | MarketDataService | OHLCV bars from Alpaca → Polygon → Yahoo fallback, cached every 5 s |
| `app/services/screener_data.py` | ScreenerDataService | `SCREENER_URL/api/registry` → `TickerContext` cache every 15 s |
| `app/services/monitor.py` | MonitorService | Continuous evaluation loop + the exact 10-step signal pipeline |
| `app/services/*_engine.py` | Setup / Condition / Gate / Sizer / Grade / Broker engines | Modular, swappable services per spec §3 |
| `app/services/journal_service.py` | JournalService | Immutable entry cards; exit snapshots filled later |
| `app/services/event_bus.py` | EventBus | WebSocket fan-out (`/ws`) |
| `static/index.html` | UI | Watch cards, journal breakdowns, admin tabs |

### Signal pipeline (spec §4)

Setup fires → record `signal_time` → evaluate default/additional conditions →
resolve entry/SL/TP from cache → **gate check** (rejected cards are journaled
and stop) → sizing → grading → immutable entry card → broker dispatch
(Alpaca SDK/REST, SignalStack webhook) → status `alerted`. All inputs are
cached in memory: no network calls at signal time.

### Grading model

`GradeEngine` follows the screener's Side E scoring principles: the model
is loaded from the database (user-editable on the Gate & Sizing tab or via
`GET/PUT /api/grading/model`), every default/additional condition is a
signal contributing weighted points (asymmetric aligned/misaligned weights,
plus per-condition overrides), `score = Σ signal_points` normalized to
0–100, and fixed thresholds classify the score into A+/A/B/C/D.
**Mandatory conditions are never graded** — they are prerequisites for the
signal, not quality signals. The per-condition points breakdown is stored
in `entry_factors.grade_breakdown` on every entry card, so future analysis
(e.g. a setup-enhancement engine that flags harmful or irrelevant
conditions) has per-trade data to learn from.
`POST /api/grading/preview` dry-runs the current model against
hypothetical condition results.

### Script interfaces (spec §8)

Setups must define `SetupIndicator`, conditions `ConditionCheck` — see
`examples/setup_ema_cross.py` and `examples/condition_rel_volume.py`.

### Analytics & setup factor

Closing a trade (Journal tab form, `PUT /api/journal/{id}/exit`, or CSV
import via `/api/journal/import-exits`) enriches the card once with
R-multiple, planned RR, MAE/MFE, capture % and an exit verdict. The
**Analytics** tab (all math server-side under `/api/analytics/*`) shows
Overview (stat tiles + equity/drawdown curve), Calendar, Time (entry
hour/session/weekday/hold), Risk (R histogram, stop overruns), Stats
(every metric with its formula), Magnitude (MAE/MFE scatter, capture
distribution) and Breakdowns (by setup/grade/regime/side/stock/hour/
session/weekday/condition).

The **SetupFactorEngine** (`/api/setup-factor`) turns each setup's real
performance (expectancy R, profit factor, win rate, drawdown R, recent
form) into a sizing factor via the same DB-backed signal-points pattern
as grading, with confidence shrinkage toward 1.0 for small samples; the
mapping reaches **0.0**, which blocks alerts (card status
`blocked_by_setup_factor`). Sizing is per **account**
(`/api/accounts`, `/api/capital`): each active account has its own
capital base (live Alpaca buying power when a broker is linked, else
manual) and every position is hard-capped to available capital at the
moment of the signal — `final = min(risk-based, available/entry)`.
Pipeline order: grade (step 6) then size (step 7);
`shares = base × grade × regime × setup_factor`.

### Watchlist & session

By default (`watchlist_source: screener`) the watchlist is pulled
automatically from the screener registry and the market feed re-syncs
whenever the registry changes; switch to `manual` in Settings to use
`.csv`/`.json` uploads on the Watchlist tab instead. The screener itself
is embedded in the UI's **Screener** tab (from `SCREENER_URL`), so both
tools live on one page.

New entries are evaluated only inside the **entry window** (ET), default
**09:35–10:00** — the session starts and stops automatically, and both
times are editable in Settings. Open positions are monitored around the
clock regardless of the window.

The setup factor is computed **per side** (long/short) with pooled
fallback while a side has too few trades (toggle `split_by_side` in the
factor model).
