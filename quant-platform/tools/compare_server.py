"""
Visual side-by-side: TradingView vs qp indicators.

Run on the server:
    cd ~/Tade-desk-server/quant-platform
    .venv/bin/python tools/compare_server.py --host 0.0.0.0 --port 8765

Then from your laptop, SSH-tunnel and open in a browser:
    ssh -L 8765:localhost:8765 ec2-user@<ec2-public-ip>
    open http://localhost:8765

Left pane: TradingView embed widget for the same symbol/timeframe.
Right pane: TradingView's lightweight-charts library rendering qp's
own bars + indicator series computed on the server. If the two lines
don't overlap, qp's math disagrees with TradingView.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qp.data import load
from qp.ma import ema, sma, rma, wma
from qp.vwap import session_vwap


PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>qp vs TradingView</title>
<script src="https://s3.tradingview.com/tv.js"></script>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<style>
  html, body { margin:0; padding:0; height:100%; background:#0e1116; color:#eee;
               font-family: system-ui, -apple-system, sans-serif; }
  #controls { padding: 8px 12px; display:flex; gap:10px; align-items:center;
              background:#1a1e26; border-bottom: 1px solid #2a2f3a; flex-wrap:wrap; }
  #controls label { font-size: 12px; color:#8a94a7; display:flex; align-items:center; gap:4px; }
  #controls input, #controls select {
    background:#0e1116; color:#eee; border:1px solid #2a2f3a; padding:4px 8px;
    border-radius:4px; font-size:13px;
  }
  #controls button { background:#2a6df4; color:#fff; border:0; padding:6px 14px;
                     border-radius:4px; cursor:pointer; font-size:13px; }
  #controls button:hover { background:#4380f7; }
  #status { margin-left: auto; color:#8fa; font-size:12px; }
  #main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 50px); }
  .pane { position: relative; border-right: 1px solid #2a2f3a; overflow: hidden; }
  .pane:last-child { border-right: 0; }
  .pane h3 { position:absolute; top:8px; left:14px; z-index:10; margin:0;
             font-size: 11px; letter-spacing:2px; color:#5fd8a3;
             text-shadow: 0 0 4px rgba(0,0,0,0.8); pointer-events:none; }
  #tv, #qp { width:100%; height:100%; }
</style></head>
<body>
<div id="controls">
  <label>Symbol <input id="symbol" value="SPY" size="6"></label>
  <label>TF
    <select id="tf">
      <option>1m</option><option>2m</option>
      <option selected>5m</option><option>15m</option><option>30m</option>
      <option>1h</option><option>1d</option>
    </select>
  </label>
  <label>Indicator
    <select id="ind">
      <option value="ema">EMA</option>
      <option value="sma">SMA</option>
      <option value="rma">RMA (Wilder)</option>
      <option value="wma">WMA</option>
      <option value="vwap">Session VWAP</option>
      <option value="none">— none —</option>
    </select>
  </label>
  <label>Length <input id="length" type="number" value="9" size="3" min="1" max="500"></label>
  <label>Days <input id="days" type="number" value="5" size="3" min="1" max="60"></label>
  <label>Session
    <select id="session">
      <option value="regular" selected>regular</option>
      <option value="extended">extended</option>
      <option value="all">all</option>
    </select>
  </label>
  <button onclick="reload()">Reload</button>
  <span id="status"></span>
</div>
<div id="main">
  <div class="pane"><h3>TRADINGVIEW</h3><div id="tv"></div></div>
  <div class="pane"><h3>QP</h3><div id="qp"></div></div>
</div>
<script>
  let qpChart = null, priceSeries = null, indSeries = null;

  const tvIntervalMap = {'1m':'1','2m':'2','5m':'5','15m':'15','30m':'30','1h':'60','1d':'D'};
  const tvStudyMap = {
    ema:  'MAExp@tv-basicstudies',
    sma:  'MASimple@tv-basicstudies',
    rma:  'MAExp@tv-basicstudies',   // Wilder — TV has no exact match, EMA is closest visual
    wma:  'MAWeighted@tv-basicstudies',
    vwap: 'VWAP@tv-basicstudies',
  };

  function makeTV(symbol, tf, ind) {
    document.getElementById('tv').innerHTML = '';
    const studies = ind !== 'none' && tvStudyMap[ind] ? [tvStudyMap[ind]] : [];
    new TradingView.widget({
      autosize: true,
      symbol: symbol,
      interval: tvIntervalMap[tf] || '5',
      timezone: 'America/New_York',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: '#0e1116',
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      studies: studies,
      container_id: 'tv',
    });
  }

  function makeQP() {
    const el = document.getElementById('qp');
    el.innerHTML = '';
    qpChart = LightweightCharts.createChart(el, {
      layout: { background: {color:'#0e1116'}, textColor:'#c8d0dc' },
      grid:   { vertLines:{color:'#171b23'}, horzLines:{color:'#171b23'} },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor:'#2a2f3a' },
      rightPriceScale: { borderColor:'#2a2f3a' },
      crosshair: { mode: 1 },
    });
    priceSeries = qpChart.addCandlestickSeries({
      upColor:'#4caf50', downColor:'#ef5350',
      borderUpColor:'#4caf50', borderDownColor:'#ef5350',
      wickUpColor:'#4caf50', wickDownColor:'#ef5350',
    });
    indSeries = qpChart.addLineSeries({ color:'#f5a623', lineWidth: 2 });
    new ResizeObserver(() => qpChart.resize(el.clientWidth, el.clientHeight)).observe(el);
  }

  async function loadData() {
    const symbol  = document.getElementById('symbol').value.trim().toUpperCase();
    const tf      = document.getElementById('tf').value;
    const ind     = document.getElementById('ind').value;
    const length  = document.getElementById('length').value;
    const days    = document.getElementById('days').value;
    const session = document.getElementById('session').value;
    document.getElementById('status').textContent = 'loading…';
    let r;
    try {
      r = await fetch(`/data?symbol=${encodeURIComponent(symbol)}&tf=${tf}&ind=${ind}` +
                      `&length=${length}&days=${days}&session=${session}`);
    } catch (e) {
      document.getElementById('status').textContent = 'network error: ' + e.message;
      return;
    }
    if (!r.ok) {
      const txt = await r.text();
      document.getElementById('status').textContent = 'error: ' + txt.slice(0, 200);
      return;
    }
    const j = await r.json();
    priceSeries.setData(j.bars);
    indSeries.setData(j.indicator || []);
    qpChart.timeScale().fitContent();
    document.getElementById('status').textContent =
      `${j.bars.length} bars · ${j.first || ''} → ${j.last || ''}`;
  }

  function reload() {
    const symbol = document.getElementById('symbol').value.trim().toUpperCase();
    const tf     = document.getElementById('tf').value;
    const ind    = document.getElementById('ind').value;
    makeTV(symbol, tf, ind);
    if (!qpChart) makeQP();
    loadData();
  }

  window.addEventListener('load', reload);
</script></body></html>
"""


