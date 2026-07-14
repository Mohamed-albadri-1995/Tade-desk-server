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


# ── Phase 4: backtests ──────────────────────────────────────────────────────
import threading as _threading
_BT_RUNNING: dict = {'id': None}
_BT_START_LOCK = _threading.Lock()     # closes the double-POST race window


@app.post('/api/backtest')
def backtest_start(payload: dict = Body(...)):
    """Start a backtest in a background thread. One at a time (small box) —
    the check-and-create is under a lock so two simultaneous POSTs can't both
    pass the 'already running' check. Body = spec: {name, strategy|strategy_id,
    universe, start, end, tf, feed, view, fill, days}. Returns {ok, id}
    immediately; poll GET /api/backtest/{id}."""
    import threading
    from chart import backtest as bt
    try:
        with _BT_START_LOCK:
            cur = _BT_RUNNING.get('id')
            if cur is not None:
                g = store.get_backtest(cur, with_trades=False)
                if g and g['status'] == 'running':
                    return JSONResponse({'ok': False,
                                         'error': f'backtest #{cur} is still running'},
                                        status_code=200)
            bt._pairs(payload)                 # validate spec BEFORE creating a row
            bt._resolve_strategy(payload)
            bid = store.create_backtest(payload.get('name') or 'Backtest', payload)
            _BT_RUNNING['id'] = bid
        t = threading.Thread(target=bt.run_and_store, args=(bid, payload), daemon=True)
        t.start()
        return {'ok': True, 'id': bid}
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


@app.get('/api/backtest/{bid}')
def backtest_get(bid: int, trades: int = 1):
    g = store.get_backtest(bid, with_trades=bool(trades))
    return JSONResponse({'ok': bool(g), 'backtest': g})


@app.get('/api/backtests')
def backtests_list():
    return {'ok': True, 'backtests': store.list_backtests()}


@app.get('/api/backtest/{bid}/csv')
def backtest_csv(bid: int):
    """Full results as CSV — trade fields + every register (R1/Shortlist)
    column flattened as ctx_<field>, so any spreadsheet can slice it."""
    from fastapi.responses import PlainTextResponse
    import csv
    import io
    g = store.get_backtest(bid)
    if not g:
        return JSONResponse({'ok': False, 'error': 'not found'}, status_code=200)
    trades = g.get('trades') or []
    ctx_keys = sorted({k for t in trades for k in (t.get('ctx') or {})})
    base = ['date', 'symbol', 'side', 'entry_ts', 'exit_ts', 'entry', 'exit',
            'ret_pct', 'pnl_ps', 'reason']
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(base + [f'ctx_{k}' for k in ctx_keys])
    for t in trades:
        c = t.get('ctx') or {}
        sgn = 1.0 if t['side'] == 'long' else -1.0
        pps = (round(sgn * (t['exit'] - t['entry']), 4)
               if t.get('exit') is not None else '')
        w.writerow([t['date'], t['symbol'], t['side'], t['entry_ts'], t['exit_ts'],
                    t['entry'], t['exit'],
                    round(t['ret'] * 100, 4) if t.get('ret') is not None else '',
                    pps, t['reason']] + [c.get(k, '') for k in ctx_keys])
    return PlainTextResponse(buf.getvalue(), media_type='text/csv', headers={
        'Content-Disposition': f'attachment; filename="backtest_{bid}.csv"'})


def _ttp_html(s: dict) -> str:
    t = (s or {}).get('ttp')
    if not t:
        return ''
    return f"""<div class="grid">
<div class="kpi"><b>${t['net_pnl_usd']}</b><span>net P&amp;L @ {t['shares']:.0f} shares (after ${t['fees_usd']} fees)</span></div>
<div class="kpi"><b>${t['counted_pnl_usd']}</b><span>COUNTED P&amp;L — wins &lt; ${t['min_profit_ps']}/share credit 0 (losses always count)</span></div>
<div class="kpi"><b>{t['wins_below_min']}</b><span>wins below the ${t['min_profit_ps']}/share minimum (wasted wins)</span></div>
<div class="kpi"><b>${t['fee_per_share']}/sh, min ${t['fee_min_per_order']}</b><span>commission per order side</span></div>
</div>"""


@app.get('/api/backtest/{bid}/report')
def backtest_report(bid: int):
    """Self-contained phone-readable HTML report: clear metric definitions,
    bias disclosure (fill model, costs, universe), and the trade list."""
    from fastapi.responses import HTMLResponse
    g = store.get_backtest(bid)
    if not g:
        return HTMLResponse('<h3>backtest not found</h3>')
    s = g.get('summary') or {}
    spec = g.get('spec') or {}
    uni = spec.get('universe') or {}
    uni_txt = (', '.join(uni.get('symbols') or []) if uni.get('kind') == 'symbols'
               else f"register {uni.get('register', 'R1')} (frozen per day — survivorship-bias-free)")
    warn = []
    if not spec.get('cost_bps'):
        warn.append('costs = 0 bps (frictionless — real results will be worse)')
    if spec.get('fill', 'close') == 'close':
        warn.append("fill = close (optimistic; use 'next open' for live-honest fills)")
    cov = s.get('coverage') or {}
    if cov.get('no_data'):
        warn.append(f"{cov['no_data']} of {cov.get('pairs')} day·symbol pairs returned "
                    f"NO bars on feed '{cov.get('feed')}' — the universe was only "
                    f"PARTIALLY evaluated (alpaca/IEX carries no data for many small "
                    f"caps; rerun on polygon)")
    rows = ''.join(
        f"<tr><td>{t['date']}</td><td><b>{t['symbol']}</b></td><td>{t['side']}</td>"
        f"<td>{t['entry']:.2f}→{('%.2f' % t['exit']) if t.get('exit') is not None else 'open'}</td>"
        f"<td class='{'up' if (t.get('ret') or 0) > 0 else 'dn'}'>"
        f"{(t['ret'] * 100):+.2f}%</td><td>{t['reason']}</td></tr>"
        for t in (g.get('trades') or []))
    m = (lambda k, d='—': s.get(k) if s.get(k) is not None else d)
    html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backtest #{bid} — {g.get('name', '')}</title><style>
