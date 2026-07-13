"""
Real-Time Quantitative Trading Platform — Phase 1: charting server.

FastAPI app (port 8766) that serves a broker-style live candlestick chart
backed entirely by the verified qp library. Reuses the compare tool's proven
compute engine (candles + overlays + oscillator panes + session bands + step
lines + markers + warm-up) via tools.compare_server.compute_data, and adds:

  GET  /                     the chart page
  GET  /api/health           {ok, build, primitives, feeds, default_feed}
  GET  /api/primitives       full registry + approval status (for the picker)
  GET  /api/chart            snapshot: candles + indicator series (JSON)
  WS   /ws/live              pushes the updated tail every few seconds so the
                             last candle + indicators move in real time

Run:  uvicorn chart.server:app --host 0.0.0.0 --port 8766
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

# qp + the shared compute engine
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))
# compare_server imports qp at load; keep argv clean during that import, then
# RESTORE it so our own --host/--port parser in main() still sees the flags.
_ORIG_ARGV = list(sys.argv)
sys.argv = sys.argv[:1]
import tools.compare_server as cs            # noqa: E402  compute_data, list_primitives, _feed_status, _BUILD
from chart import data_manager as dm         # noqa: E402
from chart import screener as sc             # noqa: E402  Phase 2 register bridge
from chart import strategy as strat          # noqa: E402  Phase 3 strategy engine
from chart import store                      # noqa: E402  Phase 3 strategy storage
sys.argv = _ORIG_ARGV                        # restore the real command-line args

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

_STATIC = Path(__file__).resolve().parent / 'static'

app = FastAPI(title='qp charting platform')
app.mount('/static', StaticFiles(directory=str(_STATIC)), name='static')


@app.get('/', response_class=HTMLResponse)
def index():
    return (_STATIC / 'index.html').read_text()


@app.get('/api/health')
def health():
    return {'ok': True, 'build': cs._BUILD, 'primitives': len(cs.REGISTRY),
            **cs._feed_status()}


@app.get('/api/primitives')
def primitives():
    return cs.list_primitives()


# ── Phase 2: screener register navigation ──────────────────────────────────
@app.get('/api/screener/health')
def screener_health():
    return {'registers': sc.REGISTERS, **sc.health()}


@app.get('/api/screener/dates')
def screener_dates(register: str = 'R1'):
    return {'register': register, 'dates': sc.available_dates(register)}


@app.get('/api/screener/register')
def screener_register(register: str = 'R1', date: str = ''):
    """Compact ticker cards for a register on a date (default latest)."""
    return JSONResponse(sc.register_rows(register, date or None))


# ── Phase 3: strategy builder + signal evaluation ──────────────────────────
@app.get('/api/strategies')
def strategies_list():
    return {'ok': True, 'strategies': store.list_strategies()}


@app.post('/api/strategies')
def strategies_save(payload: dict = Body(...)):
    try:
        return {'ok': True, 'strategy': store.save_strategy(payload)}
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


@app.get('/api/strategies/{sid}')
def strategies_get(sid: int):
    """Single strategy by id — the exact stored JSON. This is the bridge the
    backtester and the trading tool pull from, so all three run the SAME
    document through the SAME evaluator (no conversion step to introduce
    errors)."""
    s = store.get_strategy(sid)
    return {'ok': bool(s), 'strategy': s}


@app.delete('/api/strategies/{sid}')
def strategies_delete(sid: int):
    return {'ok': store.delete_strategy(sid)}


@app.post('/api/strategy/test')
def strategy_test(payload: dict = Body(...)):
    """Evaluate a single condition (rule or group) and mark every bar it holds
    — for validating a condition before composing. Body: {node, symbol, tf,
    days, feed, view, asof}."""
    try:
        out = strat.test_condition(
            payload.get('node') or {},
            symbol=str(payload.get('symbol', 'SPY')).upper(),
            tf=payload.get('tf', '5m'), days=int(payload.get('days', 5)),
            feed=payload.get('feed', 'polygon'), view=payload.get('view', 'all'),
            asof=payload.get('asof') or None)
        return JSONResponse(out)
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


@app.post('/api/strategy/evaluate')
def strategy_evaluate(payload: dict = Body(...)):
    """Evaluate a strategy over a chart window → signal markers + preview
    stats. Body: {strategy, symbol, tf, days, feed, view, asof}."""
    try:
        s = payload.get('strategy') or {}
        out = strat.evaluate(
            s,
            symbol=str(payload.get('symbol', 'SPY')).upper(),
            tf=payload.get('tf', '5m'),
            days=int(payload.get('days', 5)),
            feed=payload.get('feed', 'polygon'),
            view=payload.get('view', 'all'),
            asof=payload.get('asof') or None,
        )
        return JSONResponse(out)
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


def _snapshot(symbol: str, tf: str, days: int, feed: str, view: str,
              overlays: list, asof: str | None = None) -> dict:
    """Candles + indicator series for the requested window. Auto-extends the
    fetch window so every indicator has enough warm-up history. `asof`
    (YYYY-MM-DD) replays the stock as of a historical register date."""
    days = dm.required_days(overlays, tf, days)
    return cs.compute_data(symbol=symbol.upper(), tf=tf, days=days,
                           overlays=overlays, feed=feed, view=view,
                           asof=asof or None)


@app.get('/api/chart')
def chart(symbol: str = 'SPY', tf: str = '5m', days: int = 5,
          feed: str = 'polygon', view: str = 'all', overlays: str = '[]',
          asof: str = ''):
    try:
        ovs = json.loads(overlays) if overlays else []
    except json.JSONDecodeError:
        ovs = []
    try:
        data = _snapshot(symbol, tf, days, feed, view, ovs, asof)
        data['ok'] = True
        return JSONResponse(data)
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


@app.websocket('/ws/live')
async def ws_live(ws: WebSocket):
    """Client sends the current chart request once; the server re-computes the
    snapshot on an interval and pushes only the TAIL (last bar + last value of
    each indicator) so the newest candle updates live. Polygon-free is EOD
    delayed, so live movement needs the alpaca/hybrid feed."""
    await ws.accept()
    try:
        cfg = json.loads(await ws.receive_text())
    except Exception:
        await ws.close()
        return
    symbol = cfg.get('symbol', 'SPY')
    tf = cfg.get('tf', '5m')
    days = int(cfg.get('days', 5))
    feed = cfg.get('feed', 'polygon')
    view = cfg.get('view', 'all')
    overlays = cfg.get('overlays', [])
    asof = cfg.get('asof') or None
    interval = max(5, int(cfg.get('interval', 20)))

    loop = asyncio.get_event_loop()
    last_bar_time = None
    try:
        while True:
            try:
                data = await loop.run_in_executor(
                    None, _snapshot, symbol, tf, days, feed, view, overlays, asof)
                bars = data.get('bars') or []
                if bars:
                    tail = bars[-1]
                    # last value of each overlay series (for the moving line tip)
                    tips = []
                    for s in data.get('series') or []:
                        vals = s.get('values') or []
                        if vals:
                            tips.append({'name': s['name'], 'color': s.get('color'),
                                         'time': vals[-1]['time'], 'value': vals[-1]['value']})
                    await ws.send_text(json.dumps({
                        'type': 'tick', 'bar': tail, 'tips': tips,
                        'new_bar': tail['time'] != last_bar_time,
                    }))
                    last_bar_time = tail['time']
            except Exception as e:
                await ws.send_text(json.dumps({'type': 'error', 'error': str(e)}))
            await asyncio.sleep(interval)
    except WebSocketDisconnect:
        return
    except Exception:
        return


def main():
    import argparse
    import uvicorn
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='0.0.0.0')
    p.add_argument('--port', type=int, default=8766)
    args = p.parse_args()
    print(f'qp charting platform on http://{args.host}:{args.port} — '
          f'build {cs._BUILD} — {len(cs.REGISTRY)} primitives')
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
