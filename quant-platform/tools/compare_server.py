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
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qp  # noqa: E402  — populates REGISTRY via primitive decorators
from qp.registry import REGISTRY, get_approval, save_approval
from qp.primitives.bars import Bars
from qp.primitives._session import in_rth as _in_rth, in_premarket as _in_premarket
from tools.data import alpaca, polygon, hybrid

# Data feeds the compare tool can pull bars from. Each module exposes the
# same load(symbol, tf, start, end) → tz-aware UTC OHLCV DataFrame.
_LOADERS = {'alpaca': alpaca, 'polygon': polygon, 'hybrid': hybrid}


def _load_dotenv() -> None:
    """Populate os.environ from a `.env` file at the project root, for any
    keys not already set in the environment.

    Why: `export`ed keys only live in the shell session that set them. When
    the SSH/console session reconnects and the server is relaunched, those
    exports are gone and every feed comes up 'no key'. A `.env` file on the
    box fixes that permanently — the server reads it on every start. The
    file is gitignored, so keys never enter the repo. An already-exported
    env var always wins over the file."""
    env_path = Path(__file__).resolve().parents[1] / '.env'
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception as e:  # never let a bad .env stop the server
        print(f'[qp] warning: could not read .env ({env_path}): {e}',
              file=sys.stderr)


_load_dotenv()


def _feed_status() -> dict:
    """Which feeds have credentials configured, and the preferred default.
    Polygon is preferred when available — deeper history + premarket.
    'hybrid' (Polygon history + Alpaca live gap-fill) needs both."""
    has_alpaca  = bool(os.environ.get('APCA_API_KEY_ID') and os.environ.get('APCA_API_SECRET_KEY'))
    has_polygon = bool(os.environ.get('POLYGON_API_KEY'))
    have = {
        'alpaca':  has_alpaca,
        'polygon': has_polygon,
        'hybrid':  has_alpaca and has_polygon,
    }
    default = 'polygon' if has_polygon else 'alpaca'
    return {'feeds': have, 'default_feed': default}


def _build_id() -> str:
    """Short git SHA of the running code, resolved once at startup. Exposed
    in /api/health and the page header so you can confirm at a glance that a
    restart actually picked up the latest commit (vs. an old server process
    still holding the port)."""
    try:
        sha = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=str(Path(__file__).resolve().parents[1]),
            stderr=subprocess.DEVNULL, timeout=5).decode().strip()
        return sha or 'unknown'
    except Exception:
        return 'unknown'


_BUILD = _build_id()

_ET = 'America/New_York'

# Local cache of the chart library so the browser doesn't need to reach any
# external CDN. Populated at server startup from whichever mirror the server
# itself can reach.
_STATIC_DIR = Path(__file__).resolve().parent / '.static'
_CHART_JS   = _STATIC_DIR / 'lightweight-charts.js'
# Pinned to a specific version — an unpinned URL serves whatever is
# latest, and v5 renamed the series API out from under us once already.
# (The page JS feature-detects both v4 and v5, so an already-cached v5
# file keeps working too.)
_CHART_MIRRORS = [
    'https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js',
    'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js',
    'https://cdnjs.cloudflare.com/ajax/libs/lightweight-charts/4.1.3/lightweight-charts.standalone.production.min.js',
]


def _ensure_chart_js() -> bool:
    """Download the chart library once, cache under tools/.static/. Return
    True on success. If every mirror fails we fall back to a CDN reference
    in the HTML (which will only work if the browser can reach one)."""
    if _CHART_JS.exists() and _CHART_JS.stat().st_size > 10_000:
        return True
    _STATIC_DIR.mkdir(parents=True, exist_ok=True)
    for url in _CHART_MIRRORS:
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                data = resp.read()
            if len(data) > 10_000 and b'LightweightCharts' in data:
                _CHART_JS.write_bytes(data)
                print(f'[qp] chart library cached from {url} ({len(data)} bytes)',
                      file=sys.stderr)
                return True
        except Exception as e:
            print(f'[qp] mirror {url} failed: {e}', file=sys.stderr)
    print('[qp] WARNING: could not cache chart library; HTML will fall back '
          'to inline CDN and browser must reach it directly', file=sys.stderr)
    return False


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
            'outputs':     list(m.outputs),
            'file':        m.file,
            'lineno':      m.lineno,
            'approved':    appr is not None,
            'approval':    appr,
        })
    return out


