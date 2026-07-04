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
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qp.data import load
from qp.ma import (
    ema, sma, rma, wma, vwma, hma,
    n_session_sma, pine_5day_sma,
    weekly_sma, monthly_sma, quarterly_sma, yearly_sma,
)
from qp.vwap import (
    session_vwap, rolling_n_day_vwap, n_day_vwap,
    weekly_vwap, monthly_vwap, quarterly_vwap, yearly_vwap,
    today_hh_vwap, today_ll_vwap,
    week_hh_vwap, week_ll_vwap,
    gap_vwap,
    last_hour_ll_vwap, last_hour_hh_vwap,
    earnings_vwap,
)
from qp.price import (
    hl2, hlc3, ohlc4, typical_price, median_price, weighted_close,
)
from qp.volatility import atr, stdev, true_range, bollinger, bollinger_ema, keltner
from qp.indicators import rsi, macd, stochastic, cci
from qp.levels import (
    today_high, today_low,
    week_high, week_low,
    month_high, month_low,
    prev_day_high, prev_day_low,
    prev_week_high, prev_week_low,
    prev_month_high, prev_month_low,
    rolling_n_day_high, rolling_n_day_low,
)


# Disk cache so we don't thrash Yahoo (which rate-limits AWS IPs).
CACHE_DIR = Path.home() / '.qp-cache'

# Where to look for user-supplied CSV data files. Set via --csv-dir.
CSV_DIR: Path = Path(__file__).resolve().parents[1] / 'data' / 'csv'

# The Node trade desk's SQLite DB. Setups + check library live here.
TRADEDESK_DB: Path = Path(__file__).resolve().parents[2] / 'data' / 'tradedesk.db'


def list_qp_setups() -> list[dict]:
    """Return the Python-defined setups from qp.setups.library, in the
    same shape as list_setups() so the UI can treat them uniformly."""
    try:
        from qp.setups.library import list_setups as list_library
    except Exception as e:
        print(f'[qp-setups] library import failed: {e}', file=sys.stderr)
        return []
    out = []
    for entry in list_library():
        out.append({
            'id':          f"qp:{entry['id']}",
            'name':        entry['name'],
            'description': entry['description'],
            'side':        entry['side'],
            'specs':       entry['chart_specs'],
            'source':      'qp',
        })
    return out


