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
sys.argv = _ORIG_ARGV                        # restore the real command-line args

from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # noqa: E402
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


def _snapshot(symbol: str, tf: str, days: int, feed: str, view: str,
              overlays: list) -> dict:
    """Candles + indicator series for the requested window. Auto-extends the
    fetch window so every indicator has enough warm-up history."""
    days = dm.required_days(overlays, tf, days)
    return cs.compute_data(symbol=symbol.upper(), tf=tf, days=days,
                           overlays=overlays, feed=feed, view=view)


@app.get('/api/chart')
def chart(symbol: str = 'SPY', tf: str = '5m', days: int = 5,
          feed: str = 'polygon', view: str = 'all', overlays: str = '[]'):
    try:
        ovs = json.loads(overlays) if overlays else []
    except json.JSONDecodeError:
        ovs = []
    try:
        data = _snapshot(symbol, tf, days, feed, view, ovs)
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
    interval = max(5, int(cfg.get('interval', 20)))

    loop = asyncio.get_event_loop()
    last_bar_time = None
    try:
        while True:
            try:
                data = await loop.run_in_executor(
                    None, _snapshot, symbol, tf, days, feed, view, overlays)
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
