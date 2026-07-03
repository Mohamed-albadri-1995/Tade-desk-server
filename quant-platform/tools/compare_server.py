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


# Disk cache so we don't thrash Yahoo (which rate-limits AWS IPs).
CACHE_DIR = Path.home() / '.qp-cache'

# Where to look for user-supplied CSV data files. Set via --csv-dir.
CSV_DIR: Path = Path(__file__).resolve().parents[1] / 'data' / 'csv'


def list_csv_files() -> list[dict]:
    """Return metadata for every CSV under CSV_DIR (name, span, rows)."""
    if not CSV_DIR.exists():
        return []
    out = []
    for path in sorted(CSV_DIR.glob('*.csv')):
        try:
            df = pd.read_csv(path, usecols=['time'])
        except Exception:
            continue
        if len(df) == 0:
            continue
        ts_col = df['time']
        if pd.api.types.is_numeric_dtype(ts_col):
            first = pd.to_datetime(ts_col.iloc[0], unit='s', utc=True)
            last  = pd.to_datetime(ts_col.iloc[-1], unit='s', utc=True)
        else:
            first = pd.to_datetime(ts_col.iloc[0], utc=True)
            last  = pd.to_datetime(ts_col.iloc[-1], utc=True)
        out.append({
            'name': path.name,
            'first': first.isoformat(),
            'last':  last.isoformat(),
            'rows':  int(len(df)),
        })
    return out


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

  /* Live readout — the box that makes side-by-side comparison actually usable */
  #readout {
    position: absolute; top: 8px; right: 14px; z-index: 10;
    background: rgba(20, 24, 32, 0.92); border: 1px solid #2a3f5a;
    border-radius: 6px; padding: 8px 12px; font-family: ui-monospace, Menlo, monospace;
    font-size: 12px; color: #eee; min-width: 200px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  #readout .row { display: flex; justify-content: space-between; gap: 12px; padding: 1px 0; }
  #readout .k { color: #8a94a7; }
  #readout .v { color: #f5a623; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  #readout .v.close { color: #7ec7ff; }
  #readout .v.time { color: #b0f0c0; font-weight: 500; }
  #readout .hint { color: #4d5566; font-size: 10px; text-align: center;
                   margin-top: 4px; padding-top: 4px; border-top: 1px solid #2a2f3a; }
  #readout .tvinp {
    background: #0e1116; color: #7ec7ff; border: 1px solid #2a3f5a; border-radius: 3px;
    padding: 1px 6px; width: 90px; text-align: right; font-family: inherit;
    font-size: 12px; font-variant-numeric: tabular-nums;
  }
  #readout .tvinp:focus { outline: 1px solid #4380f7; }
  #readout .v.match  { color: #5fd8a3; }
  #readout .v.miss   { color: #ff7a7a; }
</style></head>
<body>
<div id="controls">
  <label>Data
    <select id="source" onchange="onSourceChange()">
      <option value="yahoo" selected>Yahoo (live)</option>
      <!-- CSV options injected on load from /sources -->
    </select>
  </label>
  <label>Symbol <input id="symbol" value="SPY" size="10"></label>
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
  <div class="pane"><h3>TRADINGVIEW · ET</h3><div id="tv"></div></div>
  <div class="pane">
    <h3>QP · ET</h3>
    <div id="readout">
      <div class="row"><span class="k">Time&nbsp;(ET)</span><span class="v time" id="rTime">—</span></div>
      <div class="row"><span class="k">Close</span><span class="v close" id="rClose">—</span></div>
      <div class="row"><span class="k" id="rIndK">qp indicator</span><span class="v" id="rInd">—</span></div>
      <div class="row">
        <span class="k">TV value</span>
        <input class="tvinp" id="rTv" type="number" step="0.0001" placeholder="type TV's #">
      </div>
      <div class="row"><span class="k">Diff (qp − TV)</span><span class="v" id="rDiff">—</span></div>
      <div class="hint">hover qp at a time · read TV at same time · type it here</div>
    </div>
    <div id="qp"></div>
  </div>
