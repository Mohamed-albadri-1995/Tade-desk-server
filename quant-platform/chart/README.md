# qp charting platform — Phase 1 (real-time chart)

A broker-style live candlestick chart backed entirely by the verified `qp`
library. Every indicator you draw is the *same* verified primitive the
compare tool approved and the trading tool runs — one source of truth.

This is **Phase 1** of the platform plan (Core Infrastructure & Real-Time
Charting). Later phases add the primitive builder, visual strategy builder,
screener navigation, and the backtest engine.

## What Phase 1 gives you

- Full-width candlestick chart (lightweight-charts), no TradingView panel.
- Timeframes 1m/5m/15m/30m/1h/1d; session toggle Regular / All-day.
- Add any of the 60+ qp indicators from the picker — length + source +
  colour; price overlays draw on the candles, oscillators (RSI, RVOL, ATR)
  drop into a bottom pane automatically.
- Step-rendered levels/S-R, verification markers, ET-correct time axis,
  session background bands.
- **Auto warm-up**: the Data Manager extends the fetch window so every
  indicator has enough history (no manual data juggling).
- **Live mode**: a WebSocket re-computes on an interval and pushes the tail,
  so the newest candle and indicator tips move in real time.

## Run

```sh
cd ~/Tade-desk-server/quant-platform
pip install -r requirements.txt      # adds fastapi / uvicorn / websockets

export APCA_API_KEY_ID=...            # or put them in .env (auto-loaded)
export APCA_API_SECRET_KEY=...
export POLYGON_API_KEY=...

python3 -m chart.server --host 0.0.0.0 --port 8766
# or:  uvicorn chart.server:app --host 0.0.0.0 --port 8766
```

Open `http://<host>:8766`. Requires port 8766 open in the EC2 security group.

### Live data note

Polygon's free tier is end-of-day delayed, so **Live** only *moves* on the
**alpaca** or **hybrid** feed (the UI warns you when Live is on + Polygon).
Use polygon for deep history / prior-day analysis, alpaca/hybrid for live.

## Endpoints

```
GET  /                 the chart page
GET  /api/health       {ok, build, primitives, feeds, default_feed}
GET  /api/primitives   registry + approval status (the indicator picker)
GET  /api/chart        candles + indicator series (JSON snapshot)
WS   /ws/live          pushes {type:'tick', bar, tips} on an interval
```

## Architecture

- `chart/server.py` — FastAPI app. Reuses `tools.compare_server.compute_data`
  (the proven candles + overlay + pane + marker engine) for snapshots and
  adds the live WebSocket.
- `chart/data_manager.py` — wraps the `tools/data` loaders (alpaca / polygon
  / hybrid), computes required warm-up history per indicator, serves the live
  tail.
- `chart/static/index.html` — the frontend (lightweight-charts, pinned v4.2.3
  vendored under `chart/static/`).

All indicator math comes from `qp` — nothing is re-implemented here.
