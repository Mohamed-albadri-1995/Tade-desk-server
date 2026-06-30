# Trading Tool — System Plan (Final)

## Scanner → Trading Connection

**At 9:35 AM:** One-time shortlist pull (ticker, `_score`, `_scoreDetails`, bias, confidence).

**9:35 – 10:00 AM (every 30s):** Context poll per ticker (regime, secBias, shortTerm, midTerm, longTerm, broadResolved, secScore, sector, industry).

No prices or technical data from scanner. All market data from Alpaca WebSocket.

---

## Side A — Market Conditions Register ✅ Closed

**Input:** Scanner context, refreshed every 30s.

**Output per ticker:**
- `longAllowed: true/false`
- `shortAllowed: true/false`
- Sizing multiplier → Side C (default 1.0, reducible in marginal conditions)

Rules configurable in settings. Runs 9:35–10:00, updates on every poll.

---

## Side B — Setup Matcher ✅ Closed

**Window:** 9:35–10:00 AM default. Configurable per setup (start time, end time).

**Data source:** Alpaca WebSocket — Trades, Quotes, 1-min Bars. Historical volume baseline (10-day avg by minute-of-day) loaded at startup for rvol.

**Signal Engine:**
- Pine Script indicator built and tested on TradingView.
- Natively reimplemented on server in JavaScript/Python.
- When server matches TradingView, implementation is verified. The match itself defines the mandatory conditions — no separate specification needed.
- Additional conditions and grading deferred until trade history accumulates.

**Layer sequence:**
1. Signal Engine fires → direction (Long/Short) + SL + TP.
2. Direction Gate checks Side A → if direction not allowed, discard and keep monitoring.

**Output (when signal passes):** Ticker, direction, entry order type, SL, TP, signal timestamp, setup ID.

### Indicator Matching & Verification Process

**Phase 1 — Historical Backtest**
- Export OHLCV from Alpaca for test dates.
- Export TradingView signal log for same dates (ticker, time, direction, SL, TP).
- Run server implementation over same data.
- Compare row by row — must match 100% before going live.

**Phase 2 — End-of-Day Snapshot Comparison**
- TradingView exports daily signal log (manually or via alert).
- Server records its own signal log throughout the day.
- Automated end-of-day comparison report: matches vs mismatches flagged.

**Phase 3 — Webhook (parallel live check)**
- TradingView alert → webhook → server endpoint.
- Server compares incoming webhook signal against its own native signal in real time.
- Agreement → proceed. Disagreement → log and flag.

**Matching is a prerequisite before Side B goes live in any session.**

### Side B UI

**Per-ticker card (watching):**
```
[ AAPL ]  Setup: VWAP-Reclaim          9:42:17 AM
─────────────────────────────────────────────────
Direction Gate:  ✅ Long Allowed
Signal:          ⏳ Watching...
  rvol 2.4×   ema9/20 Aligned   vwap Above   atr 0.43
```

**When signal fires:**
```
[ AAPL ]  Setup: VWAP-Reclaim          9:42:17 AM  🔔 SIGNAL
─────────────────────────────────────────────────────────────
Direction: LONG    Entry: Market    SL: 184.20    TP: 186.00
Gate: ✅ Long Allowed    Score: 82  |  Confidence: 74%

[ Send to Center ]                        [ Dismiss ]
```

**Side panel:** Active tickers with status (⏳ watching / 🔔 signal / ✅ dismissed / ⛔ blocked), session signal history log, indicator match status badge per setup.

---

## Side C — Position Size Calculator ✅ Closed

**Inputs:** Equity (Alpaca account API), risk % per trade, stop distance (|entry − SL|), Side A multiplier, `_score` multiplier, hard caps (max shares, max dollar risk, max total exposure). All configurable.

**Formula:**
```
risk_dollars = equity × risk_pct × sideA_multiplier × score_multiplier
shares       = floor(risk_dollars / stop_distance)
shares       = min(shares, max_shares_cap)
```

**Output:** Recommended shares, dollar risk, position value → Center.

---

## Center — Execution & Risk Gate ✅ Closed (structure only, Alpaca deferred)

**Triggered when Side B signal passes direction gate.**

**Displays:** Ticker, direction, setup, signal time, entry order type + suggested price, SL, TP, sizing (shares / dollar risk / position value), Side A status, score + confidence.

**Pre-trade risk checks (configurable, blocking):**
- Max open positions not exceeded
- Daily loss limit not breached
- No duplicate position on same ticker

**Execution — current phase (notification only):**
- "Send Order" generates:
  1. **Humanized message:** "Buy 47 shares of AAPL at market. Stop $184.20, target $186.00. Risk: $102."
  2. **Alpaca-ready payload** (logged, displayed): `{ symbol, qty, side, type, order_class, stop_loss, take_profit }`
- Structure is wired and ready. When Alpaca connection is added: replace notification step with `POST /v2/orders`. No other changes needed.

---

## Journal ← Next to Plan

Core items to design in the next planning session:
- Journal entry structure (fields, what's user-input vs auto-computed)
- Data fetch process (Yahoo Finance / Alpaca historical bars for technical field reconstruction)
- Journal card layout and direction-aware checklist
- Per-setup card templates
- MAE / MFE / R-multiple / Capture % computation
- Grading system (additional conditions, delta-expectancy, bootstrap defaults)
- Analysis tab (performance metrics per setup, per condition combination, per regime)

---

## What We Haven't Covered Yet

| Item | Notes |
|---|---|
| **Settings UI for trading tool** | Risk %, caps, setup config, entry window times — needs its own settings panel separate from scanner |
| **Session management** | How the tool starts a session (connect to Alpaca WS, load shortlist, load setups), pause/resume, graceful shutdown at 10 AM |
| **Setup management UI** | Creating, editing, enabling/disabling setups; per-setup config (entry type, SL/TP rules, entry window) |
| **Position tracking** | After Center fires a notification, tracking open positions (manual input until Alpaca connected) |
| **Daily loss limit enforcement** | Needs a daily P&L tracker — source of truth when Alpaca not connected is manual |
| **Alpaca connection (deferred)** | Order submission, order status WebSocket, account equity polling |
| **Phone / push notifications** | Delivery mechanism for Center alerts not yet specified |
| **Deployment** | Whether trading tool runs on same EC2 as scanner or separate; port allocation; PM2 process |
| **Historical volume baseline** | How 10-day avg volume by minute-of-day is built and refreshed (daily job or on-demand) |