body{{background:#0e1116;color:#e2e8f0;font-family:-apple-system,'Segoe UI',sans-serif;margin:0;padding:14px}}
h2{{margin:0 0 4px}} .muted{{color:#64748b;font-size:12px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:12px 0}}
.kpi{{background:#151a24;border:1px solid #1e2632;border-radius:8px;padding:10px}}
.kpi b{{font-size:19px;display:block}} .kpi span{{color:#94a3b8;font-size:11px}}
table{{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:10px}}
td,th{{padding:6px 6px;border-bottom:1px solid #1e2632;text-align:left;white-space:nowrap}}
.up{{color:#22c55e}} .dn{{color:#ef5350}} .warn{{color:#f5a623;font-size:12px;margin:8px 0}}
.defs{{color:#64748b;font-size:11px;line-height:1.6;margin-top:14px}}
.wrap{{overflow-x:auto}}</style></head><body>
<h2>Backtest #{bid} — {g.get('name', '')}</h2>
<div class="muted">{spec.get('start')} → {spec.get('end')} · {cov.get('tf') or spec.get('tf')} ·
feed: {cov.get('feed') or spec.get('feed') or '?'} · {uni_txt} ·
fill: {spec.get('fill', 'close')} · cost: {spec.get('cost_bps', 0)} bps/side ·
rules: {('RTH entries + EOD 15:50 close' if (spec.get('rules') or {}).get('eod_close') else 'none')} · status: {g.get('status')}</div>
{('<div class="warn">⚠ ' + ' · '.join(warn) + '</div>') if warn else ''}
{('<div class="warn">⚠ ' + str(s.get('errors')) + ' day·symbol pairs skipped (no data / feed error):<br>'
  + '<br>'.join('· ' + str(x)[:120] for x in (s.get('error_samples') or [])[:5]) + '</div>')
 if s.get('errors') else ''}
<div class="grid">
<div class="kpi"><b>{m('trades')}</b><span>closed trades ({m('open_trades', 0)} open)</span></div>
<div class="kpi"><b>{m('win_rate')}%</b><span>win rate (closed trades with return &gt; 0)</span></div>
<div class="kpi"><b>{m('total_return_pct')}%</b><span>total return (sum of per-trade %, unit size)</span></div>
<div class="kpi"><b>{m('avg_return_pct')}%</b><span>average per trade</span></div>
<div class="kpi"><b>{m('sharpe')}</b><span>Sharpe (daily returns ×√252, flat days included)</span></div>
<div class="kpi"><b>{m('max_drawdown_pct')}%</b><span>max drawdown depth</span></div>
<div class="kpi"><b>{m('max_dd_days')}</b><span>max drawdown duration (days below prior peak)</span></div>
<div class="kpi"><b>{m('pairs')}</b><span>day·symbol pairs in the universe ({m('errors', 0)} errors)</span></div>
{(f'''<div class="kpi"><b>{cov.get('evaluated')}/{cov.get('pairs')}</b><span>pairs with data ({cov.get('no_data', 0)} returned no bars)</span></div>
<div class="kpi"><b>{cov.get('signals_on_day', 0)}</b><span>entry signals on {cov.get('signal_pairs', 0)} pairs → {cov.get('traded_pairs', 0)} traded</span></div>''') if cov else ''}
</div>
{_ttp_html(s)}
<div class="wrap"><table><tr><th>date</th><th>sym</th><th>side</th><th>entry→exit</th><th>ret</th><th>why</th></tr>
{rows}</table></div>
<div class="defs"><b>How to read this honestly:</b><br>
· Every trade uses the exact strategy JSON + verified qp math the chart draws — no re-implementation.<br>
· Only trades ENTERED on each evaluated day count (no warm-up leakage, no look-ahead).<br>
· Register universes are frozen as-of each morning → no survivorship bias. Symbol lists carry whatever bias you typed.<br>
· 'open' rows were still holding at the day window's end — excluded from win rate.<br>
· Returns are per-unit-position %; position sizing/compounding belongs to the trading tool.</div>
</body></html>"""
    return HTMLResponse(html)


@app.delete('/api/backtest/{bid}')
def backtest_delete(bid: int):
    g = store.get_backtest(bid, with_trades=False)
    if g and g['status'] == 'running':
        return JSONResponse({'ok': False, 'error': 'still running'}, status_code=200)
    return {'ok': store.delete_backtest(bid)}


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
            fill=payload.get('fill', 'close'),
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
    out = cs.compute_data(symbol=symbol.upper(), tf=tf, days=days,
                          overlays=overlays, feed=feed, view=view,
                          asof=asof or None)
    # NEVER silently under-warm an indicator: Alpaca's 1m feed is capped to a
    # 7-day window inside prepare_bars, so anything needing more history
    # (month VWAP, weekly levels, 5-day MA) is computed on a truncated window.
    if tf == '1m' and feed == 'alpaca' and days > 7:
        out['warn'] = (f'alpaca 1m is capped to a 7-day window but these '
                       f'overlays need ~{days} days of warm-up — multi-day '
                       f'VWAPs/levels are UNRELIABLE here. Use the polygon '
                       f'feed (or a coarser TF) for them.')
    return out


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