def list_setups() -> list[dict]:
    """Return every enabled setup from the trade desk DB, with the
    indicator specs implied by its default + assigned additional checks.
    Returns [] if the DB is missing (dev environment)."""
    if not TRADEDESK_DB.exists():
        return []
    conn = sqlite3.connect(f'file:{TRADEDESK_DB}?mode=ro', uri=True)
    try:
        conn.row_factory = sqlite3.Row
        setups = conn.execute(
            'SELECT id, name, description FROM trading_setups '
            'WHERE enabled = 1 ORDER BY name'
        ).fetchall()
        # Everything in check_library that's a default check applies to
        # every setup; the additional checks are joined via
        # setup_check_assignments.
        default_conditions = [
            row['condition'] for row in conn.execute(
                "SELECT condition FROM check_library "
                "WHERE category = 'default' AND enabled = 1"
            ).fetchall()
        ]
        out = []
        for s in setups:
            extra = conn.execute(
                'SELECT cl.condition FROM setup_check_assignments a '
                'JOIN check_library cl ON cl.id = a.check_id '
                'WHERE a.setup_id = ? AND cl.enabled = 1',
                (s['id'],),
            ).fetchall()
            conditions = default_conditions + [row['condition'] for row in extra]
            from qp.setups import specs_for_checks
            specs = specs_for_checks(
                [{'condition': c} for c in conditions if c]
            )
            out.append({
                'id':          s['id'],
                'name':        s['name'],
                'description': s['description'] or '',
                'specs':       specs,
            })
        return out
    finally:
        conn.close()


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
  #extraRows { display:flex; flex-direction:column; gap:4px;
               background:#1a1e26; border-bottom:1px solid #2a2f3a; }
  #extraRows:empty { display:none; }
  .extraRow { padding:6px 12px; display:flex; gap:10px; align-items:center;
              flex-wrap:wrap; border-top:1px solid #2a2f3a; }
  .extraRow label { font-size:12px; color:#8a94a7; display:flex; align-items:center; gap:4px; }
  .extraRow input, .extraRow select {
    background:#0e1116; color:#eee; border:1px solid #2a2f3a; padding:4px 8px;
    border-radius:4px; font-size:13px;
  }
  .extraRow button { background:#5a2a2a; color:#fff; border:0; padding:4px 10px;
                     border-radius:4px; cursor:pointer; font-size:12px; }
  .extraRow button:hover { background:#8a3a3a; }
  input[type=color] { padding:0; width:26px; height:22px; border:1px solid #2a2f3a;
                      border-radius:4px; background:#0e1116; cursor:pointer; }
  #status { margin-left: auto; color:#8fa; font-size:12px; }
  #main { display:grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 50px); }
  .pane { position: relative; border-right: 1px solid #2a2f3a; overflow: hidden; }
  .pane:last-child { border-right: 0; }
  .pane h3 { position:absolute; top:8px; left:14px; z-index:10; margin:0;
             font-size: 11px; letter-spacing:2px; color:#5fd8a3;
             text-shadow: 0 0 4px rgba(0,0,0,0.8); pointer-events:none; }
  #tv { width:100%; height:100%; }
  #qpWrap { display:flex; flex-direction:column; width:100%; height:100%; }
  #qp    { width:100%; flex: 1 1 auto; min-height: 0; }
  #qpSub { width:100%; flex: 0 0 0;   min-height: 0; display: none;
           border-top: 1px solid #2a2f3a; }
  #qpWrap.hasSub #qp    { flex: 1 1 60%; }
  #qpWrap.hasSub #qpSub { flex: 0 0 40%; display: block; }

  /* Live readout — the box that makes side-by-side comparison actually usable */
  #readout {
    position: absolute; top: 8px; right: 14px; z-index: 10;
    background: rgba(20, 24, 32, 0.92); border: 1px solid #2a3f5a;
    border-radius: 6px; padding: 6px 10px; font-family: ui-monospace, Menlo, monospace;
    font-size: 11px; color: #eee; min-width: 190px; max-width: 240px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  }
  #readout .rHead { display:flex; justify-content:space-between; align-items:center;
                    color:#5fd8a3; font-size:10px; letter-spacing:1.5px;
                    padding-bottom:3px; margin-bottom:3px; border-bottom:1px solid #2a2f3a; }
  #readout .rHead button { background:none; color:#8a94a7; border:0; cursor:pointer;
                           font-size:14px; padding:0 4px; line-height:1; }
  #readout .rHead button:hover { color:#eee; }
  #readoutShow {
    position: absolute; top: 8px; right: 14px; z-index: 12; display: none;
    background: rgba(20, 24, 32, 0.92); color: #eee; border: 1px solid #2a3f5a;
    border-radius: 4px; padding: 3px 10px; cursor: pointer; font-size: 11px;
    letter-spacing: 1px;
  }
  #readoutShow:hover { background: rgba(40, 50, 70, 0.95); }
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
      <option value="alpaca:iex">Alpaca IEX (free tier)</option>
      <option value="alpaca:sip">Alpaca SIP (paid tier)</option>
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
    <select id="ind" onchange="onIndChange()">
      <optgroup label="Moving Averages">
        <option value="ema">EMA</option>
        <option value="sma">SMA</option>
        <option value="rma">RMA (Wilder)</option>
        <option value="wma">WMA</option>
        <option value="hma">HMA (Hull)</option>
        <option value="vwma">VWMA</option>
      </optgroup>
      <optgroup label="Session-anchored SMA">
        <option value="sma_5d">5-Day Rolling SMA (TF-adaptive)</option>
        <option value="sma_5d_pine">5-Day SMA (TV Pine parity: SMA(1950) on 1m)</option>
        <option value="sma_week">Weekly Anchored SMA (Mon)</option>
        <option value="sma_month">Monthly Anchored SMA (1st)</option>
        <option value="sma_quarter">Quarterly Anchored SMA</option>
        <option value="sma_year">Yearly Anchored SMA</option>
      </optgroup>
      <optgroup label="Price Refs">
        <option value="hl2">HL2</option>
        <option value="hlc3">HLC3</option>
        <option value="ohlc4">OHLC4</option>
        <option value="typical_price">Typical Price</option>
        <option value="median_price">Median Price</option>
        <option value="weighted_close">Weighted Close</option>
      </optgroup>
      <optgroup label="Rolling VWAP">
        <option value="vwap">Daily VWAP (TV parity)</option>
        <option value="vwap_2d">2-Day Rolling VWAP</option>
        <option value="vwap_5d">5-Day Rolling VWAP</option>
        <option value="vwap_7d">7-Day Rolling VWAP</option>
        <option value="vwap_30d">30-Day Rolling VWAP</option>
      </optgroup>
      <optgroup label="Anchored VWAP">
        <option value="weekly_vwap">Weekly Anchored VWAP (Mon)</option>
        <option value="monthly_vwap">Monthly Anchored VWAP (1st)</option>
        <option value="quarterly_vwap">Quarterly Anchored VWAP</option>
        <option value="yearly_vwap">Yearly Anchored VWAP</option>
      </optgroup>
      <optgroup label="Envelopes">
        <option value="bollinger">Bollinger Bands (SMA basis)</option>
        <option value="bollinger_ema">Bollinger Bands + 25% Zones (EMA basis)</option>
        <option value="keltner">Keltner Channels</option>
      </optgroup>
      <optgroup label="Event-anchored VWAP">
        <option value="vwap_2d_anchored">2-Day Anchored VWAP (reset every 2 sessions)</option>
        <option value="today_hh_vwap">Today HH-Anchored VWAP</option>
        <option value="today_ll_vwap">Today LL-Anchored VWAP</option>
        <option value="week_hh_vwap">Weekly HH-Anchored VWAP</option>
        <option value="week_ll_vwap">Weekly LL-Anchored VWAP</option>
        <option value="gap_vwap">Gap VWAP (|open − prev close| ≥ mult × ATR)</option>
        <option value="last_hour_ll_vwap">Last-Hour LL VWAP (carries into next day)</option>
        <option value="last_hour_hh_vwap">Last-Hour HH VWAP (carries into next day)</option>
      </optgroup>
      <optgroup label="Volatility (sub-pane)">
        <option value="atr">ATR</option>
        <option value="stdev">StdDev</option>
        <option value="true_range">True Range</option>
      </optgroup>
      <optgroup label="Volume / Reference lines">
        <option value="prev_close">Prev Day Close (horizontal)</option>
        <option value="rvol">Relative Volume (sub-pane, per-minute)</option>
      </optgroup>
      <optgroup label="Oscillators (sub-pane)">
        <option value="rsi">RSI</option>
        <option value="macd">MACD</option>
        <option value="stochastic">Stochastic</option>
        <option value="cci">CCI</option>
      </optgroup>
      <optgroup label="Levels · developing (anchored)">
        <option value="today_hl">Today HH / LL</option>
        <option value="week_hl">Week HH / LL (Mon)</option>
        <option value="month_hl">Month HH / LL (1st)</option>
      </optgroup>
      <optgroup label="Levels · prior period (fixed)">
        <option value="prev_day_hl">Prev Day HH / LL</option>
        <option value="prev_week_hl">Prev Week HH / LL</option>
        <option value="prev_month_hl">Prev Month HH / LL</option>
      </optgroup>
      <optgroup label="Levels · Script-2 reference lines">
        <option value="floor_pivots">Floor Pivots (P / R1-3 / S1-3)</option>
        <option value="overnight_hl">Overnight HH / LL (18:00-09:30 ET)</option>
        <option value="monday_hl">Monday HH / LL (this week)</option>
        <option value="daily_open">Daily Open</option>
        <option value="weekly_open">Weekly Open</option>
        <option value="monthly_open">Monthly Open</option>
        <option value="yearly_open">Yearly Open</option>
        <option value="prev_daily_open">Prev Daily Open</option>
        <option value="prev_weekly_open">Prev Weekly Open</option>
        <option value="prev_monthly_open">Prev Monthly Open</option>
        <option value="prev_yearly_open">Prev Yearly Open</option>
        <option value="dynamic_sr">Dynamic S/R Zones (LonesomeTheBlue)</option>
      </optgroup>
      <optgroup label="Levels · rolling N-day (TF-adaptive)">
        <option value="hl_5d">5-Day Rolling HH / LL</option>
        <option value="hl_20d">20-Day Rolling HH / LL</option>
      </optgroup>
      <option value="none">— none —</option>
    </select>
  </label>
  <label id="lengthLabel">Length <input id="length" type="number" value="9" size="3" min="1" max="500"></label>
  <label id="multLabel" style="display:none">Mult <input id="mult" type="number" value="2" step="0.1" size="3" min="0.1" max="10"></label>
  <label>Color <input id="color0" type="color" value="#f5a623"></label>
  <label>Days <input id="days" type="number" value="5" size="3" min="1" max="60"></label>
  <label>Session
    <select id="session">
      <option value="regular" selected>regular</option>
      <option value="extended">extended</option>
      <option value="all">all</option>
    </select>
  </label>
  <button onclick="addRow()">+ Ind</button>
  <label>Setup
    <select id="setupPicker" onchange="loadSetup()">
      <option value="">— manual —</option>
    </select>
  </label>
  <button onclick="reload()">Reload</button>
  <span id="status"></span>
</div>
<div id="extraRows"></div>
<div id="main">
  <div class="pane"><h3>TRADINGVIEW · ET</h3><div id="tv"></div></div>
  <div class="pane">
    <h3>QP · ET</h3>
    <button id="readoutShow" onclick="toggleReadout(true)">📊 readout</button>
    <div id="readout">
      <div class="rHead">
        <span>READOUT</span>
        <button onclick="toggleReadout(false)" title="Hide">×</button>
      </div>
      <div class="row"><span class="k">Time&nbsp;(ET)</span><span class="v time" id="rTime">—</span></div>
      <div class="row"><span class="k">Close</span><span class="v close" id="rClose">—</span></div>
      <div id="rSeries"></div>
      <div class="row">
        <span class="k">TV value</span>
        <input class="tvinp" id="rTv" type="number" step="0.0001" placeholder="type TV's #">
      </div>
      <div class="row"><span class="k">Diff (qp − TV)</span><span class="v" id="rDiff">—</span></div>
      <div class="hint">hover qp · read TV at same time · type here · diff vs. first qp series</div>
    </div>
    <div id="qpWrap">
      <div id="qp"></div>
      <div id="qpSub"></div>
    </div>
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
  let qpChart = null, priceSeries = null, volumeSeries = null;
  let subChart = null;
  let overlaySerieses = [];   // [{name, color, style, series, byTime: Map}]
  let subSerieses = [];       // same shape
  let tvWidget = null;
  let currentBars = [];
  let closeByTime = new Map();
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

  // Populate the Setup picker from the trade desk DB + the Python qp
  // library. Both come back in the same shape, differentiated by id
  // prefix ("qp:" for library setups). Grouped into optgroups.
  let setupsCache = {};   // id -> { name, specs, source? }
  async function loadSetupList() {
    const sel = document.getElementById('setupPicker');
    // 1) qp library setups (Python).
    try {
      const r = await fetch('/qp-setups');
      if (r.ok) {
        const list = await r.json();
        if (list.length) {
          const og = document.createElement('optgroup');
          og.label = '── qp Setups (Python library) ──';
          for (const s of list) {
            setupsCache[s.id] = s;
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            og.appendChild(opt);
          }
          sel.appendChild(og);
        }
      }
    } catch (_) {}
    // 2) trade desk DB setups.
    try {
      const r = await fetch('/setups');
      if (!r.ok) return;
      const list = await r.json();
      if (!list.length) return;
      const og = document.createElement('optgroup');
      og.label = '── Trade Desk Setups (DB) ──';
      for (const s of list) {
        setupsCache[s.id] = s;
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    } catch (_) {}
  }

  // Apply a setup: clear extra rows, then populate one indicator row per
  // referenced field. Colour cycles through the palette.
  function loadSetup() {
    const id = document.getElementById('setupPicker').value;
    // Clear any previously active qp setup — a manual pick (or a DB
    // setup) shouldn't leave firing markers from the last qp setup.
    window.activeQpSetupId   = null;
    window.activeQpSetupSide = null;
    if (!id) { reload(); return; }            // "— manual —" chosen
    const s = setupsCache[id];
    if (!s || !s.specs || s.specs.length === 0) return;
    // Track the active qp setup so the next reload adds firing markers.
    // Trade Desk DB setups don't have a Python evaluate() to run, so we
    // only mark the qp: ones.
    if (s.source === 'qp') {
      window.activeQpSetupId = id;
      // 'both'-side setups default to 'long' for the marker pass; the
      // user can toggle side via a URL param later if needed.
      window.activeQpSetupSide = (s.side === 'short') ? 'short' : 'long';
    }
    // Clear existing extra rows
    document.getElementById('extraRows').innerHTML = '';
    // First spec goes into row 0; the rest become extra rows
    document.getElementById('ind').value    = s.specs[0].ind;
    document.getElementById('length').value = s.specs[0].length || 9;
    document.getElementById('color0').value = PALETTE[0];
    onIndChange(document.getElementById('ind'));
    for (let i = 1; i < s.specs.length; i++) {
      addRow();
      const rows = document.querySelectorAll('.extraRow');
      const row = rows[rows.length - 1];
      row.querySelector('.indSelect').value  = s.specs[i].ind;
      row.querySelector('.indLength').value  = s.specs[i].length || 9;
      onIndChange(row.querySelector('.indSelect'));
    }
    reload();
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

  function onIndChange(el) {
    if (!el) el = document.getElementById('ind');
    const ind = el.value;
    // Row 0 has label IDs; extra rows use classes scoped to the row.
    if (el.id === 'ind') {
      document.getElementById('lengthLabel').style.display = indUsesLen.has(ind) ? '' : 'none';
      document.getElementById('multLabel').style.display   = indUsesMult.has(ind) ? '' : 'none';
    } else {
      const row = el.closest('.extraRow');
      if (row) {
        row.querySelector('.indLength').parentElement.style.display = indUsesLen.has(ind) ? '' : 'none';
        row.querySelector('.indMult').parentElement.style.display   = indUsesMult.has(ind) ? '' : 'none';
      }
    }
  }

  // ------------------ Multi-indicator rows ---------------------------------
  const PALETTE = ['#7ec7ff','#5fd8a3','#ef5350','#ba9bff','#ffb84d','#ff77c6'];
  let nextColorIdx = 0;

  function addRow() {
    const primary = document.getElementById('ind');
    const color = PALETTE[nextColorIdx++ % PALETTE.length];
    const row = document.createElement('div');
    row.className = 'extraRow';
    row.innerHTML = `
      <label>Ind <select class="indSelect" onchange="onIndChange(this)"></select></label>
      <label>Length <input class="indLength" type="number" value="9" size="3" min="1" max="500"></label>
      <label>Mult <input class="indMult" type="number" value="2" step="0.1" size="3" min="0.1" max="10" style="display:none"></label>
      <label>Color <input class="indColor" type="color" value="${color}"></label>
      <button onclick="this.closest('.extraRow').remove()">× remove</button>
    `;
    // Copy the giant option list from the primary dropdown.
    row.querySelector('.indSelect').innerHTML = primary.innerHTML;
    row.querySelector('.indSelect').value = primary.value;
    document.getElementById('extraRows').appendChild(row);
    onIndChange(row.querySelector('.indSelect'));
  }

  function toggleReadout(show) {
    document.getElementById('readout').style.display     = show ? '' : 'none';
    document.getElementById('readoutShow').style.display = show ? 'none' : 'block';
  }

  function collectSpecs() {
    const specs = [{
      ind:    document.getElementById('ind').value,
      length: parseInt(document.getElementById('length').value),
      mult:   parseFloat(document.getElementById('mult').value),
      color:  document.getElementById('color0').value,
    }];
    for (const row of document.querySelectorAll('.extraRow')) {
      specs.push({
        ind:    row.querySelector('.indSelect').value,
        length: parseInt(row.querySelector('.indLength').value),
        mult:   parseFloat(row.querySelector('.indMult').value),
        color:  row.querySelector('.indColor').value,
      });
    }
    return specs;
  }

  const tvIntervalMap = {'1m':'1','2m':'2','5m':'5','15m':'15','30m':'30','1h':'60','1d':'D'};
  // TradingView study IDs for the free "basicstudies" pack. Where TV has
  // no direct match (Hull, VWMA, price refs, weekly VWAP, etc.), we
  // simply skip loading a TV overlay and rely on the user's own overlay.
  const tvStudyMap = {
    ema:         'MAExp@tv-basicstudies',
    sma:         'MASimple@tv-basicstudies',
    rma:         'MASmoothed@tv-basicstudies',   // SMMA = Wilder = Pine ta.rma
    wma:         'MAWeighted@tv-basicstudies',
    hma:         'HullMA@tv-basicstudies',
    vwma:        'MAVolumeWeighted@tv-basicstudies',
    vwap:        'VWAP@tv-basicstudies',
    bollinger:   'BB@tv-basicstudies',
    keltner:     'KLTNR@tv-basicstudies',
    atr:         'ATR@tv-basicstudies',
    stdev:       'StdDev@tv-basicstudies',
    rsi:         'RSI@tv-basicstudies',
    macd:        'MACD@tv-basicstudies',
    stochastic:  'Stochastic@tv-basicstudies',
    cci:         'CCI@tv-basicstudies',
    // Multi-VWAPs (weekly/monthly/…) and price refs — TV free pack has
    // no dedicated overlay, so we don't request one.
  };
  // Which indicators care about the Mult input.
  const indUsesMult = new Set(['bollinger', 'keltner']);
  // Which indicators care about Length (everything except price refs,
  // multi-VWAPs, macd, true_range, session-adaptive MAs, and 'none').
  const indUsesLen = new Set([
    'ema','sma','rma','wma','hma','vwma',
    'bollinger','keltner','atr','stdev','rsi','stochastic','cci',
  ]);
  // Indicators whose window comes from session-count, not a bar length —
  // Length input hides for these because there's nothing to configure.
  // (kept for reference; the exclusion is already implicit in indUsesLen)

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
  function chartOpts() {
    return {
      layout: { background: {color:'#0e1116'}, textColor:'#c8d0dc' },
      grid:   { vertLines:{color:'#171b23'}, horzLines:{color:'#171b23'} },
      timeScale: {
        timeVisible: true, secondsVisible: false, borderColor:'#2a2f3a',
        tickMarkFormatter: (t) => fmtTickTime(t),
      },
      localization: { timeFormatter: (t) => fmtCrosshairTime(t) },
      rightPriceScale: { borderColor:'#2a2f3a' },
      crosshair: { mode: 1 },
    };
  }

  function makeQP() {
    const el    = document.getElementById('qp');
    const subEl = document.getElementById('qpSub');
    el.innerHTML = ''; subEl.innerHTML = '';

    qpChart = LightweightCharts.createChart(el, chartOpts());
    priceSeries = qpChart.addCandlestickSeries({
      upColor:'#4caf50', downColor:'#ef5350',
      borderUpColor:'#4caf50', borderDownColor:'#ef5350',
      wickUpColor:'#4caf50', wickDownColor:'#ef5350',
    });
    // Squeeze the price scale up so the bottom 22% is free for volume.
    priceSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.05, bottom: 0.22 },
    });
    // Volume histogram — separate 'volume' price scale pinned to the
    // bottom 18% of the chart so its raw numbers (thousands / millions)
    // don't warp the price axis.
    volumeSeries = qpChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      color: 'rgba(95,165,200,0.55)',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    subChart = LightweightCharts.createChart(subEl, chartOpts());

    // Two-way visible-range sync between price and sub panes.
    let syncing = false;
    function sync(from, to) {
      from.timeScale().subscribeVisibleLogicalRangeChange(r => {
        if (syncing || !r) return;
        syncing = true;
        try { to.timeScale().setVisibleLogicalRange(r); } catch (_) {}
        syncing = false;
      });
    }
    sync(qpChart, subChart);
    sync(subChart, qpChart);

    // Crosshair follows across panes; readout updates on either.
    function onMove(p) {
      if (!p || !p.time) { updateReadoutLast(); return; }
      updateReadoutAt(p.time);
    }
    qpChart.subscribeCrosshairMove(onMove);
    subChart.subscribeCrosshairMove(onMove);

    new ResizeObserver(() => {
      qpChart.resize(el.clientWidth, el.clientHeight);
      subChart.resize(subEl.clientWidth, subEl.clientHeight);
    }).observe(document.getElementById('qpWrap'));
  }

  function clearSerieses() {
    for (const s of overlaySerieses) qpChart.removeSeries(s.series);
    for (const s of subSerieses)     subChart.removeSeries(s.series);
    overlaySerieses = [];
    subSerieses = [];
  }

  function addSeriesFrom(meta, target) {
    let s;
    if (meta.style === 'hist') {
      s = target.addHistogramSeries({ color: meta.color });
    } else {
      s = target.addLineSeries({ color: meta.color, lineWidth: 2 });
    }
    s.setData(meta.values);
    const byTime = new Map(meta.values.map(v => [v.time, v.value]));
    return { name: meta.name, color: meta.color, style: meta.style, series: s, byTime };
  }

  // ------------------ Readout box -------------------------------------------
  let currentPrimaryVal = null;  // value of the first qp series at cursor

  function rebuildSeriesRows() {
    const box = document.getElementById('rSeries');
    box.innerHTML = '';
    const all = overlaySerieses.concat(subSerieses);
    for (const s of all) {
      const row = document.createElement('div');
      row.className = 'row';
      const k = document.createElement('span'); k.className = 'k';
      k.textContent = s.name; k.style.color = s.color;
      const v = document.createElement('span'); v.className = 'v';
      v.style.color = s.color;
      v.id = 'rSeries_' + all.indexOf(s);
      v.textContent = '—';
      row.appendChild(k); row.appendChild(v);
      box.appendChild(row);
    }
  }

  function updateReadoutAt(t) {
    const close = closeByTime.get(t);
    document.getElementById('rTime').textContent  = t ? fmtCrosshairTime(t) : '—';
    document.getElementById('rClose').textContent = close != null ? close.toFixed(4) : '—';
    const all = overlaySerieses.concat(subSerieses);
    currentPrimaryVal = null;
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      const v = s.byTime.get(t);
      const el = document.getElementById('rSeries_' + i);
      if (el) el.textContent = v != null ? v.toFixed(4) : '—';
      if (i === 0) currentPrimaryVal = v == null ? null : v;
    }
    updateDiff();
  }

  function updateReadoutLast() {
    if (currentBars.length === 0) { updateReadoutAt(null); return; }
    updateReadoutAt(currentBars[currentBars.length - 1].time);
  }

  function updateDiff() {
    const tvRaw = document.getElementById('rTv').value;
    const el = document.getElementById('rDiff');
    if (tvRaw === '' || currentPrimaryVal == null) {
      el.textContent = '—'; el.classList.remove('match','miss'); return;
    }
    const tv = parseFloat(tvRaw);
    if (isNaN(tv)) {
      el.textContent = '—'; el.classList.remove('match','miss'); return;
    }
    const d = currentPrimaryVal - tv;
    const signed = (d >= 0 ? '+' : '') + d.toFixed(4);
    const tol = Math.max(1e-4, Math.abs(currentPrimaryVal) * 5e-6);
    el.textContent = signed;
    el.classList.toggle('match', Math.abs(d) <= tol);
    el.classList.toggle('miss',  Math.abs(d) >  tol);
  }

  // ------------------ Data load ---------------------------------------------
  async function loadData() {
    const symbol      = document.getElementById('symbol').value.trim().toUpperCase();
    const tf          = document.getElementById('tf').value;
    const days        = document.getElementById('days').value;
    const session     = document.getElementById('session').value;
    const data_source = document.getElementById('source').value;
    const indicators  = collectSpecs();
    document.getElementById('status').textContent = 'loading…';
    let r;
    try {
      r = await fetch(`/data?symbol=${encodeURIComponent(symbol)}&tf=${tf}` +
                      `&days=${days}&session=${session}` +
                      `&data_source=${encodeURIComponent(data_source)}` +
                      `&indicators=${encodeURIComponent(JSON.stringify(indicators))}`);
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
    closeByTime = new Map(currentBars.map(b => [b.time, b.close]));
    priceSeries.setData(currentBars);

    // Volume histogram — tint each bar to match its candle direction.
    volumeSeries.setData(currentBars.map(b => ({
      time:  b.time,
      value: b.volume || 0,
      color: b.close >= b.open ? 'rgba(76,175,80,0.55)' : 'rgba(239,83,80,0.55)',
    })));

    // Session dividers — small green triangle above the first bar of
    // each session so you can see day boundaries at a glance.
    const sessionStarts = j.session_starts || [];
    const markers = sessionStarts.map(t => ({
      time:     t,
      position: 'aboveBar',
      color:    '#5fd8a3',
      shape:    'arrowDown',
      size:     0,
    }));

    // qp setup firing markers — up-arrow below bar for long, down-arrow
    // above bar for short. Skipped when no qp setup is active.
    if (window.activeQpSetupId) {
      try {
        const params = new URLSearchParams({
          setup_id:    window.activeQpSetupId,
          side:        window.activeQpSetupSide || 'long',
          symbol, tf, days, session, data_source,
        });
        const rf = await fetch(`/qp-setup-fire?${params}`);
        if (rf.ok) {
          const jf = await rf.json();
          for (const f of (jf.firings || [])) {
            markers.push(f.side === 'short'
              ? { time: f.time, position: 'aboveBar', color: '#ef5350',
                  shape: 'arrowDown', size: 1, text: 'S' }
              : { time: f.time, position: 'belowBar', color: '#5fd8a3',
                  shape: 'arrowUp',   size: 1, text: 'L' });
          }
        }
      } catch (e) {}
    }
    // Sort by time — lightweight-charts requires markers ordered
    // ascending or it drops the ones out of order.
    markers.sort((a, b) => a.time - b.time);
    priceSeries.setMarkers(markers);

    // Rebuild overlay + sub-pane series from scratch each reload.
    clearSerieses();
    const wrap = document.getElementById('qpWrap');
    let hasSub = false;
    for (const meta of (j.series || [])) {
      if (meta.pane === 'sub') {
        subSerieses.push(addSeriesFrom(meta, subChart));
        hasSub = true;
      } else {
        overlaySerieses.push(addSeriesFrom(meta, qpChart));
      }
    }
    wrap.classList.toggle('hasSub', hasSub);
    // Time axis at the bottom: on the sub-chart when it exists, else on the
    // price chart. Avoids the doubled-up axis in the middle when both are
    // visible, and always leaves the reader with a time strip at the bottom.
    qpChart.applyOptions({ timeScale: { visible: !hasSub } });
    subChart.applyOptions({ timeScale: { visible: hasSub  } });
    // Give the DOM a frame to apply the flex-basis change, then resize.
    requestAnimationFrame(() => {
      const el = document.getElementById('qp');
      const sub = document.getElementById('qpSub');
      qpChart.resize(el.clientWidth, el.clientHeight);
      subChart.resize(sub.clientWidth, sub.clientHeight);
    });

    rebuildSeriesRows();
    qpChart.timeScale().fitContent();
    if (hasSub) subChart.timeScale().fitContent();
    updateReadoutLast();
    syncTVRange();

    document.getElementById('status').textContent =
      `${currentBars.length} bars · ${j.first || ''} → ${j.last || ''} (ET) · ` +
      `${(j.series || []).length} qp series`;
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
    await loadSetupList();
    onIndChange();
    reload();
  });
</script></body></html>
"""


def _to_series(name, pane, color, values, ts, style='line'):
    """Pack a numpy series into the JSON shape the UI expects.
    `pane` is 'overlay' (price chart) or 'sub' (oscillator pane below).
    `style` is 'line' (default) or 'hist' (rendered as coloured bars).
    """
    out = []
    for t, v in zip(ts, values):
        fv = float(v)
        if fv == fv:  # skip NaN
            out.append({'time': int(t), 'value': fv})
    return {'name': name, 'pane': pane, 'color': color, 'style': style, 'values': out}


def _load_bars_df(symbol: str, tf: str, days: int, session: str,
                  data_source: str):
    """Load bars in the same way compute_series does; returns a bars
    object (with .df) or None if the load produced no rows. Extracted
    so the firings endpoint reuses the exact same loader."""
    if data_source.startswith('csv:'):
        csv_name = data_source[4:]
        csv_path = (CSV_DIR / csv_name).resolve()
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
        return load(
            symbol=symbol or csv_path.stem, timeframe=tf,
            start=start, end=end, source=f'csv:{csv_path}',
            session=None if session == 'all' else session,
        )
    end = pd.Timestamp.now(tz='UTC')
    if data_source == 'yahoo' and tf == '1m':
        days = min(int(days), 7)
    start = end - pd.Timedelta(days=days)
    start = start.floor('5min')
    end = end.floor('5min')
    source_arg = 'yahoo' if data_source == 'yahoo' else data_source
    return load(
        symbol, timeframe=tf, start=start, end=end, source=source_arg,
        cache_dir=CACHE_DIR if data_source == 'yahoo' else None,
        session=None if session == 'all' else session,
    )


def compute_qp_setup_firings(setup_id: str, side: str,
                             symbol: str, tf: str, days: int,
                             session: str, data_source: str) -> list[dict]:
    """Run a qp library setup's evaluate() over the current bars window
    and return a list of firing bar timestamps (Unix seconds, ET side)."""
    from qp.setups.library import get_setup
    if not setup_id.startswith('qp:'):
        raise ValueError(f'expected qp: prefix on {setup_id!r}')
    mod = get_setup(setup_id[3:])
    bars = _load_bars_df(symbol, tf, days, session, data_source)
    if bars is None or len(bars) == 0:
        return []
    df = bars.df
    side_norm = 'long' if side not in ('long', 'short') else side
    # evaluate() signatures accept `side=...` for 'both' setups, ignore
    # otherwise. Try with side first; if it's unknown to the setup, retry
    # without so long-only / short-only setups still work.
    try:
        mask = mod.evaluate(df, side=side_norm)
    except TypeError:
        mask = mod.evaluate(df)
    ts = (df.index.view('int64') // 1_000_000_000).tolist()
    return [{'time': int(t), 'side': side_norm}
            for t, fired in zip(ts, mask) if bool(fired)]


def compute_series(symbol: str, tf: str, ind: str, length: int, days: int,
                   session: str, data_source: str = 'yahoo',
                   mult: float = 2.0):
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
        # Yahoo 1m maxes out at ~7 calendar days; anything beyond returns
        # 422. Silently clamp so the UI doesn't need to know.
        if data_source == 'yahoo' and tf == '1m':
            days = min(int(days), 7)
        start = end - pd.Timedelta(days=days)
        # Bucket window to nearest 5 minutes so identical requests hit the
        # cache instead of thrashing Yahoo (which rate-limits AWS IPs).
        start = start.floor('5min')
        end = end.floor('5min')
        # Route to whichever adapter the UI asked for. 'alpaca' uses env
        # creds; 'alpaca:sip' picks the paid consolidated tape.
        source_arg = 'yahoo' if data_source == 'yahoo' else data_source
        bars = load(
            symbol,
            timeframe=tf,
            start=start,
            end=end,
            source=source_arg,
            cache_dir=CACHE_DIR if data_source == 'yahoo' else None,
            session=None if session == 'all' else session,
        )
    if len(bars) == 0:
        return {'bars': [], 'series': [], 'session_starts': [], 'first': None, 'last': None}

    df = bars.df
    ts = (df.index.view('int64') // 1_000_000_000).tolist()
    bar_list = [
        {'time': int(t), 'open': float(o), 'high': float(h),
         'low': float(l), 'close': float(c), 'volume': float(v)}
        for t, o, h, l, c, v in zip(ts, df['open'], df['high'], df['low'],
                                    df['close'], df['volume'])
    ]

    # Session-start timestamps — bars where the RTH session opens (Mon 09:30,
    # Tue 09:30, …). Client draws dividers at these times.
    from qp.vwap.sessional import _new_session_mask
    from qp.session import US_EQUITIES
    _session_mask = _new_session_mask(df, US_EQUITIES)
    session_starts_ts = [int(t) for t, m in zip(ts, _session_mask) if m]

    C = df['close'].to_numpy()
    V = df['volume'].to_numpy()
    ORANGE = '#f5a623'
    BLUE   = '#7ec7ff'
    GREEN  = '#5fd8a3'
    RED    = '#ef5350'

    series_out = []
    if ind == 'none':
        pass

    # ── Moving averages (overlay, single line) ────────────────────────────
    elif ind == 'ema':
        series_out.append(_to_series(f'EMA({length})', 'overlay', ORANGE, ema(C, length), ts))
    elif ind == 'sma':
        series_out.append(_to_series(f'SMA({length})', 'overlay', ORANGE, sma(C, length), ts))
    elif ind == 'rma':
        series_out.append(_to_series(f'RMA({length})', 'overlay', ORANGE, rma(C, length), ts))
    elif ind == 'wma':
        series_out.append(_to_series(f'WMA({length})', 'overlay', ORANGE, wma(C, length), ts))
    elif ind == 'hma':
        series_out.append(_to_series(f'HMA({length})', 'overlay', ORANGE, hma(C, length), ts))
    elif ind == 'vwma':
        series_out.append(_to_series(f'VWMA({length})', 'overlay', ORANGE, vwma(C, V, length), ts))
    elif ind == 'sma_5d':
        # 5-session rolling SMA. Window adapts to timeframe: ~78 bars/session
        # on 5m → 390-bar mean; ~390 bars/session on 1m → 1950-bar mean; on
        # daily → 5-bar mean. No length parameter — user does not specify it.
        series_out.append(_to_series('5-Day Rolling SMA', 'overlay', ORANGE,
                                     n_session_sma(df, 5), ts))
    elif ind == 'sma_5d_pine':
        # TradingView Pine parity: SMA(1950) on 1-minute closes, projected
        # onto the display bars. Same number on 1m / 5m / 15m / 1h chart.
        # Requires a source that provides 1-minute history — Alpaca has no
        # cap, Yahoo caps 1m at ~7 days (enough for warm-up + small window).
        end_1m = df.index[-1]
        # Need at least ~1950 1-min RTH bars (5 sessions) for warm-up plus
        # the display window's worth. Fetch generously; the SMA cost is O(n).
        start_1m = end_1m - pd.Timedelta(days=max(int(days) + 6, 10))
        bars_1m = load(
            symbol,
            timeframe='1m',
            start=start_1m,
            end=end_1m,
            source=source_arg if data_source != 'yahoo' else 'yahoo',
            session=None if session == 'all' else session,
        )
        display_ts = np.array(ts, dtype='int64')
        y = pine_5day_sma(bars_1m.df, display_ts)
        series_out.append(_to_series('5-Day SMA (TV Pine parity)',
                                     'overlay', ORANGE, y, ts))
    # Anchored SMAs — cumulative mean of closes since the anchor. Match
    # the reset points of the anchored VWAPs of the same name.
    elif ind == 'sma_week':
        series_out.append(_to_series('Weekly Anchored SMA (Mon)', 'overlay', ORANGE,
                                     weekly_sma(df), ts))
    elif ind == 'sma_month':
        series_out.append(_to_series('Monthly Anchored SMA (1st)', 'overlay', ORANGE,
                                     monthly_sma(df), ts))
    elif ind == 'sma_quarter':
        series_out.append(_to_series('Quarterly Anchored SMA', 'overlay', ORANGE,
                                     quarterly_sma(df), ts))
    elif ind == 'sma_year':
        series_out.append(_to_series('Yearly Anchored SMA', 'overlay', ORANGE,
                                     yearly_sma(df), ts))

    # ── Price references (overlay, single line) ───────────────────────────
    elif ind == 'hl2':
        series_out.append(_to_series('HL2', 'overlay', ORANGE, hl2(df), ts))
    elif ind == 'hlc3':
        series_out.append(_to_series('HLC3', 'overlay', ORANGE, hlc3(df), ts))
    elif ind == 'ohlc4':
        series_out.append(_to_series('OHLC4', 'overlay', ORANGE, ohlc4(df), ts))
    elif ind == 'typical_price':
        series_out.append(_to_series('Typical', 'overlay', ORANGE, typical_price(df), ts))
    elif ind == 'median_price':
        series_out.append(_to_series('Median', 'overlay', ORANGE, median_price(df), ts))
    elif ind == 'weighted_close':
        series_out.append(_to_series('Wt Close', 'overlay', ORANGE, weighted_close(df), ts))

    # ── VWAP flavours (overlay, single line) ──────────────────────────────
    # Daily VWAP == TradingView's built-in "VWAP" study: resets at each
    # session open (spec.regular_open — 09:30 ET for US equities).
    elif ind == 'vwap':
        series_out.append(_to_series('Daily VWAP', 'overlay', ORANGE,
                                     np.asarray(session_vwap(df)), ts))
    # Rolling N-session VWAPs — reset every N sessions, all anchored at
    # session opens so premarket bars carry the previous accumulator.
    elif ind == 'vwap_2d':
        series_out.append(_to_series('2-Day Rolling VWAP', 'overlay', ORANGE,
                                     np.asarray(rolling_n_day_vwap(df, 2)), ts))
    elif ind == 'vwap_5d':
        series_out.append(_to_series('5-Day Rolling VWAP', 'overlay', ORANGE,
                                     np.asarray(rolling_n_day_vwap(df, 5)), ts))
    elif ind == 'vwap_7d':
        series_out.append(_to_series('7-Day Rolling VWAP', 'overlay', ORANGE,
                                     np.asarray(rolling_n_day_vwap(df, 7)), ts))
    elif ind == 'vwap_30d':
        series_out.append(_to_series('30-Day Rolling VWAP', 'overlay', ORANGE,
                                     np.asarray(rolling_n_day_vwap(df, 30)), ts))
    elif ind == 'weekly_vwap':
        series_out.append(_to_series('Weekly VWAP', 'overlay', ORANGE,
                                     np.asarray(weekly_vwap(df)), ts))
    elif ind == 'monthly_vwap':
        series_out.append(_to_series('Monthly VWAP', 'overlay', ORANGE,
                                     np.asarray(monthly_vwap(df)), ts))
    elif ind == 'quarterly_vwap':
        series_out.append(_to_series('Quarterly VWAP', 'overlay', ORANGE,
                                     np.asarray(quarterly_vwap(df)), ts))
    elif ind == 'yearly_vwap':
        series_out.append(_to_series('Yearly VWAP', 'overlay', ORANGE,
                                     np.asarray(yearly_vwap(df)), ts))

    # ── Envelopes (overlay, multi-line) ───────────────────────────────────
    elif ind == 'bollinger':
        bb = bollinger(C, length, mult)
        series_out.append(_to_series(f'BB Basis({length})', 'overlay', ORANGE, bb.basis, ts))
        series_out.append(_to_series('BB Upper', 'overlay', BLUE, bb.upper, ts))
        series_out.append(_to_series('BB Lower', 'overlay', BLUE, bb.lower, ts))
    elif ind == 'bollinger_ema':
        # EMA-based BB with 25% zones (Pine L3 script parity)
        bbz = bollinger_ema(C, length, mult, zone_pct=25.0)
        series_out.append(_to_series(f'BB-EMA Basis({length})', 'overlay', ORANGE, bbz.basis, ts))
        series_out.append(_to_series('BB-EMA Upper', 'overlay', BLUE, bbz.upper, ts))
        series_out.append(_to_series('BB-EMA Lower', 'overlay', BLUE, bbz.lower, ts))
        series_out.append(_to_series('Top Zone 25% (bot)', 'overlay', GREEN, bbz.top_zone_bot, ts))
        series_out.append(_to_series('Bot Zone 25% (top)', 'overlay', RED,   bbz.bot_zone_top, ts))
    elif ind == 'keltner':
        kc = keltner(df, length, mult)
        series_out.append(_to_series(f'KC Basis({length})', 'overlay', ORANGE, kc.basis, ts))
        series_out.append(_to_series('KC Upper', 'overlay', BLUE, kc.upper, ts))
        series_out.append(_to_series('KC Lower', 'overlay', BLUE, kc.lower, ts))

    # ── Volatility (sub-pane, single) ─────────────────────────────────────
    elif ind == 'atr':
        series_out.append(_to_series(f'ATR({length})', 'sub', ORANGE, atr(df, length), ts))
    elif ind == 'stdev':
        series_out.append(_to_series(f'StdDev({length})', 'sub', ORANGE, stdev(C, length), ts))
    elif ind == 'true_range':
        series_out.append(_to_series('True Range', 'sub', ORANGE, true_range(df), ts))

    # ── Prev-day close (overlay, horizontal step per session) ─────────────
    elif ind == 'prev_close':
        # For each session in df, prev_close = last close of the prior session.
        # First session has no prior → NaN, filtered out by _to_series.
        idx_local = df.index.tz_convert('America/New_York')
        session_dates = idx_local.date
        last_by_date = pd.Series(C, index=session_dates).groupby(level=0).last()
        prev_close_map = last_by_date.shift(1)
        pc_values = np.array([prev_close_map.get(d, np.nan) for d in session_dates])
        series_out.append(_to_series('Prev Day Close', 'overlay', BLUE, pc_values, ts))

    # ── Relative volume (sub-pane, per-minute baseline) ───────────────────
    elif ind == 'rvol':
        # Baseline = mean volume at that minute-of-day across the N most
        # recent prior sessions in the loaded window. Length = N (default 10).
        n_sessions = max(int(length or 10), 5)
        idx_local = df.index.tz_convert('America/New_York')
        session_dates = pd.Series(idx_local.date, index=df.index)
        minutes = pd.Series(idx_local.strftime('%H:%M'), index=df.index)
        # (date, minute) → volume for that bar, then average across dates
        # in a rolling per-minute window keyed by session-position.
        vol = pd.Series(V, index=df.index)
        by_key = vol.groupby([session_dates, minutes]).mean()
        # Index of session dates in appearance order.
        unique_dates = list(session_dates.drop_duplicates())
        date_pos = {d: i for i, d in enumerate(unique_dates)}
        # Build (minute → sorted date list, sorted vol list) once.
        minute_baseline = {}
        for (d, m), v in by_key.items():
            minute_baseline.setdefault(m, []).append((date_pos[d], float(v)))
        for m in minute_baseline:
            minute_baseline[m].sort(key=lambda x: x[0])
        rvol_out = np.full(len(df), np.nan)
        for i in range(len(df)):
            d = session_dates.iloc[i]
            m = minutes.iloc[i]
            pos = date_pos[d]
            entries = minute_baseline.get(m, [])
            prior_vols = [v for (p, v) in entries if p < pos][-n_sessions:]
            if not prior_vols:
                continue
            base_mean = sum(prior_vols) / len(prior_vols)
            if base_mean > 0:
                rvol_out[i] = float(V[i]) / base_mean
        series_out.append(_to_series('rvol', 'sub', ORANGE, rvol_out, ts, style='hist'))

    # ── Oscillators (sub-pane, single or multi) ───────────────────────────
    elif ind == 'rsi':
        series_out.append(_to_series(f'RSI({length})', 'sub', ORANGE, rsi(C, length), ts))
    elif ind == 'macd':
        m = macd(C)
        series_out.append(_to_series('MACD', 'sub', ORANGE, m.macd, ts))
        series_out.append(_to_series('Signal', 'sub', BLUE, m.signal, ts))
        series_out.append(_to_series('Hist', 'sub', GREEN, m.hist, ts, style='hist'))
    elif ind == 'stochastic':
        s = stochastic(df, length)
        series_out.append(_to_series('%K', 'sub', ORANGE, s.k, ts))
        series_out.append(_to_series('%D', 'sub', BLUE, s.d, ts))
    elif ind == 'cci':
        series_out.append(_to_series(f'CCI({length})', 'sub', ORANGE, cci(df, length), ts))

    # ── Levels: developing HH/LL (anchored, running) ──────────────────────
    elif ind == 'today_hl':
        series_out.append(_to_series('Today HH', 'overlay', GREEN, today_high(df), ts))
        series_out.append(_to_series('Today LL', 'overlay', RED,   today_low(df),  ts))
    elif ind == 'day_high':
        series_out.append(_to_series('Today HH', 'overlay', GREEN, today_high(df), ts))
    elif ind == 'day_low':
        series_out.append(_to_series('Today LL', 'overlay', RED,   today_low(df),  ts))
    elif ind == 'pm_high':
        from qp.levels import premarket_high
        series_out.append(_to_series('Premarket High', 'overlay', GREEN, premarket_high(df), ts))
    elif ind == 'pm_low':
        from qp.levels import premarket_low
        series_out.append(_to_series('Premarket Low', 'overlay', RED, premarket_low(df), ts))
    elif ind == 'week_hl':
        series_out.append(_to_series('Week HH (Mon)', 'overlay', GREEN, week_high(df), ts))
        series_out.append(_to_series('Week LL (Mon)', 'overlay', RED,   week_low(df),  ts))
    elif ind == 'month_hl':
        series_out.append(_to_series('Month HH (1st)', 'overlay', GREEN, month_high(df), ts))
        series_out.append(_to_series('Month LL (1st)', 'overlay', RED,   month_low(df),  ts))

    # ── Levels: prior-period HH/LL (fixed, from completed periods) ────────
    elif ind == 'prev_day_hl':
        series_out.append(_to_series('Prev Day HH', 'overlay', GREEN, prev_day_high(df), ts))
        series_out.append(_to_series('Prev Day LL', 'overlay', RED,   prev_day_low(df),  ts))
    elif ind == 'prev_week_hl':
        series_out.append(_to_series('Prev Week HH', 'overlay', GREEN, prev_week_high(df), ts))
        series_out.append(_to_series('Prev Week LL', 'overlay', RED,   prev_week_low(df),  ts))
    elif ind == 'prev_month_hl':
        series_out.append(_to_series('Prev Month HH', 'overlay', GREEN, prev_month_high(df), ts))
        series_out.append(_to_series('Prev Month LL', 'overlay', RED,   prev_month_low(df),  ts))

    # ── Levels: rolling N-day HH/LL (TF-adaptive sliding window) ──────────
    elif ind == 'hl_5d':
        series_out.append(_to_series('5-Day Rolling HH', 'overlay', GREEN,
                                     rolling_n_day_high(df, 5), ts))
        series_out.append(_to_series('5-Day Rolling LL', 'overlay', RED,
                                     rolling_n_day_low(df, 5), ts))
    elif ind == 'hl_20d':
        series_out.append(_to_series('20-Day Rolling HH', 'overlay', GREEN,
                                     rolling_n_day_high(df, 20), ts))
        series_out.append(_to_series('20-Day Rolling LL', 'overlay', RED,
                                     rolling_n_day_low(df, 20), ts))

    # ── Levels: Script-2 reference lines ──────────────────────────────────
    elif ind == 'floor_pivots':
        from qp.levels import floor_pivots
        fp = floor_pivots(df)
        series_out.append(_to_series('Pivot P',  'overlay', ORANGE, fp.P,  ts))
        series_out.append(_to_series('R1', 'overlay', RED,    fp.R1, ts))
        series_out.append(_to_series('R2', 'overlay', RED,    fp.R2, ts))
        series_out.append(_to_series('R3', 'overlay', RED,    fp.R3, ts))
        series_out.append(_to_series('S1', 'overlay', GREEN,  fp.S1, ts))
        series_out.append(_to_series('S2', 'overlay', GREEN,  fp.S2, ts))
        series_out.append(_to_series('S3', 'overlay', GREEN,  fp.S3, ts))
    elif ind == 'overnight_hl':
        from qp.levels import overnight_high, overnight_low
        series_out.append(_to_series('Overnight HH', 'overlay', BLUE,
                                     overnight_high(df), ts))
        series_out.append(_to_series('Overnight LL', 'overlay', ORANGE,
                                     overnight_low(df),  ts))
    elif ind == 'monday_hl':
        from qp.levels import monday_high, monday_low
        series_out.append(_to_series('Monday HH', 'overlay', GREEN,
                                     monday_high(df), ts))
        series_out.append(_to_series('Monday LL', 'overlay', RED,
                                     monday_low(df),  ts))
    elif ind == 'daily_open':
        from qp.levels import daily_open
        series_out.append(_to_series('Daily Open', 'overlay', GREEN, daily_open(df), ts))
    elif ind == 'weekly_open':
        from qp.levels import weekly_open
        series_out.append(_to_series('Weekly Open', 'overlay', ORANGE, weekly_open(df), ts))
    elif ind == 'monthly_open':
        from qp.levels import monthly_open
        series_out.append(_to_series('Monthly Open', 'overlay', RED, monthly_open(df), ts))
    elif ind == 'yearly_open':
        from qp.levels import yearly_open
        series_out.append(_to_series('Yearly Open', 'overlay', BLUE, yearly_open(df), ts))
    elif ind == 'prev_daily_open':
        from qp.levels import prev_daily_open
        series_out.append(_to_series('Prev Daily Open', 'overlay', GREEN, prev_daily_open(df), ts))
    elif ind == 'prev_weekly_open':
        from qp.levels import prev_weekly_open
        series_out.append(_to_series('Prev Weekly Open', 'overlay', ORANGE, prev_weekly_open(df), ts))
    elif ind == 'prev_monthly_open':
        from qp.levels import prev_monthly_open
        series_out.append(_to_series('Prev Monthly Open', 'overlay', RED, prev_monthly_open(df), ts))
    elif ind == 'prev_yearly_open':
        from qp.levels import prev_yearly_open
        series_out.append(_to_series('Prev Yearly Open', 'overlay', BLUE, prev_yearly_open(df), ts))
    elif ind == 'dynamic_sr':
        from qp.levels import dynamic_sr_zones
        zones = dynamic_sr_zones(df, prd=10, max_zones=6)
        for i, z in enumerate(zones):
            # Color: above close (last bar) → resistance red; below → support green.
            last = df['close'].iloc[-1]
            zmid = z[-1] if np.isfinite(z[-1]) else None
            col = RED if (zmid is not None and zmid >= last) else GREEN
            series_out.append(_to_series(f'S/R Zone {i+1}', 'overlay', col, z, ts))

    # ── Event-anchored VWAPs (Pine "VWAP Cluster Bounce" parity) ──────────
    elif ind == 'vwap_2d_anchored':
        # Reset every 2 sessions at session open (Pine ta.vwap with a
        # dCount % 2 == 0 gate). Distinct from the ROLLING 2-day variant.
        series_out.append(_to_series('2-Day Anchored VWAP', 'overlay', ORANGE,
                                     np.asarray(n_day_vwap(df, 2)), ts))
    elif ind == 'today_hh_vwap':
        series_out.append(_to_series('Today HH-Anchored VWAP', 'overlay', GREEN,
                                     today_hh_vwap(df), ts))
    elif ind == 'today_ll_vwap':
        series_out.append(_to_series('Today LL-Anchored VWAP', 'overlay', RED,
                                     today_ll_vwap(df), ts))
    elif ind == 'week_hh_vwap':
        series_out.append(_to_series('Weekly HH-Anchored VWAP', 'overlay', GREEN,
                                     week_hh_vwap(df), ts))
    elif ind == 'week_ll_vwap':
        series_out.append(_to_series('Weekly LL-Anchored VWAP', 'overlay', RED,
                                     week_ll_vwap(df), ts))
    elif ind == 'gap_vwap':
        # Anchors on any bar where |open - prev_close| >= mult × ATR(length).
        series_out.append(_to_series(f'Gap VWAP (ATR{length}×{mult})', 'overlay',
                                     ORANGE, gap_vwap(df, length, mult), ts))
    elif ind == 'last_hour_ll_vwap':
        # Anchor = previous day's last-hour LL bar's (price × volume).
        series_out.append(_to_series('Last-Hour LL VWAP', 'overlay', RED,
                                     last_hour_ll_vwap(df, 15), ts))
    elif ind == 'last_hour_hh_vwap':
        series_out.append(_to_series('Last-Hour HH VWAP', 'overlay', GREEN,
                                     last_hour_hh_vwap(df, 15), ts))

    else:
        raise ValueError(f'unknown indicator {ind!r}')

    return {
        'bars':           bar_list,
        'series':         series_out,
        'session_starts': session_starts_ts,
        'first':          df.index[0].strftime('%Y-%m-%d %H:%M'),
        'last':           df.index[-1].strftime('%Y-%m-%d %H:%M'),
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
                # Accept an `indicators` JSON array (multi-indicator UI) or
                # fall back to the legacy single-indicator params.
                indicators_raw = q.get('indicators')
                if indicators_raw:
                    indicators = json.loads(indicators_raw)
                else:
                    indicators = [{
                        'ind':    q.get('ind', 'ema'),
                        'length': int(q.get('length', 9)),
                        'mult':   float(q.get('mult', 2.0)),
                        'color':  None,
                    }]
                merged = None
                for spec in indicators:
                    part = compute_series(
                        symbol=q.get('symbol', 'SPY'),
                        tf=q.get('tf', '5m'),
                        ind=str(spec.get('ind', 'ema')),
                        length=int(spec.get('length', 9)),
                        days=int(q.get('days', 5)),
                        session=q.get('session', 'regular'),
                        data_source=q.get('data_source', 'yahoo'),
                        mult=float(spec.get('mult', 2.0)),
                    )
                    # Override the PRIMARY series colour if the user picked one.
                    override = spec.get('color')
                    if override and part.get('series'):
                        part['series'][0]['color'] = override
                    if merged is None:
                        merged = part
                    else:
                        merged['series'].extend(part['series'])
                if merged is None:
                    merged = {'bars': [], 'series': [], 'session_starts': [],
                              'first': None, 'last': None}
                self._send(200, json.dumps(merged).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        if u.path == '/sources':
            try:
                self._send(200, json.dumps(list_csv_files()).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        if u.path == '/setups':
            try:
                self._send(200, json.dumps(list_setups()).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        if u.path == '/qp-setups':
            try:
                self._send(200, json.dumps(list_qp_setups()).encode('utf-8'))
            except Exception as e:
                self._send(500, str(e).encode('utf-8'), 'text/plain')
            return
        if u.path == '/qp-setup-fire':
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                setup_id = q.get('setup_id', '')
                if not setup_id:
                    self._send(400, b'setup_id required', 'text/plain')
                    return
                firings = compute_qp_setup_firings(
                    setup_id=setup_id,
                    side=q.get('side', 'long'),
                    symbol=q.get('symbol', 'SPY'),
                    tf=q.get('tf', '5m'),
                    days=int(q.get('days', 5)),
                    session=q.get('session', 'regular'),
                    data_source=q.get('data_source', 'yahoo'),
                )
                self._send(200, json.dumps({'firings': firings}).encode('utf-8'))
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
