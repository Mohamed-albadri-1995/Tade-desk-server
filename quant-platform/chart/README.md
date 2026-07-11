# qp charting platform — Phases 1–2

A broker-style live candlestick chart backed entirely by the verified `qp`
library. Every indicator you draw is the *same* verified primitive the
compare tool approved and the trading tool runs — one source of truth.

**Phase 1** (Core Infrastructure & Real-Time Charting) is the live chart.
**Phase 2** (Screener Integration & Navigation) wires the chart to the Node
screener's frozen **R1** and **Shortlist** registers so you can browse every
stock the scanner flagged on any past date and replay its chart exactly as it
stood that day. Later phases add the primitive/strategy builders and the
backtest engine (which reuses the same register bridge, day by day).

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

### Run it permanently (systemd)

So the chart auto-starts on boot and auto-restarts if it crashes (instead of a
`nohup` that dies on reboot), install it as a service — one time:

```sh
cd ~/Tade-desk-server/quant-platform
bash chart/deploy/install-service.sh            # default port 8765
# PORT=8766 bash chart/deploy/install-service.sh # to pick a port
```

After that: `sudo systemctl restart qp-chart` (e.g. after a `git pull`),
`systemctl status qp-chart`, logs at `~/chart.log` or `journalctl -u qp-chart`.
The unit sets `MemoryHigh` so on a small host the chart is throttled to swap
before it can starve the screener.

### Live data note

Polygon's free tier is end-of-day delayed, so **Live** only *moves* on the
**alpaca** or **hybrid** feed (the UI warns you when Live is on + Polygon).
Use polygon for deep history / prior-day analysis, alpaca/hybrid for live.

## Screener navigation (Phase 2)

The side panel's **Screener register** browser lists the stocks on the
scanner's R1 (or Shortlist) register for a chosen date, each as a card with
score / regime / sector / gap% / rvol. Click a card → the chart loads that
ticker **as of that register date** (via `asof`), so you review the setup as
it actually looked that morning. The header **As-of** field does the same by
hand (blank = live/now); setting it disables Live (a past day isn't live).

The chart reads the registers over the screener's own HTTP API — point it at
the screener with `SCREENER_URL` (default `http://localhost:3000`, i.e. the
same box). If the screener is down the browser just shows a note; the chart
still works.

## Endpoints

```
GET  /                        the chart page
GET  /api/health              {ok, build, primitives, feeds, default_feed}
GET  /api/primitives          registry + approval status (the indicator picker)
GET  /api/chart               candles + indicator series (JSON snapshot)
                              ?asof=YYYY-MM-DD replays a historical date
WS   /ws/live                 pushes {type:'tick', bar, tips} on an interval
GET  /api/screener/health     is the screener reachable
GET  /api/screener/dates      ?register=R1|Shortlist → available dates
GET  /api/screener/register   ?register=&date= → ticker cards (score, regime, …)
```

## Architecture

- `chart/server.py` — FastAPI app. Reuses `tools.compare_server.compute_data`
  (the proven candles + overlay + pane + marker engine) for snapshots and
  adds the live WebSocket + the screener-register endpoints.
- `chart/data_manager.py` — wraps the `tools/data` loaders (alpaca / polygon
  / hybrid), computes required warm-up history per indicator, serves the live
  tail.
- `chart/screener.py` — reads the Node screener's frozen R1 / Shortlist
  registers (stdlib HTTP, `SCREENER_URL`) and maps each row to a compact card.
- `chart/static/index.html` — the frontend (lightweight-charts, pinned v4.2.3
  vendored under `chart/static/`).

All indicator math comes from `qp` — nothing is re-implemented here.
