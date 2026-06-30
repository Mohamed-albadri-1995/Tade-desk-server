# Journal — System Plan

---

## Two Parts

### Part 1 — Trade Card (setup-aware, grading engine)

Each trade is linked to a setup. The setup defines which conditions appear on the card.
Technical fields are computed after the fact from Yahoo Finance / Alpaca historical bars using entry date, ticker, entry time, exit time, entry price, exit price.
Scanner context (regime, secBias, etc.) is captured at signal fire time and stored — used for card analysis, NOT recomputed later.

**Alignment logic (direction-aware):**

| Condition | Long = aligned | Short = aligned |
|---|---|---|
| Price vs VWAP | Price above VWAP | Price below VWAP |
| Price vs MA (9, 13, 20, 50) | Price above MA | Price below MA |
| MA slope | Sloping up | Sloping down |
| MA stack (9 > 13 > 20) | Stacked bullish | Stacked bearish |
| Price vs BB midline | Price above midline | Price below midline |
| BB band zone | Upper zone (above midline) | Lower zone (below midline) |
| secBias | BULLISH | BEARISH |
| broadResolved | BULLISH | BEARISH |
| shortTerm / midTerm / longTerm | BULLISH | BEARISH |
| PM High | Price above PM High | Price below PM High |
| PM Low | Price above PM Low (support) | Price below PM Low |
| Hot sector | secScore ≥ threshold | secScore ≤ –threshold |
| RVOL | ≥ threshold (same for both) | ≥ threshold (same for both) |

**Technical fields computed from data feed (post-trade):**
- From Alpaca/Yahoo intraday bars at entry time: price, VWAP, EMA9/13/20/50, SMA20, BB (20,2), ATR, rvol
- From Alpaca intraday bars between entry→exit: MAE (max adverse excursion), MFE (max favorable excursion)
- Computed: R-multiple = P&L ÷ initial dollar risk; Capture % = P&L ÷ MFE; hold duration

**Scanner context captured at signal time (stored, not recomputed):**
- regime, regimeLabel, secBias, broadResolved, shortTerm, midTerm, longTerm, secScore, sector, industry, _score, confidence
- Source: the 30s context poll from scanner at the moment the signal fired

**Per-setup condition template:**
- Each setup defines its own list of conditions (keys + section labels)
- Populated after indicator testing phase
- Mandatory conditions: defined by the verified server↔TradingView match
- Additional conditions: added per setup once trade history accumulates

**Card sections (example):**
1. Trade Details (ticker, date, direction, setup, shares, entry/exit price/time, duration, gross/net P&L, commission)
2. Context at Entry (regime, sector, secBias, broadResolved, scanner score)
3. Setup Conditions (checklist — direction-aware aligned/not-aligned per condition)
4. Outcome (MAE, MFE, R-multiple, Capture %, exit verdict)
5. Notes (free text, per trade)

---

### Part 2 — Normal Journal (mirrors old extension, no correlation section)

Import from CSV (TradingView fills, TTP/DXtrade orders history).
Brokers supported: TradingView, Trade the Pool, DXtrade.

**Tabs:**
- Overview (P&L, win rate, profit factor, expectancy, payoff ratio, max drawdown, long/short split)
- Calendar (daily P&L heatmap)
- Time (performance by entry hour, hold duration)
- Risk (MAE/MFE distribution, R histogram, drawdown curve)
- Stats (full metrics catalog)
- Setups (per-setup stats table — see Analysis below)
- Big W/L (top winners and losers)
- Trades (list, filterable, sortable, grouped by day with day header stats)

Each trade card in Part 2 shows: ticker, direction, date, entry/exit, shares, P&L, duration, MAE/MFE/R/Capture (when charts fetched), setup chip, notes.
Chart button → intraday chart with entry/exit markers.

Fees & commissions: per-account profile, applied on import or recalculated.

---

## Analysis & Grading Machine

### Setup Performance (per-setup, expectancy-first)

Primary metric: **Expectancy** = (winRate × avgWin) − (lossRate × avgLoss)

Secondary metrics shown per setup:
- Win rate, trades, avg R, avg capture %, profit factor, avg duration
- Net P&L (total, not per-trade) — reflects volume + sizing
- Risk-weighted contribution: totalDollarRisk = sum(shares × stopDistance per trade)
  → Expectancy per dollar risked = totalNetPnl / totalDollarRisk
  → This compares setups fairly even if one gets larger positions (higher score = more risk)

**Setup grade (bootstrap-aware):**
- Requires N ≥ minimum trades (configurable, default 20) before grade is assigned
- Below N: grade = "B (bootstrapping)"
- Above N: grade based on expectancy per dollar risked and win rate combination
  - A+: expectancy/R ≥ 1.5 AND win rate ≥ 50%
  - A:  expectancy/R ≥ 1.0 AND win rate ≥ 40%
  - B:  expectancy/R ≥ 0.5
  - C:  expectancy/R < 0.5 or negative

### Condition Grading (additional conditions)

For each additional condition defined on a setup:
- Split trades into: condition aligned vs not aligned
- Compute expectancy for each group
- delta_expectancy = expectancy_aligned − expectancy_not_aligned
- If delta_expectancy > 0: condition improves outcome when aligned → positive signal
- Grade condition: A+ (delta ≥ 1.0R), A (delta ≥ 0.5R), B (delta ≥ 0), C (negative delta)
- Minimum trades per group before grading: configurable (default 10)

### Account-Level vs Setup-Level

Account overview shows:
- Total net P&L, win rate, expectancy, drawdown (standard)
- Setup contribution chart: each setup's % of total dollar risk vs % of total P&L
  → Setups that get more risk (higher score → bigger positions) should produce proportionally more P&L
  → "Risk-adjusted contribution" bar: (setup P&L / total P&L) vs (setup dollar risk / total dollar risk)

---

## Scanner Data Timing Note

Fields used for card analysis that come from the scanner must be captured **at trade entry time**, not reconstructed later:
- Hot sector check: secScore captured at signal fire time (30s poll)
- Regime: captured at signal fire time
- broadResolved, secBias, shortTerm, midTerm: all from signal-time snapshot
- Scanner _score and confidence: from shortlist pull at 9:35

These are stored in `journal_context_snapshot` at signal fire → never recomputed from current scanner state.

---

## Open Items

| Item | Status |
|---|---|
| Per-setup condition templates | Open — defined after indicator testing phase |
| Condition alignment rules | Defined above for common conditions; setup-specific conditions added per setup |
| Import formats beyond TradingView/TTP | Open — add as needed |
| Chart data source (Yahoo vs Alpaca) | Yahoo for recent (<7d free), Alpaca for older (uses stored credentials) |
| Mobile / responsive UI | Design after desktop version confirmed |
