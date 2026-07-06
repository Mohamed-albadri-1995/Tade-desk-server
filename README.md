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
and stop) → sizing → grading (placeholder `('B', 1.0)`) → immutable entry
card → broker dispatch (Alpaca SDK/REST, SignalStack webhook) → status
`alerted`. All inputs are cached in memory: no network calls at signal time.

### Script interfaces (spec §8)

Setups must define `SetupIndicator`, conditions `ConditionCheck` — see
`examples/setup_ema_cross.py` and `examples/condition_rel_volume.py`.

### Watchlist import

Upload `.csv` or `.json` on the Watchlist tab (extracts the `ticker` field
per record); the data feeds restart automatically with the new symbols.