def compute_series(symbol: str, tf: str, ind: str, length: int, days: int, session: str):
    end = pd.Timestamp.now(tz='UTC')
    start = end - pd.Timedelta(days=days)
    bars = load(
        symbol,
        timeframe=tf,
        start=start,
        end=end,
        source='yahoo',
        session=None if session == 'all' else session,
    )
    if len(bars) == 0:
        return {'bars': [], 'indicator': [], 'first': None, 'last': None}

    df = bars.df
    ts = (df.index.view('int64') // 1_000_000_000).tolist()
    bar_list = [
        {'time': int(t), 'open': float(o), 'high': float(h),
         'low': float(l), 'close': float(c)}
        for t, o, h, l, c in zip(ts, df['open'], df['high'], df['low'], df['close'])
    ]

    if ind == 'ema':
        y = ema(df['close'].to_numpy(), length)
    elif ind == 'sma':
        y = sma(df['close'].to_numpy(), length)
    elif ind == 'rma':
        y = rma(df['close'].to_numpy(), length)
    elif ind == 'wma':
        y = wma(df['close'].to_numpy(), length)
    elif ind == 'vwap':
        y = session_vwap(df).to_numpy()
    elif ind == 'none':
        y = None
    else:
        raise ValueError(f'unknown indicator {ind!r}')

    ind_list = []
    if y is not None:
        for t, v in zip(ts, y):
            fv = float(v)
            if fv == fv:  # skip NaN
                ind_list.append({'time': int(t), 'value': fv})

    return {
        'bars': bar_list,
        'indicator': ind_list,
        'first': df.index[0].strftime('%Y-%m-%d %H:%M'),
        'last':  df.index[-1].strftime('%Y-%m-%d %H:%M'),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, content_type='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ('/', '/index.html'):
            self._send(200, PAGE.encode('utf-8'), 'text/html; charset=utf-8')
            return
        if u.path == '/data':
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                data = compute_series(
                    symbol=q.get('symbol', 'SPY'),
                    tf=q.get('tf', '5m'),
                    ind=q.get('ind', 'ema'),
                    length=int(q.get('length', 9)),
                    days=int(q.get('days', 5)),
                    session=q.get('session', 'regular'),
                )
                self._send(200, json.dumps(data).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        self._send(404, b'not found', 'text/plain')

    def log_message(self, fmt, *args):
        sys.stderr.write(f'[compare] {fmt % args}\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='127.0.0.1',
                   help='bind address; use 0.0.0.0 to expose (behind a firewall)')
    p.add_argument('--port', type=int, default=8765)
    args = p.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'qp compare UI listening on http://{args.host}:{args.port}')
    print('  from your laptop, SSH-tunnel:  '
          f'ssh -L {args.port}:localhost:{args.port} ec2-user@<ec2-ip>')
    print(f'  then open:  http://localhost:{args.port}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