def _source_series(bars: pd.DataFrame, name: str) -> np.ndarray:
    """Resolve a `source` name against the loaded bars. body_high/body_low
    are the S/R script's 'Close/Open' pivot sources — max/min(open, close).
    volume enables verifying volume-MA checks (e.g. sma(volume, 20))."""
    if name == 'close':  return bars['close'].to_numpy(dtype=float)
    if name == 'open':   return bars['open'].to_numpy(dtype=float)
    if name == 'high':   return bars['high'].to_numpy(dtype=float)
    if name == 'low':    return bars['low'].to_numpy(dtype=float)
    if name == 'volume': return bars['volume'].to_numpy(dtype=float)
    if name == 'hl2':    return ((bars['high'] + bars['low']) / 2.0).to_numpy(dtype=float)
    if name == 'hlc3':   return ((bars['high'] + bars['low'] + bars['close']) / 3.0).to_numpy(dtype=float)
    if name == 'ohlc4':  return ((bars['open'] + bars['high'] + bars['low'] + bars['close']) / 4.0).to_numpy(dtype=float)
    if name == 'body_high': return np.maximum(bars['open'].to_numpy(dtype=float), bars['close'].to_numpy(dtype=float))
    if name == 'body_low':  return np.minimum(bars['open'].to_numpy(dtype=float), bars['close'].to_numpy(dtype=float))
    raise ValueError(f'unknown source {name!r}')


def _session_class(ts) -> str:
    """'rth' (09:30-16:00 ET), 'pre' (04:00-09:30), or 'post' (else)."""
    if _in_rth(ts):
        return 'rth'
    if _in_premarket(ts):
        return 'pre'
    return 'post'   # 16:00-20:00 afterhours + overnight


def _call_primitive(m, frame: pd.DataFrame, source: str, kwargs: dict):
    if list(m.inputs) == ['bars']:
        return m.fn(Bars.from_frame(frame), **kwargs)
    elif list(m.inputs) == ['source']:
        return m.fn(_source_series(frame, source), **kwargs)
    raise ValueError(f'unsupported inputs {m.inputs!r} on {m.key}')


def _reindex_asof(arr, src_index, dst_index):
    """Map a value array indexed by src bars onto dst bars: each dst bar
    gets the last src value at-or-before it (forward-fill)."""
    return pd.Series(np.asarray(arr, dtype=float), index=src_index) \
             .reindex(dst_index, method='ffill').to_numpy()


def _one_overlay(bars: pd.DataFrame, ts: list, ov: dict, ctx: dict) -> list:
    """Compute one overlay spec {key, source, params, color} → list of
    plot series (one, or several for dict-output primitives)."""
    key = ov.get('key')
    if not key or key not in REGISTRY:
        raise ValueError(f'unknown primitive {key!r}')
    m = REGISTRY[key]
    kwargs = dict(ov.get('params') or {})
    source = ov.get('source', 'close')

    # Fixed-timeframe primitives (pine_5day → '1m') are computed on their
    # own timeframe regardless of the chart's, then mapped onto the display
    # bars — so the line is identical on a 1m / 5m / 15m chart.
    if m.compute_tf and m.compute_tf != ctx['tf']:
        cbars = ctx['loader'].load(ctx['symbol'], m.compute_tf, ctx['start'], ctx['end'])
        result = _call_primitive(m, cbars, source, kwargs)
        if isinstance(result, dict):
            result = {k: _reindex_asof(a, cbars.index, bars.index) for k, a in result.items()}
        else:
            result = _reindex_asof(result, cbars.index, bars.index)
    else:
        result = _call_primitive(m, bars, source, kwargs)

    if isinstance(result, dict):
        lines = [(sub, np.asarray(a, dtype=float)) for sub, a in result.items()]
    else:
        lines = [(None, np.asarray(result, dtype=float))]

    color = ov.get('color') or '#22c55e'
    args = ','.join(f'{k}={v}' for k, v in kwargs.items())
    out = []
    for idx, (sub, arr) in enumerate(lines):
        vals = [{'time': int(t), 'value': float(v)}
                for t, v in zip(ts, arr) if v == v]
        label = m.name if sub is None else f'{m.name}.{sub}'
        out.append({
            'overlayId': ov.get('id'),
            'name':  f'{label}({args})' if args else label,
            'color': color,
            'style': 0 if idx == 0 else 2,   # first solid, rest dotted
            'values': vals,
        })
    return out


