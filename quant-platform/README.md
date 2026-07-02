# Quant Platform

A validated, TradingView-parity library of market data primitives, indicators, and market-structure logic. Every function has exactly one job and every primitive is proven equivalent to TradingView bar-for-bar before anything depends on it.

Consumers (screener, backtester, live trader, chart, this repo's Trade Desk) never re-implement calculations. They import from here.

---

## Ground rules

1. **One responsibility per function.** No mixed concerns. `rolling_mean` doesn't know what "close" is.
2. **Never duplicate calculations.** If the capability exists, reuse it. Every layer only depends on layers below it.
3. **Validate before reuse.** Every primitive is compared against TradingView on multiple timeframes / lengths / symbols before other modules depend on it.
4. **Lock stable code.** Once a primitive is verified, do not touch it except to fix a confirmed defect. Verified primitives sit at the top of their module docstring: `# VERIFIED YYYY-MM-DD — do not edit without re-validation.`
5. **Separate concerns.** Data, math, indicators, primitives, strategies stay in independent layers.
6. **Test continuously.** Every primitive has unit tests. Every module has integration tests.
7. **Same library everywhere.** Screener, backtester, live trader, chart, Trade Desk consume the same functions. No downstream re-implementations.

---

## Layers (bottom-up dependency)

```
STAGE 1  Data Management Layer      qp.data
STAGE 2  Session Engine             qp.session
STAGE 3  Mathematical Foundation    qp.math_foundation   ← knows nothing about markets
STAGE 4  Price Foundation           qp.price
STAGE 5  Moving Average Library     qp.ma
STAGE 6  VWAP Library               qp.vwap
STAGE 7  Volatility Library         qp.volatility
STAGE 8  Level Library              qp.levels
STAGE 9  Market Structure           qp.structure
STAGE 10 Primitive Library          qp.primitives
STAGE 11 Indicator Combinations     qp.indicators
STAGE 12 Setup Library              qp.setups
STAGE 13 Screening Engine           qp.screening
STAGE 14 Chart Engine               qp.chart
STAGE 15 Validation Mode            qp.validation   ← side-by-side TradingView compare
STAGE 16 Backtest / Replay          qp.backtest
STAGE 17 Live Engine                qp.live
STAGE 18 Statistics Database        qp.stats
STAGE 19 AI Analysis                qp.ai
```

Anything in `qp.math_foundation` doesn't know that `close` exists. It works on any 1-D array. That's the whole reason you can `Slope(VWAP)`, `Slope(EMA)`, `Slope(BB middle)` with the same function.

---

## First-pass scope (this commit)

- **STAGE 1** Data Management — pluggable source adapters (Yahoo first), on-disk parquet cache, cleaning (missing bars, session filter, timezone normalisation).
- **STAGE 2** Session Engine — trading-hours logic for US equities (regular, premarket, after-hours). Extensible to other markets.
- **STAGE 3** Math Foundation — rolling operations + slope + linear regression + change/ROC/pct-change. Zero market knowledge.
- **STAGE 4** Price Foundation — HL2, HLC3, OHLC4, typical, median, weighted-close.
- **STAGE 5** Moving Averages — SMA, EMA (with tested TradingView parity). Rest of MAs (RMA, WMA, VWMA, HMA) sit next to these once validated.
- Test suite covering every primitive.
- One example validation script (`scripts/validate_ema.py`) that dumps calculated values + a CSV you can import to TradingView for side-by-side check.

Stages 6+ follow the same pattern in later commits.

---

## Install

```
pip install -r requirements.txt
```

## Run tests

```
pytest -q
```

## Consuming from the Trade Desk

The Trade Desk (Node) will consume this platform's output through one of two channels:

- **Batch export** (initial): per-symbol, per-day JSON / parquet dropped into a shared directory. Loaded on session start, merged into the `signal.indicators` extras the check evaluator consumes. Same key names (`ma5day`, `vwap_week`, `week_high`, …) as `dailyLevels.computeLevels` publishes today, so zero refactor on the Node side.
- **Live stream** (later): HTTP / WebSocket subscription.

See `qp/export/` for the exporter modules.

---

## What a "VERIFIED" primitive looks like

```python
# qp/ma/ema.py
#
# EMA — Exponential Moving Average
# VERIFIED 2026-07-02 vs TradingView:
#   SPY 5m EMA(9)   len 500 bars   max abs diff < 1e-8
#   SPY 1h EMA(20)  len 500 bars   max abs diff < 1e-8
#   AAPL 1D EMA(50) len 300 bars   max abs diff < 1e-8
# Do not edit without re-running scripts/validate_ema.py.

def ema(x, length):
    """Exponential moving average matching TradingView's ta.ema."""
    ...
```

Once a function carries the `VERIFIED` header it is trusted by every layer above it. Bug reports touching a verified primitive re-open validation, not spot-editing.
