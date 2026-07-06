"""
qp compare tool — primitive verifier.

Single page:
    • lightweight-charts panel  → renders bars + the primitive overlay
    • TradingView widget         → same symbol/TF for eyeball parity
    • primitive picker           → pick group + primitive + params
    • approval panel             → Approve / add notes → writes
                                   approvals/approvals.json

Endpoints:
    GET  /                       → the page (HTML)
    GET  /api/health             → {"ok": true, "primitives": N} — smoke test
    GET  /api/primitives         → registry + approval status (JSON)
    GET  /api/data?symbol=...    → bars + overlay values (JSON)
    POST /api/approve            → save an approval entry (JSON body)

The tool has no logic of its own beyond fetching bars and calling
qp primitives — every number it shows comes from an @primitive
function. Add a primitive to qp/primitives/*.py → refresh the page.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qp  # noqa: E402  — populates REGISTRY via primitive decorators
from qp.registry import REGISTRY, get_approval, save_approval
from qp.primitives.bars import Bars
from tools.data import alpaca

_ET = 'America/New_York'


def _git_sha() -> str:
    try:
        out = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=Path(__file__).resolve().parent, stderr=subprocess.DEVNULL)
        return out.decode().strip()
    except Exception:
        return ''


def list_primitives() -> list[dict]:
    """Return REGISTRY snapshot for the picker, sorted by group + name."""
    out = []
    for key in sorted(REGISTRY):
        m = REGISTRY[key]
        appr = get_approval(key)
        out.append({
            'key':         m.key,
            'name':        m.name,
            'group':       m.group,
            'description': m.description,
            'params': [
                {'name': p.name, 'kind': p.kind, 'default': p.default,
                 'min': p.min, 'max': p.max, 'description': p.description}
                for p in m.params
            ],
            'inputs':      list(m.inputs),
            'file':        m.file,
            'lineno':      m.lineno,
            'approved':    appr is not None,
            'approval':    appr,
        })
    return out


def _source_series(bars: pd.DataFrame, name: str) -> np.ndarray:
    """Resolve a `source` name (close/open/high/low/hl2/hlc3/ohlc4)
    against the loaded bars and return a numpy array."""
    if name == 'close':  return bars['close'].to_numpy(dtype=float)
    if name == 'open':   return bars['open'].to_numpy(dtype=float)
    if name == 'high':   return bars['high'].to_numpy(dtype=float)
    if name == 'low':    return bars['low'].to_numpy(dtype=float)
    if name == 'hl2':    return ((bars['high'] + bars['low']) / 2.0).to_numpy(dtype=float)
    if name == 'hlc3':   return ((bars['high'] + bars['low'] + bars['close']) / 3.0).to_numpy(dtype=float)
    if name == 'ohlc4':  return ((bars['open'] + bars['high'] + bars['low'] + bars['close']) / 4.0).to_numpy(dtype=float)
    raise ValueError(f'unknown source {name!r}')


def compute_data(symbol: str, tf: str, days: int, primitive_key: str,
                 params: dict, source: str = 'close') -> dict:
    """Fetch bars + call the primitive + return everything the UI needs."""
    end = pd.Timestamp.now(tz='UTC').floor('5min')
    days = min(int(days), 7) if tf == '1m' else int(days)
    start = end - pd.Timedelta(days=days)
    bars = alpaca.load(symbol, tf, start, end)
    if len(bars) == 0:
        return {'bars': [], 'series': [], 'first': None, 'last': None}

    ts = (bars.index.view('int64') // 1_000_000_000).tolist()
    bar_list = [
        {'time': int(t), 'open': float(o), 'high': float(h),
         'low': float(l), 'close': float(c), 'volume': float(v)}
        for t, o, h, l, c, v in zip(ts, bars['open'], bars['high'], bars['low'],
                                    bars['close'], bars['volume'])
    ]

    series_out = []
    if primitive_key:
        if primitive_key not in REGISTRY:
            raise ValueError(f'unknown primitive {primitive_key!r}')
        m = REGISTRY[primitive_key]
        kwargs = dict(params or {})
        if list(m.inputs) == ['bars']:
            result = m.fn(Bars.from_frame(bars), **kwargs)
        elif list(m.inputs) == ['source']:
            src = _source_series(bars, source)
            result = m.fn(src, **kwargs)
        else:
            raise ValueError(f'unsupported inputs {m.inputs!r} on {primitive_key}')

        # Single array → one series. Dict → one per key (BB, MACD, etc.)
        if isinstance(result, dict):
            lines = [(sub_name, np.asarray(arr, dtype=float))
                     for sub_name, arr in result.items()]
        else:
            lines = [(None, np.asarray(result, dtype=float))]

        approved = get_approval(primitive_key) is not None
        # Multi-line palettes never use "approved-green" as a per-line
        # signal — the badge already tells you approval status. For a
        # single-line primitive, keep the green/orange convention.
        palette = ['#f5a623', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6']
        for idx, (sub_name, arr) in enumerate(lines):
            vals = [{'time': int(t), 'value': float(v)}
                    for t, v in zip(ts, arr) if v == v]
            if len(lines) == 1:
                color = '#22c55e' if approved else '#f5a623'
            else:
                color = palette[idx % len(palette)]
            label = m.name if sub_name is None else f'{m.name}.{sub_name}'
            args = ','.join(f'{k}={v}' for k, v in kwargs.items())
            series_out.append({
                'name':  f'{label}({args})' if args else label,
                'color': color,
                'values': vals,
            })

    return {
        'bars':   bar_list,
        'series': series_out,
        # Show ET times in the status line — that's what TradingView shows
        # on the right panel, so eyeball parity gets the same clock.
        'first':  bars.index[0].tz_convert(_ET).strftime('%Y-%m-%d %H:%M ET'),
        'last':   bars.index[-1].tz_convert(_ET).strftime('%Y-%m-%d %H:%M ET'),
    }


PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>qp compare</title>
<script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
<style>
  :root { --bg:#0e1116; --panel:#151a24; --border:#1e2632; --text:#e2e8f0; --text2:#94a3b8; --text3:#64748b; --accent:#22c55e; --draft:#f5a623; --red:#ef5350; }
  html,body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; height:100%; }
  header { padding:10px 16px; border-bottom:1px solid var(--border); display:flex; gap:12px; align-items:center; flex-wrap:wrap; font-size:12px; }
  header label { display:flex; gap:6px; align-items:center; color:var(--text2); }
  header input, header select { background:#1c2431; border:1px solid var(--border); color:var(--text); padding:5px 8px; border-radius:5px; font-size:12px; }
  header button { background:var(--accent); color:#000; border:none; padding:6px 14px; border-radius:5px; font-size:12px; font-weight:600; cursor:pointer; }
  main { display:grid; grid-template-columns: 1fr 1fr; gap:1px; background:var(--border); height:calc(100vh - 220px); }
  main > div { background:var(--bg); position:relative; }
  #chart { width:100%; height:100%; }
  #tv { width:100%; height:100%; }
  #panel { padding:12px 16px; border-top:1px solid var(--border); display:grid; grid-template-columns: 2fr 1fr 1fr; gap:14px; font-size:12px; }
  #panel h3 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--text2); }
  #panel .meta { color:var(--text3); font-family:'SF Mono',Consolas,monospace; font-size:10px; margin-top:4px; word-break:break-all; }
  #paramsGrid { display:grid; grid-template-columns: auto 1fr; gap:6px 10px; align-items:center; }
  #paramsGrid label { color:var(--text2); }
  #paramsGrid input { background:#1c2431; border:1px solid var(--border); color:var(--text); padding:4px 8px; border-radius:4px; font-size:12px; width:100%; box-sizing:border-box; }
  .badge { padding:2px 8px; border-radius:3px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
  .badge.approved { background:rgba(34,197,94,.15); color:var(--accent); }
  .badge.draft { background:rgba(245,166,35,.15); color:var(--draft); }
  #approveNotes { width:100%; box-sizing:border-box; min-height:60px; background:#1c2431; border:1px solid var(--border); color:var(--text); padding:6px 8px; border-radius:5px; font-size:12px; font-family:inherit; resize:vertical; }
  #approveBtn { width:100%; margin-top:8px; }
  #approveBtn.done { background:var(--draft); }
</style></head>
<body>
<header>
  <label>Symbol <input id="symbol" value="SPY" size="6"></label>
  <label>TF <select id="tf">
    <option>1m</option><option selected>5m</option><option>15m</option><option>30m</option><option>1h</option><option>1d</option>
  </select></label>
  <label>Days <input id="days" type="number" value="5" min="1" max="60" style="width:60px"></label>
  <label>Primitive <select id="prim" style="min-width:220px"></select></label>
  <label>Source <select id="source">
    <option>close</option><option>open</option><option>high</option><option>low</option>
    <option>hl2</option><option>hlc3</option><option>ohlc4</option>
  </select></label>
  <button onclick="reload()">Compute</button>
  <span id="status" style="color:var(--text3)"></span>
</header>
<main>
  <div><div id="chart"></div></div>
  <div><div id="tv"></div></div>
</main>
<div id="panel">
  <div>
    <h3>Primitive <span id="primStatus" class="badge draft" style="margin-left:6px">draft</span></h3>
    <div id="primName" style="font-weight:600">—</div>
    <div id="primDesc" style="color:var(--text2);margin-top:4px">Pick a primitive above.</div>
    <div id="primFile" class="meta">—</div>
  </div>
  <div>
    <h3>Parameters</h3>
    <div id="paramsGrid"></div>
  </div>
  <div>
    <h3>Approval</h3>
    <textarea id="approveNotes" placeholder="Notes — e.g. 'matches TV bar-for-bar on SPY 5m 2026-07-02'"></textarea>
    <button id="approveBtn" onclick="approve()">Approve as verified</button>
    <div id="approveMeta" class="meta" style="margin-top:6px">—</div>
  </div>
</div>
<script>
let CHART = null, PRICE = null, LINES = [], PRIMS = [];

function initChart() {
  const el = document.getElementById('chart');
  CHART = LightweightCharts.createChart(el, {
    layout: { background: { color: '#0e1116' }, textColor: '#94a3b8' },
    grid:   { vertLines: { color: '#1e2632' }, horzLines: { color: '#1e2632' } },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1e2632' },
    rightPriceScale: { borderColor: '#1e2632' },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  PRICE = CHART.addCandlestickSeries({ upColor:'#22c55e', downColor:'#ef5350', wickUpColor:'#22c55e', wickDownColor:'#ef5350', borderVisible:false });
  new ResizeObserver(() => CHART.applyOptions({ width: el.clientWidth, height: el.clientHeight })).observe(el);
}

// Primitive key → TradingView built-in study ID. When you pick a primitive
// the TV widget reloads with the matching study attached, so eyeball parity
// is one page-load instead of clicking through TV's Indicators menu.
const TV_STUDIES = {
  'ma.sma':            'MASimple@tv-basicstudies',
  'ma.ema':            'MAExp@tv-basicstudies',
  'ma.wma':            'MAWeighted@tv-basicstudies',
  'ma.vwma':           'MAVolumeWeighted@tv-basicstudies',
  'ma.hma':            'HullMA@tv-basicstudies',
  'ma.rma':            null,   // Wilder RMA — no direct TV overlay
  'vwap.session':      'VWAP@tv-basicstudies',
  'volatility.atr':    'ATR@tv-basicstudies',
  'volatility.stdev':  'StandardDeviation@tv-basicstudies',
  'volatility.bb':     'BB@tv-basicstudies',
  'volatility.true_range': null,  // TR — no direct TV overlay
  'osc.rsi':           'RSI@tv-basicstudies',
  'extremes.highest':  null,   // add "Donchian Channels" manually if you want it
  'extremes.lowest':   null,
};

function loadTV() {
  const symbol = document.getElementById('symbol').value.trim().toUpperCase() || 'SPY';
  const tf = document.getElementById('tf').value;
  const tvInterval = ({ '1m':'1', '5m':'5', '15m':'15', '30m':'30', '1h':'60', '1d':'D' })[tf];
  const primKey = document.getElementById('prim').value;
  const study = TV_STUDIES[primKey];
  document.getElementById('tv').innerHTML = '';
  new TradingView.widget({
    autosize: true,
    // Bare symbol — TV widget resolves to the primary exchange. Hardcoding
    // 'NASDAQ:' broke NYSE/AMEX tickers like SPY.
    symbol: symbol,
    interval: tvInterval, timezone: 'America/New_York',
    theme: 'dark', style: '1', locale: 'en',
    hide_top_toolbar: true, hide_side_toolbar: false,
    studies: study ? [study] : [],
    container_id: 'tv',
  });
}

async function loadPrimitives() {
  const r = await fetch('/api/primitives');
  PRIMS = await r.json();
  const sel = document.getElementById('prim');
  const savedKey = sel.value || localStorage.getItem('qp_prim') || '';
  sel.innerHTML = '';
  const groups = {};
  for (const p of PRIMS) (groups[p.group] ||= []).push(p);
  for (const g of Object.keys(groups).sort()) {
    const og = document.createElement('optgroup');
    og.label = g;
    for (const p of groups[g]) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = (p.approved ? '✅ ' : '🚧 ') + p.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (savedKey && PRIMS.some(p => p.key === savedKey)) sel.value = savedKey;
  sel.onchange = () => { onPrimChange(); loadTV(); reload(); };
  onPrimChange();
}

function currentPrim() {
  const k = document.getElementById('prim').value;
  return PRIMS.find(p => p.key === k);
}

function onPrimChange() {
  const p = currentPrim();
  if (!p) return;
  localStorage.setItem('qp_prim', p.key);
  document.getElementById('primName').textContent = p.name + ' (' + p.key + ')';
  document.getElementById('primDesc').textContent = p.description || '—';
  document.getElementById('primFile').textContent = (p.file || '') + (p.lineno ? ':' + p.lineno : '');
  const badge = document.getElementById('primStatus');
  badge.textContent = p.approved ? 'approved' : 'draft';
  badge.className = 'badge ' + (p.approved ? 'approved' : 'draft');
  const grid = document.getElementById('paramsGrid');
  grid.innerHTML = '';
  // Per-primitive param cache — remember what you typed last time you looked
  // at this primitive.
  const savedParams = JSON.parse(localStorage.getItem('qp_params_' + p.key) || '{}');
  if (p.params.length === 0) {
    const note = document.createElement('div');
    note.style.color = 'var(--text3)'; note.style.gridColumn = '1 / -1';
    note.textContent = '(no parameters)';
    grid.appendChild(note);
  }
  for (const par of p.params) {
    const lab = document.createElement('label'); lab.textContent = par.name; grid.appendChild(lab);
    const inp = document.createElement('input');
    inp.dataset.name = par.name; inp.dataset.kind = par.kind;
    inp.value = savedParams[par.name] ?? par.default ?? '';
    if (par.min != null) inp.min = par.min;
    if (par.max != null) inp.max = par.max;
    inp.type = (par.kind === 'int' || par.kind === 'float') ? 'number' : 'text';
    if (par.kind === 'float') inp.step = 'any';
    grid.appendChild(inp);
  }
  const meta = p.approval;
  document.getElementById('approveMeta').textContent = meta
    ? `approved ${meta.approved_at} by ${meta.approved_by} · ${meta.git_sha}`
    : '—';
  document.getElementById('approveBtn').textContent = p.approved ? 'Re-approve (overwrite)' : 'Approve as verified';
}

function collectParams() {
  const inputs = document.querySelectorAll('#paramsGrid input');
  const out = {};
  for (const el of inputs) {
    let v = el.value;
    if (el.dataset.kind === 'int')   v = parseInt(v, 10);
    if (el.dataset.kind === 'float') v = parseFloat(v);
    if (el.dataset.kind === 'bool')  v = (v === 'true');
    out[el.dataset.name] = v;
  }
  return out;
}

async function reload() {
  const p = currentPrim();
  if (!p) return;
  const symbol = document.getElementById('symbol').value.trim().toUpperCase() || 'SPY';
  const tf = document.getElementById('tf').value;
  const days = document.getElementById('days').value;
  const source = document.getElementById('source').value;
  const params = collectParams();
  // Persist so a hard-refresh lands you back where you were.
  localStorage.setItem('qp_symbol', symbol);
  localStorage.setItem('qp_tf', tf);
  localStorage.setItem('qp_days', days);
  localStorage.setItem('qp_source', source);
  localStorage.setItem('qp_params_' + p.key, JSON.stringify(params));
  document.getElementById('status').textContent = 'loading…';
  const qs = new URLSearchParams({ symbol, tf, days, source, key: p.key, params: JSON.stringify(params) });
  const r = await fetch('/api/data?' + qs);
  if (!r.ok) { document.getElementById('status').textContent = 'error: ' + (await r.text()).slice(0, 200); return; }
  const j = await r.json();
  document.getElementById('status').textContent = `${j.first} → ${j.last} · ${(j.bars || []).length} bars`;
  PRICE.setData(j.bars);
  for (const l of LINES) { try { CHART.removeSeries(l); } catch(_){} }
  LINES = [];
  for (const s of (j.series || [])) {
    const line = CHART.addLineSeries({ color: s.color, lineWidth: 2, priceLineVisible: false, title: s.name });
    line.setData(s.values);
    LINES.push(line);
  }
}

async function approve() {
  const p = currentPrim(); if (!p) return;
  const notes = document.getElementById('approveNotes').value.trim();
  const who = prompt('Approving as (your name / initials):', localStorage.getItem('qp_approver') || '') || '';
  if (!who) return;
  localStorage.setItem('qp_approver', who);
  const r = await fetch('/api/approve', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ key: p.key, approved_by: who, notes }),
  });
  if (!r.ok) { alert('approve failed: ' + await r.text()); return; }
  await loadPrimitives();
  document.getElementById('prim').value = p.key;
  onPrimChange();
  const btn = document.getElementById('approveBtn');
  btn.classList.add('done'); btn.textContent = 'saved ✓';
  setTimeout(() => btn.classList.remove('done'), 1500);
}

function restoreState() {
  const sym = localStorage.getItem('qp_symbol'); if (sym) document.getElementById('symbol').value = sym;
  const tf  = localStorage.getItem('qp_tf');     if (tf)  document.getElementById('tf').value = tf;
  const d   = localStorage.getItem('qp_days');   if (d)   document.getElementById('days').value = d;
  const s   = localStorage.getItem('qp_source'); if (s)   document.getElementById('source').value = s;
}

window.addEventListener('load', () => {
  restoreState();
  initChart();
  loadPrimitives().then(() => { loadTV(); reload(); });
});
document.getElementById('symbol').addEventListener('change', () => { loadTV(); reload(); });
document.getElementById('tf').addEventListener('change',      () => { loadTV(); reload(); });
</script>
<!-- TradingView widget loader (external — required by their embed API) -->
<script src="https://s3.tradingview.com/tv.js"></script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ('/', '/index.html'):
            self._send(200, PAGE.encode('utf-8'), 'text/html; charset=utf-8'); return
        if u.path == '/api/health':
            self._send(200, json.dumps({'ok': True, 'primitives': len(REGISTRY)}).encode('utf-8')); return
        if u.path == '/api/primitives':
            self._send(200, json.dumps(list_primitives()).encode('utf-8')); return
        if u.path == '/api/data':
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                params = json.loads(q.get('params') or '{}')
                out = compute_data(
                    symbol=q.get('symbol', 'SPY'),
                    tf=q.get('tf', '5m'),
                    days=int(q.get('days', 5)),
                    primitive_key=q.get('key', ''),
                    params=params,
                    source=q.get('source', 'close'),
                )
                self._send(200, json.dumps(out).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        self._send(404, b'not found', 'text/plain')

    def do_POST(self):
        u = urlparse(self.path)
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length) if length else b'{}'
        try:
            body = json.loads(raw.decode('utf-8'))
        except Exception:
            self._send(400, b'bad json', 'text/plain'); return
        if u.path == '/api/approve':
            try:
                save_approval(
                    key=str(body['key']),
                    approved_by=str(body.get('approved_by', 'anon')),
                    notes=str(body.get('notes', '')),
                    git_sha=_git_sha(),
                )
                self._send(200, json.dumps({'ok': True}).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        self._send(404, b'not found', 'text/plain')

    def log_message(self, fmt, *args):
        sys.stderr.write(f'[qp] {fmt % args}\n')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8765)
    args = p.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'qp compare UI on http://{args.host}:{args.port} — {len(REGISTRY)} primitives loaded')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