</div>
<script>
  // ------------------ Timezone helpers (force both charts to ET) ---------------
  const ET = 'America/New_York';

  function fmtET(unixSec, opts) {
    return new Date(unixSec * 1000).toLocaleString('en-US',
      Object.assign({ timeZone: ET, hour12: false }, opts));
  }
  function fmtTickTime(unixSec) {
    return fmtET(unixSec, { hour: '2-digit', minute: '2-digit' });
  }
  function fmtCrosshairTime(unixSec) {
    return fmtET(unixSec, {
      month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  }

  // ------------------ State --------------------------------------------------
  let qpChart = null, priceSeries = null, indSeries = null;
  let tvWidget = null;
  let currentBars = [];
  let currentInd  = [];
  let indByTime   = new Map();
  let closeByTime = new Map();
  let currentIndName = 'EMA';
  let csvMeta = {};   // filename -> {first, last, rows}

  // ------------------ Sources dropdown --------------------------------------
  // Guess a TradingView symbol from a CSV filename.
  // e.g. "CME_MINI_ES1_5m.csv" -> "CME_MINI:ES1!"
  //      "NASDAQ_AAPL_1h.csv"  -> "NASDAQ:AAPL"
  function guessTVSymbol(name) {
    let stem = name.replace(/\.csv$/i, '');
    // Strip trailing timeframe hint like _5m, -1h, .30m.
    stem = stem.replace(/[_\-\.](1|2|5|15|30|60)m$/i, '')
               .replace(/[_\-\.]1h$/i, '')
               .replace(/[_\-\.]1d$/i, '')
               .replace(/[_\-\.](1h|4h|1d|1w)$/i, '');
    const parts = stem.split(/[_\-]/);
    if (parts.length < 2) return stem;
    // Two-part exchange prefixes like CME_MINI, NASDAQ_NMS, OANDA_FX.
    let exchange, ticker;
    if (parts.length >= 3 && /^(MINI|NMS|DL|FX|IDC)$/i.test(parts[1])) {
      exchange = parts[0] + '_' + parts[1];
      ticker = parts.slice(2).join('_');
    } else {
      exchange = parts[0];
      ticker = parts.slice(1).join('_');
    }
    // Continuous-contract markers (1!, 2!) come through as "ES1" — put the !
    // back if the ticker ends with a digit and looks like a futures root.
    if (/[A-Z]{1,3}\d$/i.test(ticker)) ticker += '!';
    return `${exchange.toUpperCase()}:${ticker.toUpperCase()}`;
  }

  async function loadSources() {
    try {
      const r = await fetch('/sources');
      if (!r.ok) return;
      const list = await r.json();
      const sel = document.getElementById('source');
      for (const f of list) {
        csvMeta[f.name] = f;
        const opt = document.createElement('option');
        opt.value = 'csv:' + f.name;
        opt.textContent = `CSV · ${f.name}`;
        sel.appendChild(opt);
      }
    } catch (_) {}
  }

  function onSourceChange() {
    const v = document.getElementById('source').value;
    if (v.startsWith('csv:')) {
      const name = v.slice(4);
      const guessed = guessTVSymbol(name);
      document.getElementById('symbol').value = guessed;
    } else {
      document.getElementById('symbol').value = 'SPY';
    }
  }

  const tvIntervalMap = {'1m':'1','2m':'2','5m':'5','15m':'15','30m':'30','1h':'60','1d':'D'};
  const tvStudyMap = {
    ema:  'MAExp@tv-basicstudies',
    sma:  'MASimple@tv-basicstudies',
    rma:  'MASmoothed@tv-basicstudies',   // Wilder / SMMA — same as Pine ta.rma()
    wma:  'MAWeighted@tv-basicstudies',
    vwap: 'VWAP@tv-basicstudies',
  };
  const indLabelMap = { ema:'EMA', sma:'SMA', rma:'RMA', wma:'WMA', vwap:'VWAP' };

  // ------------------ TradingView pane --------------------------------------
  function makeTV(symbol, tf, ind) {
    document.getElementById('tv').innerHTML = '';
    tvRangeSubscribed = false;  // widget instance replaced; resubscribe below
    const studies = ind !== 'none' && tvStudyMap[ind] ? [tvStudyMap[ind]] : [];
    tvWidget = new TradingView.widget({
      autosize: true,
      symbol: symbol,
      interval: tvIntervalMap[tf] || '5',
      timezone: ET,
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

  // Initial range push (qp → TV) and subscribe TV → qp so panning /
  // zooming TradingView drags qp's visible range to match. The public
  // widget doesn't expose crosshair events, but onVisibleRangeChanged
  // fires reliably on user interaction.
  let tvRangeSubscribed = false;
  function syncTVRange() {
    if (!tvWidget) return;
    try {
      if (!tvWidget.onChartReady) return;
      tvWidget.onChartReady(() => {
        try {
          const chart = tvWidget.activeChart();
          if (currentBars.length > 0) {
            const from = currentBars[0].time;
            const to   = currentBars[currentBars.length - 1].time;
            try {
              chart.setVisibleRange({ from, to }, { applyDefaultRightMargin: false });
            } catch (_) {}
          }
          if (!tvRangeSubscribed && chart.onVisibleRangeChanged) {
            chart.onVisibleRangeChanged().subscribe(null, (range) => {
              if (!range || !qpChart) return;
              try {
                qpChart.timeScale().setVisibleRange({
                  from: range.from, to: range.to,
                });
              } catch (_) {}
            });
            tvRangeSubscribed = true;
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  // ------------------ QP pane (lightweight-charts, ET everywhere) -----------
  function makeQP() {
    const el = document.getElementById('qp');
    el.innerHTML = '';
    qpChart = LightweightCharts.createChart(el, {
      layout: { background: {color:'#0e1116'}, textColor:'#c8d0dc' },
      grid:   { vertLines:{color:'#171b23'}, horzLines:{color:'#171b23'} },
      timeScale: {
        timeVisible: true, secondsVisible: false, borderColor:'#2a2f3a',
        tickMarkFormatter: (t) => fmtTickTime(t),
      },
      localization: {
        timeFormatter: (t) => fmtCrosshairTime(t),
      },
      rightPriceScale: { borderColor:'#2a2f3a' },
      crosshair: { mode: 1 },  // magnet
    });
    priceSeries = qpChart.addCandlestickSeries({
      upColor:'#4caf50', downColor:'#ef5350',
      borderUpColor:'#4caf50', borderDownColor:'#ef5350',
      wickUpColor:'#4caf50', wickDownColor:'#ef5350',
    });
    indSeries = qpChart.addLineSeries({ color:'#f5a623', lineWidth: 2 });

    qpChart.subscribeCrosshairMove((p) => {
      if (!p || !p.time) { updateReadoutLast(); return; }
      updateReadoutAt(p.time);
    });

    new ResizeObserver(() => qpChart.resize(el.clientWidth, el.clientHeight)).observe(el);
  }

  // ------------------ Readout box -------------------------------------------
  let currentQpInd = null;  // remember last qp indicator value under cursor
  function updateReadoutAt(t) {
    const close = closeByTime.get(t);
    const ind   = indByTime.get(t);
    currentQpInd = ind;
    document.getElementById('rTime').textContent  = t ? fmtCrosshairTime(t) : '—';
    document.getElementById('rClose').textContent = close != null ? close.toFixed(4) : '—';
    document.getElementById('rInd').textContent   = ind   != null ? ind.toFixed(4)   : '—';
    updateDiff();
  }
  function updateReadoutLast() {
    if (currentBars.length === 0) { updateReadoutAt(null); return; }
    updateReadoutAt(currentBars[currentBars.length - 1].time);
  }
  function updateDiff() {
    const tvRaw = document.getElementById('rTv').value;
    const el = document.getElementById('rDiff');
    if (tvRaw === '' || currentQpInd == null) {
      el.textContent = '—'; el.classList.remove('match','miss'); return;
    }
    const tv = parseFloat(tvRaw);
    if (isNaN(tv)) {
      el.textContent = '—'; el.classList.remove('match','miss'); return;
    }
    const d = currentQpInd - tv;
    const signed = (d >= 0 ? '+' : '') + d.toFixed(4);
    // Relative tolerance: within 5e-4 of the value counts as a match.
    const tol = Math.max(1e-4, Math.abs(currentQpInd) * 5e-6);
    el.textContent = signed;
    el.classList.toggle('match', Math.abs(d) <= tol);
    el.classList.toggle('miss',  Math.abs(d) >  tol);
  }

  // ------------------ Data load ---------------------------------------------
  async function loadData() {
    const symbol      = document.getElementById('symbol').value.trim().toUpperCase();
    const tf          = document.getElementById('tf').value;
    const ind         = document.getElementById('ind').value;
    const length      = document.getElementById('length').value;
    const days        = document.getElementById('days').value;
    const session     = document.getElementById('session').value;
    const data_source = document.getElementById('source').value;
    currentIndName = ind === 'none' ? '—' : (indLabelMap[ind] || ind.toUpperCase());
    document.getElementById('rIndK').textContent = ind === 'none'
      ? 'qp indicator' : `qp ${currentIndName}(${length})`;
    document.getElementById('status').textContent = 'loading…';
    let r;
    try {
      r = await fetch(`/data?symbol=${encodeURIComponent(symbol)}&tf=${tf}&ind=${ind}` +
                      `&length=${length}&days=${days}&session=${session}` +
                      `&data_source=${encodeURIComponent(data_source)}`);
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
    currentBars = j.bars || [];
    currentInd  = j.indicator || [];
    closeByTime = new Map(currentBars.map(b => [b.time, b.close]));
    indByTime   = new Map(currentInd.map(p => [p.time, p.value]));

    priceSeries.setData(currentBars);
    indSeries.setData(currentInd);
    qpChart.timeScale().fitContent();
    updateReadoutLast();
    syncTVRange();

    document.getElementById('status').textContent =
      `${currentBars.length} bars · ${j.first || ''} → ${j.last || ''} (ET)`;
  }

  function reload() {
    const symbol = document.getElementById('symbol').value.trim().toUpperCase();
    const tf     = document.getElementById('tf').value;
    const ind    = document.getElementById('ind').value;
    makeTV(symbol, tf, ind);
    if (!qpChart) makeQP();
    loadData();
  }

  window.addEventListener('load', async () => {
    document.getElementById('rTv').addEventListener('input', updateDiff);
    await loadSources();
    reload();
  });
</script></body></html>
"""


def compute_series(symbol: str, tf: str, ind: str, length: int, days: int,
                   session: str, data_source: str = 'yahoo'):
    if data_source.startswith('csv:'):
        # For CSVs the file IS the data — read its full span, then take
        # the last `days` calendar days from its end. No Yahoo, no cache.
        csv_name = data_source[4:]
        csv_path = (CSV_DIR / csv_name).resolve()
        # Guard against path escape.
        if not str(csv_path).startswith(str(CSV_DIR.resolve())):
            raise ValueError(f'illegal csv path {csv_name!r}')
        if not csv_path.exists():
            raise FileNotFoundError(f'CSV not found: {csv_name}')
        head = pd.read_csv(csv_path, usecols=['time'])
        ts_col = head['time']
        if pd.api.types.is_numeric_dtype(ts_col):
            file_first = pd.to_datetime(ts_col.iloc[0],  unit='s', utc=True)
            file_last  = pd.to_datetime(ts_col.iloc[-1], unit='s', utc=True)
        else:
            file_first = pd.to_datetime(ts_col.iloc[0],  utc=True)
            file_last  = pd.to_datetime(ts_col.iloc[-1], utc=True)
        end = file_last
        start = max(file_first, end - pd.Timedelta(days=days))
        bars = load(
            symbol=symbol or csv_path.stem,
            timeframe=tf,
            start=start,
            end=end,
            source=f'csv:{csv_path}',
            session=None if session == 'all' else session,
        )
    else:
        end = pd.Timestamp.now(tz='UTC')
        start = end - pd.Timedelta(days=days)
        # Bucket window to nearest 5 minutes so identical requests hit the
        # cache instead of thrashing Yahoo (which rate-limits AWS IPs).
        start = start.floor('5min')
        end = end.floor('5min')
        bars = load(
            symbol,
            timeframe=tf,
            start=start,
            end=end,
            source='yahoo',
            cache_dir=CACHE_DIR,
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
        # session_vwap may return a Series OR a raw ndarray depending on
        # implementation — asarray handles both without a to_numpy hop.
        y = np.asarray(session_vwap(df))
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
                    data_source=q.get('data_source', 'yahoo'),
                )
                self._send(200, json.dumps(data).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        if u.path == '/sources':
            try:
                self._send(200, json.dumps(list_csv_files()).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        self._send(404, b'not found', 'text/plain')

    def log_message(self, fmt, *args):
        sys.stderr.write(f'[compare] {fmt % args}\n')


def main():
    global CSV_DIR
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='127.0.0.1',
                   help='bind address; use 0.0.0.0 to expose (behind a firewall)')
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--csv-dir', default=str(CSV_DIR),
                   help='directory of CSV data files exposed to the UI')
    args = p.parse_args()
    CSV_DIR = Path(args.csv_dir).expanduser().resolve()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'qp compare UI listening on http://{args.host}:{args.port}')
    print(f'  CSV dir: {CSV_DIR} ({len(list_csv_files())} files)')
    print('  from your laptop, SSH-tunnel:  '
          f'ssh -L {args.port}:localhost:{args.port} ec2-user@<ec2-ip>')
    print(f'  then open:  http://localhost:{args.port}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