def compute_data(symbol: str, tf: str, days: int, overlays: list,
                 feed: str = 'alpaca', view: str = 'all') -> dict:
    """Fetch bars once, compute every overlay, return everything the UI
    needs. `view`: 'all' (show pre/rth/post, tint extended hours) or
    'regular' (RTH bars only — computed and displayed)."""
    loader = _LOADERS.get(feed)
    if loader is None:
        raise ValueError(f'unknown feed {feed!r} (have: {sorted(_LOADERS)})')
    end = pd.Timestamp.now(tz='UTC').floor('5min')
    if tf == '1m' and feed == 'alpaca':
        days = min(int(days), 7)   # Alpaca IEX 1m history cap
    days = int(days)
    start = end - pd.Timedelta(days=days)
    bars = loader.load(symbol, tf, start, end)

    et_full = bars.index.tz_convert(_ET)
    if view == 'regular':
        mask = np.fromiter((_in_rth(t) for t in et_full), bool, len(bars))
        bars = bars[mask]
    if len(bars) == 0:
        return {'bars': [], 'series': [], 'day_starts': [], 'first': None, 'last': None}

    et = bars.index.tz_convert(_ET)
    # TRUE UTC epoch seconds. The browser chart is told to format these in
    # ET via Intl (America/New_York) so the axis reads the same as
    # TradingView regardless of the viewer's own timezone. (The old
    # "relabel ET as UTC" trick broke for viewers outside UTC — e.g. a
    # UTC+3 browser shifted every bar +3h.)
    ts = ((bars.index - pd.Timestamp('1970-01-01', tz='UTC'))
          // pd.Timedelta(seconds=1)).tolist()

    o = bars['open'].to_numpy(float);  h = bars['high'].to_numpy(float)
    lo = bars['low'].to_numpy(float);  c = bars['close'].to_numpy(float)
    v = bars['volume'].to_numpy(float)

    bar_list = []
    day_starts = []
    prev_date = None
    for i in range(len(bars)):
        d = et[i].date()
        if d != prev_date:
            day_starts.append({'time': int(ts[i]),
                               'label': f'{et[i].month}/{et[i].day}'})
            prev_date = d
        bar = {'time': int(ts[i]), 'open': float(o[i]), 'high': float(h[i]),
               'low': float(lo[i]), 'close': float(c[i]), 'volume': float(v[i])}
        if view == 'all':
            # Candles stay normal green/red; the frontend paints a session
            # BACKGROUND band from this per-bar class (pre / rth / post).
            bar['sess'] = _session_class(et[i])
        bar_list.append(bar)

    ctx = {'symbol': symbol, 'tf': tf, 'loader': loader, 'start': start, 'end': end}
    series_out = []
    for ov in (overlays or []):
        # One failing overlay must not kill the whole request — otherwise a
        # single primitive that needs more history than the feed has (e.g.
        # dynamic_sr, pine_5day on shallow Alpaca data) would blank ALL the
        # overlays. Compute each independently; report failures per-overlay.
        try:
            series_out.extend(_one_overlay(bars, ts, ov, ctx))
        except Exception as e:
            m = REGISTRY.get(ov.get('key'))
            series_out.append({
                'overlayId': ov.get('id'),
                'name':  (m.name if m else str(ov.get('key'))),
                'color': ov.get('color') or '#ef4444',
                'style': 0, 'values': [], 'error': str(e),
            })

    return {
        'bars':   bar_list,
        'series': series_out,
        'day_starts': day_starts,
        'first':  et[0].strftime('%Y-%m-%d %H:%M ET'),
        'last':   et[-1].strftime('%Y-%m-%d %H:%M ET'),
    }


PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><title>qp compare</title>
<!-- Prefer the local copy the server cached at startup. If it 404s (server
     failed to download it), fall back to public CDNs. -->
<script>
(function(){
  // Pin the CDN fallbacks to 4.2.3 — the same version the server caches to
  // /static/. Unpinned URLs resolve to the latest (v5.x), whose series API
  // differs (addLineSeries removed), which would break overlays if the
  // local copy ever failed and the browser fell back to a CDN.
  const srcs = [
    '/static/lightweight-charts.js',
    'https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js',
    'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js',
  ];
  function tryLoad(i){
    if (i >= srcs.length) return;
    const s = document.createElement('script');
    s.src = srcs[i]; s.async = false;
    s.onload = () => { window._chartLibLoaded = true; };
    s.onerror = () => tryLoad(i + 1);
    document.head.appendChild(s);
  }
  tryLoad(0);
})();
</script>
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
  #overlayList { display:flex; flex-direction:column; gap:4px; max-height:150px; overflow:auto; }
  .ovrow { display:flex; align-items:center; gap:7px; padding:4px 6px; border:1px solid var(--border); border-radius:5px; cursor:pointer; background:#141a24; }
  .ovrow.sel { border-color:var(--accent); background:#182130; }
  .ovrow .dot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
  .ovrow .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ovrow .bd { font-size:9px; padding:1px 5px; border-radius:3px; }
  .ovrow .x { color:var(--text3); cursor:pointer; padding:0 2px; }
  .ovrow .x:hover { color:var(--red); }
  #addPrim, #addSource { background:#1c2431; border:1px solid var(--border); color:var(--text); padding:4px 6px; border-radius:4px; font-size:12px; }
  #panel button { cursor:pointer; padding:5px 10px; border-radius:5px; font-size:12px; }
  /* Add-overlay picker lives in the header so the primitive list is always
     visible at the top — on a phone the lower panel scrolls off under the
     charts. */
  #addBar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-left:auto; }
  #addBar select, #addBar button { font-size:12px; border-radius:5px; }
  #addBar #addPrim { background:#1c2431; border:1px solid var(--border); color:var(--text); padding:5px 8px; min-width:150px; }
  #addBar #addBtn { background:var(--accent); color:#000; border:none; padding:6px 12px; font-weight:600; cursor:pointer; }
  /* Narrow screens (phones): stack the lower panel into one column and don't
     let the charts eat the whole viewport, so the panel is reachable. */
  @media (max-width: 820px) {
    main { grid-template-columns: 1fr; height:auto; }
    main > div { height:44vh; }
    #panel { grid-template-columns: 1fr; }
    #addBar { margin-left:0; width:100%; }
    #addBar #addPrim { flex:1; }
  }
</style></head>
<body>
<header>
  <label>Symbol <input id="symbol" value="SPY" size="6"></label>
  <label>TF <select id="tf">
    <option>1m</option><option selected>5m</option><option>15m</option><option>30m</option><option>1h</option><option>1d</option>
  </select></label>
  <label>Days <input id="days" type="number" value="5" min="1" max="730" style="width:66px"></label>
  <label>Feed <select id="feed"><option>alpaca</option><option>polygon</option><option>hybrid</option></select></label>
  <label>Session <select id="view">
    <option value="all">All-day</option>
    <option value="regular">Regular session only</option>
  </select></label>
  <span id="sessLegend" style="font-size:10px;color:var(--text3);display:flex;gap:8px;align-items:center">
    <span><span style="display:inline-block;width:9px;height:9px;background:rgba(59,130,246,.5);border-radius:2px;vertical-align:middle"></span> pre</span>
    <span><span style="display:inline-block;width:9px;height:9px;background:rgba(168,85,247,.5);border-radius:2px;vertical-align:middle"></span> after/overnight</span>
  </span>
  <button onclick="reload()">Compute</button>
  <span id="status" style="color:var(--text3)"></span>
  <span id="addBar">
    <select id="addPrim"></select>
    <select id="addSource">
      <option>close</option><option>open</option><option>high</option><option>low</option>
      <option>hl2</option><option>hlc3</option><option>ohlc4</option>
      <option>volume</option><option>body_high</option><option>body_low</option>
    </select>
    <button id="addBtn" onclick="addOverlay()">+ Add overlay</button>
  </span>
  <span id="build" style="font-size:10px;color:var(--text3);margin-left:8px">build …</span>
</header>
<main>
  <div><div id="chart"></div></div>
  <div><div id="tv"></div></div>
</main>
<div id="panel">
  <div>
    <h3>Overlays <span style="font-weight:400;color:var(--text3);text-transform:none;letter-spacing:0">— add from the picker in the top bar</span></h3>
    <div id="overlayList"></div>
  </div>
  <div>
    <h3>Selected <span id="primStatus" class="badge draft" style="margin-left:6px">—</span></h3>
    <div id="primName" style="font-weight:600">—</div>
    <div id="primDesc" style="color:var(--text2);margin-top:4px;max-height:64px;overflow:auto">Add an overlay, then click it to edit.</div>
    <div id="primFile" class="meta">—</div>
    <h3 style="margin-top:10px">Parameters</h3>
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
let CHART = null, PRICE = null, BG = null, LINES = [], PRIMS = [];
let OVERLAYS = [];          // [{id, key, source, params, color}]
let SELECTED = null;        // overlay id driving the params + approval panels
let _nextId = 1;
// Overlay line colors. Blue first (like a TradingView MA). Deliberately
// excludes the candle green (#22c55e) and candle red (#ef5350) so an
// overlay line never camouflages itself against the candles.
const PALETTE = ['#3b82f6','#f5a623','#a855f7','#ec4899','#06b6d4',
                 '#eab308','#14b8a6','#f97316','#e879f9','#84cc16'];

// Chart-library failures must NEVER take down the rest of the page — the
// primitive dropdown, params, and approval flow all work without a chart.
// (This was the "empty dropdown" bug: initChart threw when the CDN was
// blocked and everything after it silently never ran.)
function chartBanner(msg) {
  const el = document.getElementById('chart');
  el.innerHTML = '<div style="padding:24px;color:#f5a623;font-size:13px;line-height:1.6">' +
    '⚠️ ' + msg + '<br><span style="color:#64748b">The primitive list, parameters and ' +
    'Approve button still work. To fix the chart: restart the server and check qp.log ' +
    'for the "chart library cached" line, then hard-refresh (Ctrl+Shift+R).</span></div>';
}

function waitForChartLib(timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    (function poll() {
      if (window.LightweightCharts) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}

// lightweight-charts changed its series API in v5:
//   v4: chart.addCandlestickSeries(opts) / chart.addLineSeries(opts)
//   v5: chart.addSeries(LightweightCharts.CandlestickSeries, opts)
// Feature-detect so whichever version the server cached works.
function addCandles(opts) {
  if (typeof CHART.addCandlestickSeries === 'function') return CHART.addCandlestickSeries(opts);
  return CHART.addSeries(LightweightCharts.CandlestickSeries, opts);
}
function addLine(opts) {
  if (typeof CHART.addLineSeries === 'function') return CHART.addLineSeries(opts);
  return CHART.addSeries(LightweightCharts.LineSeries, opts);
}
function addHistogram(opts) {
  if (typeof CHART.addHistogramSeries === 'function') return CHART.addHistogramSeries(opts);
  return CHART.addSeries(LightweightCharts.HistogramSeries, opts);
}

// Format epoch-seconds in America/New_York, regardless of the viewer's
// own timezone — so the axis + crosshair read the same as TradingView
// even from a UTC+3 (Saudi Arabia) browser.
const _ET_HM   = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', hour12:false });
const _ET_MD   = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', month:'short', day:'numeric' });
const _ET_FULL = new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });

function initChart() {
  const el = document.getElementById('chart');
  CHART = LightweightCharts.createChart(el, {
    // attributionLogo:false hides the small "TradingView" watermark the
    // lightweight-charts library stamps on our left chart (the library is
    // made by TradingView). Our left chart is qp data, not a TV widget —
    // hiding the logo stops it looking like two TradingViews.
    layout: { background: { color: '#0e1116' }, textColor: '#94a3b8', attributionLogo: false },
    grid:   { vertLines: { color: '#1e2632' }, horzLines: { color: '#1e2632' } },
    timeScale: {
      timeVisible: true, secondsVisible: false, borderColor: '#1e2632',
      // tickMarkType: 0=Year 1=Month 2=DayOfMonth 3=Time 4=TimeWithSeconds
      tickMarkFormatter: (t, tickType) =>
        tickType < 3 ? _ET_MD.format(new Date(t * 1000))
                     : _ET_HM.format(new Date(t * 1000)),
    },
    localization: { timeFormatter: (t) => _ET_FULL.format(new Date(t * 1000)) + ' ET' },
    // Tight top/bottom margins so the candles fill the pane like the
    // TradingView panel — easier side-by-side comparison.
    rightPriceScale: { borderColor: '#1e2632', scaleMargins: { top: 0.08, bottom: 0.08 } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  // Session background bands: a full-height histogram on its own hidden
  // scale, drawn BEFORE the candles so it sits behind them. Each bar is
  // painted with a faint colour by session (premarket / afterhours), or
  // transparent during the regular session.
  BG = addHistogram({ priceScaleId: 'sessbg', priceLineVisible: false,
                      lastValueVisible: false, base: 0 });
  CHART.priceScale('sessbg').applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
  PRICE = addCandles({ upColor:'#22c55e', downColor:'#ef5350', wickUpColor:'#22c55e', wickDownColor:'#ef5350', borderVisible:false });
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
  // CRITICAL: this must never throw. It is called right before reload() in
  // several chains (addOverlay → selectOverlay → loadTV → reload, and the
  // symbol/tf change handlers). The TradingView embed widget throws
  // intermittently — the global isn't ready yet, or the constructor fails
  // when the widget is torn down and recreated on every overlay add
  // (common on mobile). If that exception escaped, reload() never ran and
  // the overlay line was never drawn. Swallow it: the left (qp) chart and
  // overlays do not depend on the TV widget at all.
  try {
    if (typeof TradingView === 'undefined' || !TradingView.widget) return;
    const symbol = document.getElementById('symbol').value.trim().toUpperCase() || 'SPY';
    const tf = document.getElementById('tf').value;
    const tvInterval = ({ '1m':'1', '5m':'5', '15m':'15', '30m':'30', '1h':'60', '1d':'D' })[tf];
    const o = currentOverlay();
    const study = o ? TV_STUDIES[o.key] : null;
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
  } catch (e) {
    console.warn('loadTV failed (TV widget only — overlays unaffected):', e.message);
  }
}

async function loadPrimitives() {
  const r = await fetch('/api/primitives');
  PRIMS = await r.json();
  const sel = document.getElementById('addPrim');
  const keep = sel.value;
  sel.innerHTML = '';
  const groups = {};
  for (const p of PRIMS) (groups[p.group] ||= []).push(p);
  for (const g of Object.keys(groups).sort()) {
    const og = document.createElement('optgroup'); og.label = g;
    for (const p of groups[g]) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = (p.approved ? '✅ ' : '🚧 ') + p.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  if (keep && PRIMS.some(p => p.key === keep)) sel.value = keep;
  sel.onchange = syncSourceEnabled;
  syncSourceEnabled();
}

function primMeta(key) { return PRIMS.find(p => p.key === key); }
function currentOverlay() { return OVERLAYS.find(o => o.id === SELECTED); }

// A 'bars'-input primitive (VWAPs, ATR, levels…) ignores the source
// dropdown — it reads the whole OHLCV bar (price AND volume) itself.
// Grey the source picker out for those so it's clear it doesn't apply.
function syncSourceEnabled() {
  const m = primMeta(document.getElementById('addPrim').value);
  const sel = document.getElementById('addSource');
  const barsInput = m && m.inputs && m.inputs.length === 1 && m.inputs[0] === 'bars';
  sel.disabled = !!barsInput;
  sel.title = barsInput ? 'This primitive uses the full OHLCV bar (price + volume); source is ignored.' : '';
  sel.style.opacity = barsInput ? '0.4' : '1';
}

function persistOverlays() {
  localStorage.setItem('qp_overlays', JSON.stringify(OVERLAYS));
  localStorage.setItem('qp_selected', SELECTED || '');
}

function addOverlay() {
  const key = document.getElementById('addPrim').value;
  const source = document.getElementById('addSource').value;
  const m = primMeta(key); if (!m) return;
  const params = {};
  for (const par of m.params) params[par.name] = par.default;
  const color = PALETTE[OVERLAYS.length % PALETTE.length];
  const id = 'o' + (_nextId++);
  OVERLAYS.push({ id, key, source, params, color });
  persistOverlays(); renderOverlays(); selectOverlay(id); reload();
}

function removeOverlay(id) {
  OVERLAYS = OVERLAYS.filter(o => o.id !== id);
  if (SELECTED === id) SELECTED = OVERLAYS.length ? OVERLAYS[OVERLAYS.length - 1].id : null;
  persistOverlays(); renderOverlays(); renderSelected(); reload();
}

function selectOverlay(id) { SELECTED = id; persistOverlays(); renderOverlays(); renderSelected(); loadTV(); }

function renderOverlays() {
  const box = document.getElementById('overlayList');
  box.innerHTML = '';
  if (!OVERLAYS.length) {
    box.innerHTML = '<div style="color:var(--text3)">No overlays — add one above (e.g. ma → sma).</div>';
    return;
  }
  for (const o of OVERLAYS) {
    const m = primMeta(o.key);
    const args = Object.entries(o.params).map(([k, v]) => k + '=' + v).join(',');
    const appr = m && m.approved;
    const row = document.createElement('div');
    row.className = 'ovrow' + (o.id === SELECTED ? ' sel' : '');
    row.innerHTML =
      `<span class="dot" style="background:${o.color}"></span>` +
      `<span class="nm">${m ? m.name : o.key}${args ? '(' + args + ')' : ''} ` +
        `<span style="color:var(--text3)">${o.source}</span></span>` +
      `<span class="bd" style="background:${appr ? 'rgba(34,197,94,.15)' : 'rgba(245,166,35,.15)'};` +
        `color:${appr ? 'var(--accent)' : 'var(--draft)'}">${appr ? '✓' : '🚧'}</span>` +
      `<span class="x" title="remove">✕</span>`;
    row.onclick = (e) => {
      if (e.target.classList.contains('x')) removeOverlay(o.id);
      else selectOverlay(o.id);
    };
    box.appendChild(row);
  }
}

function readParams() {
  const out = {};
  for (const el of document.querySelectorAll('#paramsGrid input')) {
    let v = el.value;
    if (el.dataset.kind === 'int')   v = parseInt(v, 10);
    if (el.dataset.kind === 'float') v = parseFloat(v);
    if (el.dataset.kind === 'bool')  v = el.type === 'checkbox' ? el.checked : (v === 'true');
    out[el.dataset.name] = v;
  }
  return out;
}

function renderSelected() {
  const o = currentOverlay();
  const nameEl = document.getElementById('primName'), descEl = document.getElementById('primDesc'),
        fileEl = document.getElementById('primFile'), badge = document.getElementById('primStatus'),
        grid = document.getElementById('paramsGrid'), metaEl = document.getElementById('approveMeta'),
        btn = document.getElementById('approveBtn');
  grid.innerHTML = '';
  if (!o) {
    nameEl.textContent = '—'; descEl.textContent = 'Add an overlay, then click it to edit its parameters.';
    fileEl.textContent = '—'; badge.textContent = '—'; badge.className = 'badge draft';
    metaEl.textContent = '—'; btn.textContent = 'Approve as verified';
    return;
  }
  const m = primMeta(o.key);
  nameEl.textContent = m.name + ' (' + m.key + ')';
  descEl.textContent = m.description || '—';
  fileEl.textContent = (m.file || '') + (m.lineno ? ':' + m.lineno : '');
  badge.textContent = m.approved ? 'approved' : 'draft';
  badge.className = 'badge ' + (m.approved ? 'approved' : 'draft');
  if (m.params.length === 0) {
    grid.innerHTML = '<div style="color:var(--text3);grid-column:1/-1">(no parameters)</div>';
  }
  for (const par of m.params) {
    const lab = document.createElement('label'); lab.textContent = par.name; grid.appendChild(lab);
    const inp = document.createElement('input');
    inp.dataset.name = par.name; inp.dataset.kind = par.kind;
    if (par.kind === 'bool') {
      inp.type = 'checkbox'; inp.checked = (o.params[par.name] === true);
      inp.style.width = 'auto'; inp.style.justifySelf = 'start';
    } else {
      inp.value = o.params[par.name] ?? par.default ?? '';
      if (par.min != null) inp.min = par.min;
      if (par.max != null) inp.max = par.max;
      inp.type = (par.kind === 'int' || par.kind === 'float') ? 'number' : 'text';
      if (par.kind === 'float') inp.step = 'any';
    }
    inp.onchange = () => { o.params = readParams(); persistOverlays(); renderOverlays(); reload(); };
    grid.appendChild(inp);
  }
  const ap = m.approval;
  metaEl.textContent = ap ? `approved ${ap.approved_at} by ${ap.approved_by} · ${ap.git_sha}` : '—';
  btn.textContent = m.approved ? 'Re-approve (overwrite)' : 'Approve as verified';
}

async function reload() {
  if (!PRICE) return;   // no chart → nothing to draw into
  const symbol = document.getElementById('symbol').value.trim().toUpperCase() || 'SPY';
  const tf = document.getElementById('tf').value;
  const days = document.getElementById('days').value;
  const feed = document.getElementById('feed').value;
  const view = document.getElementById('view').value;
  localStorage.setItem('qp_symbol', symbol);
  localStorage.setItem('qp_tf', tf);
  localStorage.setItem('qp_days', days);
  localStorage.setItem('qp_feed', feed);
  localStorage.setItem('qp_view', view);
  document.getElementById('status').textContent = 'loading… (' + feed + ', ' + view + ')';
  const qs = new URLSearchParams({ symbol, tf, days, feed, view, overlays: JSON.stringify(OVERLAYS) });
  const r = await fetch('/api/data?' + qs);
  if (!r.ok) { document.getElementById('status').textContent = 'error: ' + (await r.text()).slice(0, 200); return; }
  const j = await r.json();
  document.getElementById('status').textContent =
    `${j.first} → ${j.last} · ${(j.bars || []).length} bars · ${OVERLAYS.length} overlay(s)`;
  PRICE.setData(j.bars);
  // Session background bands (all-day view only). Full-height bar, coloured
  // faint blue in premarket and faint purple in afterhours/overnight;
  // transparent during the regular session so RTH shows the plain dark bg.
  if (BG) {
    BG.setData((j.bars || []).map(b => ({
      time: b.time, value: 1,
      color: b.sess === 'pre'  ? 'rgba(59,130,246,0.13)'
           : b.sess === 'post' ? 'rgba(168,85,247,0.15)'
           : 'rgba(0,0,0,0)',
    })));
  }
  // Day separators: a small marker + date label at each day's first bar
  // (skip on the 1d timeframe where every bar is a day).
  if (tf !== '1d' && j.day_starts && j.day_starts.length) {
    PRICE.setMarkers(j.day_starts.map(d => (
      { time: d.time, position: 'belowBar', color: '#64748b', shape: 'square',
        size: 1, text: d.label }   // label is the ET date, computed server-side
    )));
  } else {
    PRICE.setMarkers([]);
  }
  for (const l of LINES) { try { CHART.removeSeries(l); } catch(_){} }
  LINES = [];
  // Draw each overlay line, and report point counts in the status bar so a
  // silent failure (empty series, or an addLine API mismatch) is visible:
  //   'sma(length=9): 148 pts'  → drawing fine
  //   'sma(length=9): 0 pts'    → computed empty on this feed (raise Days,
  //                               check params, or switch feed)
  //   'sma(...): draw error …'  → chart-library API problem
  const drawn = [];
  for (const s of (j.series || [])) {
    if (s.error) { drawn.push(`${s.name}: ERROR ${s.error}`); continue; }
    const pts = (s.values || []).length;
    try {
      const line = addLine({ color: s.color, lineWidth: 2, priceLineVisible: false,
                             title: s.name, lineStyle: s.style || 0 });
      line.setData(s.values || []);
      LINES.push(line);
      drawn.push(`${s.name}: ${pts} pts`);
    } catch (e) {
      drawn.push(`${s.name}: draw error ${e.message}`);
    }
  }
  console.log('qp overlays:', drawn, j.series);
  if (drawn.length) document.getElementById('status').textContent += ' · ' + drawn.join(' · ');
}

async function approve() {
  const o = currentOverlay(); if (!o) { alert('Select an overlay to approve.'); return; }
  const notes = document.getElementById('approveNotes').value.trim();
  const who = prompt('Approving as (your name / initials):', localStorage.getItem('qp_approver') || '') || '';
  if (!who) return;
  localStorage.setItem('qp_approver', who);
  const r = await fetch('/api/approve', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ key: o.key, approved_by: who, notes }),
  });
  if (!r.ok) { alert('approve failed: ' + await r.text()); return; }
  await loadPrimitives();
  renderOverlays(); renderSelected();
  const btn = document.getElementById('approveBtn');
  btn.classList.add('done'); btn.textContent = 'saved ✓';
  setTimeout(() => btn.classList.remove('done'), 1500);
}

function restoreState() {
  const sym = localStorage.getItem('qp_symbol'); if (sym) document.getElementById('symbol').value = sym;
  const tf  = localStorage.getItem('qp_tf');     if (tf)  document.getElementById('tf').value = tf;
  const d   = localStorage.getItem('qp_days');   if (d)   document.getElementById('days').value = d;
  const f   = localStorage.getItem('qp_feed');   if (f)   document.getElementById('feed').value = f;
  const vw  = localStorage.getItem('qp_view');   if (vw)  document.getElementById('view').value = vw;
}

function restoreOverlays() {
  try {
    const a = JSON.parse(localStorage.getItem('qp_overlays') || '[]');
    if (Array.isArray(a) && a.length) {
      OVERLAYS = a;
      // Recolor overlays whose saved color collides with the candle colors.
      // Older sessions seeded the line as #22c55e — the up-candle green — so
      // it vanished against green candles. Remap those to a palette color.
      const CANDLE = new Set(['#22c55e', '#ef5350', '#ef4444']);
      OVERLAYS.forEach((o, i) => { if (!o.color || CANDLE.has(o.color)) o.color = PALETTE[i % PALETTE.length]; });
      _nextId = Math.max(...a.map(o => parseInt((o.id || 'o0').slice(1)) || 0)) + 1;
      SELECTED = localStorage.getItem('qp_selected') || a[0].id;
      persistOverlays();
    }
  } catch (_) {}
}

async function initFeeds() {
  // Label feeds by whether the server has their keys; default to the
  // server's preferred feed (polygon when configured) unless the user
  // already picked one.
  try {
    const h = await (await fetch('/api/health')).json();
    const sel = document.getElementById('feed');
    for (const opt of sel.options) {
      const ok = h.feeds && h.feeds[opt.value];
      opt.textContent = opt.value + (ok ? '' : ' (no key)');
    }
    if (!localStorage.getItem('qp_feed') && h.default_feed) sel.value = h.default_feed;
    // Show the running build (git SHA) so a stale server process is obvious.
    const b = document.getElementById('build');
    if (b) b.textContent = 'build ' + (h.build || '?');
  } catch (_) {}
}

window.addEventListener('load', async () => {
  restoreState();
  await initFeeds();
  // The overlay list + approval flow must come up no matter what happens
  // to the chart library. Order: primitives first, chart second.
  try {
    await loadPrimitives();
  } catch (e) {
    document.getElementById('status').textContent = 'failed to load primitives: ' + e;
  }
  restoreOverlays();
  if (!OVERLAYS.length && PRIMS.some(p => p.key === 'ma.sma')) {
    // Seed a sensible default so the page isn't blank on first visit.
    const m = primMeta('ma.sma'); const params = {};
    for (const par of m.params) params[par.name] = par.default;
    OVERLAYS = [{ id: 'o' + (_nextId++), key: 'ma.sma', source: 'close', params, color: PALETTE[0] }];
    SELECTED = OVERLAYS[0].id;
    persistOverlays();
  }
  renderOverlays(); renderSelected();
  loadTV();
  const haveLib = await waitForChartLib(8000);
  if (haveLib) {
    try { initChart(); } catch (e) { chartBanner('Chart init failed: ' + e.message); }
  } else {
    chartBanner('Chart library did not load — /static/lightweight-charts.js missing and no CDN reachable from this browser.');
  }
  if (PRICE) reload();
});
document.getElementById('symbol').addEventListener('change', () => { loadTV(); reload(); });
document.getElementById('tf').addEventListener('change',      () => { loadTV(); reload(); });
document.getElementById('feed').addEventListener('change',    () => reload());
document.getElementById('view').addEventListener('change',    () => reload());
document.getElementById('days').addEventListener('change',    () => reload());
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
        if u.path == '/static/lightweight-charts.js':
            if _CHART_JS.exists():
                body = _CHART_JS.read_bytes()
                self._send(200, body, 'application/javascript; charset=utf-8'); return
            self._send(404, b'not cached', 'text/plain'); return
        if u.path == '/api/health':
            self._send(200, json.dumps({'ok': True, 'build': _BUILD,
                                        'primitives': len(REGISTRY),
                                        **_feed_status()}).encode('utf-8')); return
        if u.path == '/api/primitives':
            self._send(200, json.dumps(list_primitives()).encode('utf-8')); return
        if u.path == '/api/data':
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                # New multi-overlay contract: overlays=[{id,key,source,params,color}].
                # Back-compat: a single key=/params=/source= still works.
                if q.get('overlays'):
                    overlays = json.loads(q['overlays'])
                elif q.get('key'):
                    overlays = [{'id': 'a', 'key': q['key'],
                                 'source': q.get('source', 'close'),
                                 'params': json.loads(q.get('params') or '{}')}]
                else:
                    overlays = []
                out = compute_data(
                    symbol=q.get('symbol', 'SPY'),
                    tf=q.get('tf', '5m'),
                    days=int(q.get('days', 5)),
                    overlays=overlays,
                    feed=q.get('feed', 'alpaca'),
                    view=q.get('view', 'all'),
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
    chart_ok = _ensure_chart_js()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'qp compare UI on http://{args.host}:{args.port} — '
          f'build {_BUILD} — '
          f'{len(REGISTRY)} primitives loaded — '
          f'chart lib {"cached locally" if chart_ok else "will use CDN fallback"}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
