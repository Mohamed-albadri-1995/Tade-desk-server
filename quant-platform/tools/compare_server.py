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
from tools.data import alpaca, polygon, hybrid, yahoo

# Data feeds the compare tool can pull bars from. Each module exposes the
# same load(symbol, tf, start, end) → tz-aware UTC OHLCV DataFrame.
#
# This list and chart/data_manager.LOADERS are BOTH consulted — data_manager
# for the chart's own fetches, this one for everything that goes through
# prepare_bars(), which is what strategy.evaluate() uses. Registering a feed in
# one and not the other gets you "unknown feed 'yahoo'" from the half you
# forgot, which is exactly how yahoo shipped the first time.
_LOADERS = {'alpaca': alpaca, 'polygon': polygon, 'hybrid': hybrid,
            'yahoo': yahoo}


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


_FEED_PREF = Path(__file__).resolve().parents[1] / '.default-feed'
_VALID_FEEDS = ('yahoo', 'alpaca', 'polygon', 'hybrid')


def default_feed_override() -> str:
    """The default somebody CHOSE, or '' if nobody has.

    A file rather than an env var so it can be changed from a page without a
    restart, and so the choice survives one.
    """
    try:
        v = _FEED_PREF.read_text(encoding='utf-8').strip().lower()
        return v if v in _VALID_FEEDS else ''
    except Exception:
        return ''


def set_default_feed(feed: str) -> str:
    """Choose the default. Refused unless it is a feed that exists."""
    v = str(feed or '').strip().lower()
    if v not in _VALID_FEEDS:
        raise ValueError(f'unknown feed {v!r} — one of {", ".join(_VALID_FEEDS)}')
    _FEED_PREF.write_text(v, encoding='utf-8')
    return v


def _feed_status() -> dict:
    """Which feeds have credentials configured, and the preferred default.

    'hybrid' (Polygon history + Alpaca live gap-fill) needs both.

    POLYGON IS NO LONGER PREFERRED ON SIGHT OF A KEY, and that is a correction
    paid for in a live session. A key being PRESENT is not evidence that the
    plan behind it includes the data being asked for:

        Polygon 403: {"status":"NOT_AUTHORIZED","message":"Your plan doesn't
        include this data timeframe. Please upgrade your plan"}

    Every 1-minute request failed while the inventory reported polygon as the
    best feed available, so the default pointed at the one feed that could not
    answer the question this platform exists to answer.

    Nothing here can test a plan's entitlements without spending a request on
    every startup, so it no longer guesses: yahoo unless somebody has CHOSEN
    otherwise. Delayed data that arrives beats deeper data that 403s, and the
    choice is one control away.

    YAHOO NEEDS NO KEY, which is why it was missing here and why that mattered.
    chart/data_manager.py has carried it as a real feed all along; this
    function, the one place that says which feeds EXIST, simply never
    mentioned it. On a box with no keys the answer was therefore "alpaca,
    polygon, hybrid — all false, default alpaca": three feeds that cannot
    work, and a default pointing at one of them. The page set its dropdown to
    a value it had no option for, which renders blank and posts an empty
    string, and the error read `unknown feed ''` while listing yahoo among the
    ones it knew. The feed was never the problem; the inventory was.

    So yahoo is always available, and it is the default when nothing else is
    configured — a chart with delayed data beats a chart with none.
    """
    has_alpaca  = bool(os.environ.get('APCA_API_KEY_ID') and os.environ.get('APCA_API_SECRET_KEY'))
    has_polygon = bool(os.environ.get('POLYGON_API_KEY'))
    have = {
        # No credential to check — if the process has a network it has yahoo.
        'yahoo':   True,
        'alpaca':  has_alpaca,
        'polygon': has_polygon,
        'hybrid':  has_alpaca and has_polygon,
    }
    # A chosen default wins, and only if that feed is actually configured —
    # otherwise the page would again point at something that cannot answer.
    chosen = default_feed_override()
    default = chosen if (chosen and have.get(chosen)) else 'yahoo'
    return {'feeds': have, 'default_feed': default,
            # Which of the two this is, so a page can say "chosen" vs "fallback"
            # rather than presenting a guess as a decision.
            'default_chosen': bool(chosen and have.get(chosen))}


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


def _chart_js_version() -> str:
    """Version string of the cached chart library, or '' if not cached."""
    try:
        head = _CHART_JS.read_bytes()[:600].decode('latin-1')
        import re as _re
        m = _re.search(r'Lightweight Charts[^\n]*?v(\d+\.\d+\.\d+)', head)
        return m.group(1) if m else 'unknown'
    except Exception:
        return ''


def _ensure_chart_js() -> bool:
    """Download the chart library once, cache under tools/.static/. Return
    True on success. If every mirror fails we fall back to a CDN reference
    in the HTML (which will only work if the browser can reach one)."""
    # Re-download if the cached file isn't the pinned v4 line. tools/.static
    # is gitignored, so an old cache (e.g. a v5 downloaded before the version
    # was pinned) would otherwise persist forever across git pulls — and v5's
    # series API differs enough that overlay lines silently fail to draw while
    # candles still work. Force a fresh v4.x copy.
    if _CHART_JS.exists() and _CHART_JS.stat().st_size > 10_000:
        ver = _chart_js_version()
        if ver.startswith('4.'):
            return True
        print(f'[qp] cached chart lib is v{ver or "?"} (want 4.x) — re-downloading',
              file=sys.stderr)
        try:
            _CHART_JS.unlink()
        except Exception:
            pass
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


# Warm-up history (extra calendar days) fetched for fixed-timeframe
# primitives, so e.g. atr_daily(14) has ~140 daily bars and pine_5day has
# its 1950 one-minute bars BEFORE the first visible bar — the line then
# covers the whole visible range at any Days setting.
_COMPUTE_TF_WARMUP_DAYS = {'1m': 15, '2m': 20, '5m': 30, '15m': 45, '30m': 60,
                           '1h': 90, '1d': 200}

# Cap on how many recent pivot events get verification markers — keeps the
# chart readable when a long range has dozens of pivots.
_MAX_MARKED_EVENTS = 14


def _series_markers(m, kwargs, arr, ts, bars: pd.DataFrame) -> list:
    """Verification markers that make the primitive's REFERENCE POINTS
    visible on the chart, so an eyeball check has all the pieces:

    - structure.pivot_high / pivot_low: for each confirmed pivot, mark the
      WINDOW START (□, `left` bars before the pivot bar), the PIVOT bar
      itself (PH/PL arrow), and the CONFIRM bar (✓, `right` bars after —
      where the step line changes). Window = pivot ± left/right.
    - vwap.* : ⚓ at each anchor bar (where accumulation starts). For
      vwap.gap this shows exactly which gap bar the AVWAP re-anchored on —
      change atr_mult and watch the ⚓ move.
    - extremes.highest / lowest: bracket the LATEST trailing window
      (⟨len…⟩) so the current reference range is visible; the window slides
      forward one bar per bar.
    """
    n = len(arr)
    marks: list[dict] = []

    def _valid(i):  # not NaN
        return arr[i] == arr[i]

    key = m.key
    if key in ('structure.pivot_high', 'structure.pivot_low'):
        up = key.endswith('high')
        left  = int(kwargs.get('left', 10))
        right = int(kwargs.get('right', 10))
        events = [i for i in range(n)
                  if _valid(i) and (i == 0 or not _valid(i - 1) or arr[i] != arr[i - 1])]
        for i in events[-_MAX_MARKED_EVENTS:]:
            piv = i - right          # bar where the extreme actually printed
            win = piv - left         # left edge of the pivot window
            pos = 'aboveBar' if up else 'belowBar'
            if 0 <= win < n:
                marks.append({'time': int(ts[win]), 'position': pos,
                              'shape': 'square', 'text': '⟨'})
            if 0 <= piv < n:
                marks.append({'time': int(ts[piv]), 'position': pos,
                              'shape': 'arrowDown' if up else 'arrowUp',
                              'text': 'PH' if up else 'PL'})
            marks.append({'time': int(ts[i]), 'position': pos,
                          'shape': 'circle', 'text': '✓'})
    elif key.startswith('vwap.'):
        # Anchor = accumulation start: NaN→value transition, or (gap vwap)
        # a bar whose value equals its own HLC3 — the tell of a re-anchor.
        hlc3 = ((bars['high'] + bars['low'] + bars['close']) / 3.0).to_numpy(dtype=float)
        anchors = []
        for i in range(n):
            if not _valid(i):
                continue
            fresh = (i == 0) or (not _valid(i - 1))
            reanchor = (key == 'vwap.gap' and abs(arr[i] - hlc3[i]) <=
                        1e-9 * max(1.0, abs(hlc3[i])))
            if fresh or reanchor:
                anchors.append(i)
        for i in anchors[-_MAX_MARKED_EVENTS:]:
            marks.append({'time': int(ts[i]), 'position': 'belowBar',
                          'shape': 'arrowUp', 'text': '⚓'})
    elif key in ('extremes.highest', 'extremes.lowest'):
        L = int(kwargs.get('length', 0) or 0)
        last_valid = max((i for i in range(n) if _valid(i)), default=-1)
        if L > 0 and last_valid >= L - 1:
            s = last_valid - (L - 1)
            pos = 'aboveBar' if key.endswith('highest') else 'belowBar'
            marks.append({'time': int(ts[s]), 'position': pos,
                          'shape': 'square', 'text': f'⟨{L}'})
            marks.append({'time': int(ts[last_valid]), 'position': pos,
                          'shape': 'square', 'text': '⟩'})
    marks.sort(key=lambda x: x['time'])
    return marks


_TF_MINUTES = {'1m': 1, '2m': 2, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': 390}


def overlay_arrays(bars: pd.DataFrame, ov: dict, ctx: dict, causal: bool = False):
    """Compute one overlay/operand spec {key, source, params} → (m, kwargs,
    lines) where lines is [(sub, np.ndarray)] aligned to `bars`. This is the
    raw-array core shared by the chart's overlay drawing and the strategy
    engine's rule evaluation — both get the identical primitive math.

    Fixed-timeframe primitives (atr_daily → '1d', pine_5day → '1m') are
    computed on their own timeframe and reindexed onto the display bars (HTF
    analysis: identical value on a 1m/5m/1d chart), with a warm-up allowance.

    `causal=True` (the STRATEGY/BACKTEST mode): when the compute timeframe is
    COARSER than the display timeframe, the reindex uses the last **completed**
    higher-TF bar — i.e. intraday bars during day D get day D-1's daily value.
    Daily bars are timestamped at the day's START, so the default at-or-before
    fill hands day D's full-day ATR/volume to D's own 09:31 bar. That matches
    what TradingView draws on historical intraday charts (their security()
    history repaints the same way — it is HOW these primitives passed TV
    verification), so the CHART keeps the default; but a signal engine using
    it would know the day's final range at the open — look-ahead. Finer
    compute TFs (pine_5day's 1m) complete within the display bar and stay
    unshifted: at the display bar's close every source bar is history."""
    key = ov.get('key')
    if not key or key not in REGISTRY:
        raise ValueError(f'unknown primitive {key!r}')
    m = REGISTRY[key]
    kwargs = dict(ov.get('params') or {})
    source = ov.get('source', 'close')

    if m.compute_tf and m.compute_tf != ctx['tf']:
        warm = _COMPUTE_TF_WARMUP_DAYS.get(m.compute_tf, 30)
        cstart = ctx['start'] - pd.Timedelta(days=warm)
        cbars = ctx['loader'].load(ctx['symbol'], m.compute_tf, cstart, ctx['end'])
        if ctx.get('asof') and len(cbars):
            cbars = cbars[cbars.index < ctx['end']]   # same replay-boundary law
        result = _call_primitive(m, cbars, source, kwargs)
        coarser = (_TF_MINUTES.get(m.compute_tf, 390)
                   > _TF_MINUTES.get(ctx['tf'], 390))
        shift = 1 if (causal and coarser) else 0

        def _map(a):
            a = np.asarray(a, dtype=float)
            if shift:                      # last COMPLETED higher-TF bar only
                a = np.concatenate(([np.nan] * shift, a[:-shift]))
            return _reindex_asof(a, cbars.index, bars.index)
        if isinstance(result, dict):
            result = {k: _map(a) for k, a in result.items()}
        else:
            result = _map(result)
    else:
        result = _call_primitive(m, bars, source, kwargs)

    if isinstance(result, dict):
        lines = [(sub, np.asarray(a, dtype=float)) for sub, a in result.items()]
    else:
        lines = [(None, np.asarray(result, dtype=float))]
    return m, kwargs, lines


def _one_overlay(bars: pd.DataFrame, ts: list, ov: dict, ctx: dict,
                 causal: bool = False) -> list:
    """Compute one overlay spec {key, source, params, color} → list of
    plot series (one, or several for dict-output primitives)."""
    m, kwargs, lines = overlay_arrays(bars, ov, ctx, causal=causal)

    color = ov.get('color') or '#22c55e'
    args = ','.join(f'{k}={v}' for k, v in kwargs.items())
    # Piecewise-constant primitives (S/R, floor pivots, day levels, pivot
    # H/L) must render as STEP lines, not diagonal connectors, or they look
    # like a chaotic web. MAs/VWAPs stay smooth.
    step = m.group in ('levels', 'pivots', 'dynamic_sr', 'structure')
    out = []
    for idx, (sub, arr) in enumerate(lines):
        vals = [{'time': int(t), 'value': float(v)}
                for t, v in zip(ts, arr) if v == v]
        label = m.name if sub is None else f'{m.name}.{sub}'
        series = {
            'overlayId': ov.get('id'),
            'name':  f'{label}({args})' if args else label,
            'color': color,
            'style': 0 if idx == 0 else 2,   # first solid, rest dotted
            'step':  step,
            'values': vals,
        }
        if idx == 0:   # markers belong to the primary line only
            mk = _series_markers(m, kwargs, arr, ts, bars)
            if mk:
                for x in mk:
                    x['color'] = color
                series['markers'] = mk
        out.append(series)
    return out


def prepare_bars(symbol: str, tf: str, days: int, feed: str = 'alpaca',
                 view: str = 'all', asof: str | None = None):
    """Fetch + session-filter bars and return (bars, ts, ctx) — the shared
    front half of compute_data, factored out so the strategy engine evaluates
    rules on the EXACT same bars the chart draws.

    `asof` (YYYY-MM-DD) anchors the window to the END of that ET trading day
    instead of 'now' (Phase 2 historical replay). `ts` is true UTC epoch
    seconds; `ctx` carries what overlay/rule computation needs (loader, tf,
    fetch window). On an empty window, ts is [] and ctx is still returned."""
    loader = _LOADERS.get(feed)
    if loader is None:
        raise ValueError(f'unknown feed {feed!r} (have: {sorted(_LOADERS)})')
    if asof:
        # End of the selected ET day (next ET midnight) → includes that day's
        # full RTH + extended session, then converted to a true UTC instant.
        end = (pd.Timestamp(asof, tz=_ET) + pd.Timedelta(days=1)).tz_convert('UTC')
    else:
        end = pd.Timestamp.now(tz='UTC').floor('5min')
    if tf == '1m' and feed == 'alpaca':
        days = min(int(days), 7)   # Alpaca IEX 1m history cap
    days = int(days)
    start = end - pd.Timedelta(days=days)
    bars = loader.load(symbol, tf, start, end)

    # Daily (and coarser) bars are timestamped at the session date, not inside
    # 09:30-16:00, so the RTH filter would drop every one of them → 0 bars.
    # Each daily bar already IS the RTH session, so skip the filter for 1d.
    if view == 'regular' and tf != '1d' and len(bars):
        et_full = bars.index.tz_convert(_ET)
        mask = np.fromiter((_in_rth(t) for t in et_full), bool, len(bars))
        bars = bars[mask]
    # HISTORICAL HONESTY: vendor bar APIs (Alpaca, Polygon) treat `end` as
    # INCLUSIVE, and daily bars are stamped at midnight ET — so an asof=D
    # window (end = D+1 00:00 ET) can come back carrying D+1's daily bar, a
    # bar from the FUTURE of the replay. Never trust vendor inclusivity:
    # on a replay, cut strictly before `end`. Live keeps the boundary bar
    # (the developing candle is the point of live mode).
    if asof and len(bars):
        bars = bars[bars.index < end]
    ctx = {'symbol': symbol, 'tf': tf, 'loader': loader, 'start': start,
           'end': end, 'asof': bool(asof)}
    if len(bars) == 0:
        return bars, [], ctx
    # TRUE UTC epoch seconds — the browser formats these in ET via Intl so the
    # axis reads the same as TradingView regardless of the viewer's own tz.
    ts = ((bars.index - pd.Timestamp('1970-01-01', tz='UTC'))
          // pd.Timedelta(seconds=1)).tolist()
    return bars, ts, ctx


def compute_data(symbol: str, tf: str, days: int, overlays: list,
                 feed: str = 'alpaca', view: str = 'all',
                 asof: str | None = None) -> dict:
    """Fetch bars once, compute every overlay, return everything the UI
    needs. `view`: 'all' (show pre/rth/post, tint extended hours) or
    'regular' (RTH bars only — computed and displayed).

    `asof` (YYYY-MM-DD) anchors the window to the END of that ET trading
    day instead of "now" — this is what lets the charting platform replay a
    stock exactly as it stood on the register date the screener captured it
    (Phase 2 navigation). Omitted / None → live (ends now)."""
    bars, ts, ctx = prepare_bars(symbol, tf, days, feed, view, asof)
    if len(bars) == 0:
        return {'bars': [], 'series': [], 'day_starts': [], 'first': None, 'last': None}

    et = bars.index.tz_convert(_ET)
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
    <input id="addLen" type="number" min="1" placeholder="len" title="Length/period for this overlay (applies to primitives that have a length). Leave blank for the default." style="width:62px">
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
    const tvInterval = ({ '1m':'1', '2m':'2', '5m':'5', '15m':'15', '30m':'30', '1h':'60', '1d':'D' })[tf];
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
  // Length box: enable only when the primitive has a length param; show its
  // default as the placeholder so you can see/override it before adding.
  const lenEl = document.getElementById('addLen');
  const lp = lengthParamOf(m);
  if (lp) {
    const def = m.params.find(p => p.name === lp);
    lenEl.disabled = false; lenEl.style.opacity = '1';
    lenEl.placeholder = def && def.default != null ? String(def.default) : 'len';
    lenEl.title = 'Length for ' + lp + ' (default ' + (def ? def.default : '?') + '). Blank = default.';
  } else {
    lenEl.disabled = true; lenEl.style.opacity = '0.4';
    lenEl.placeholder = '—'; lenEl.value = '';
    lenEl.title = 'This primitive has no length parameter.';
  }
}

function persistOverlays() {
  localStorage.setItem('qp_overlays', JSON.stringify(OVERLAYS));
  localStorage.setItem('qp_selected', SELECTED || '');
}

// Name of the primitive's primary length/period param, if it has one.
function lengthParamOf(m) {
  if (!m || !m.params) return null;
  const names = m.params.map(p => p.name);
  for (const cand of ['length', 'period', 'len', 'pivot_period'])
    if (names.includes(cand)) return cand;
  return null;
}

function addOverlay() {
  const key = document.getElementById('addPrim').value;
  const source = document.getElementById('addSource').value;
  const m = primMeta(key); if (!m) return;
  const params = {};
  for (const par of m.params) params[par.name] = par.default;
  // Apply the header length box to this overlay's length param (if it has
  // one and the box is filled). Lets you set the period up top instead of
  // digging into the params panel below the charts.
  const lp = lengthParamOf(m);
  const lenVal = parseInt(document.getElementById('addLen').value, 10);
  if (lp && Number.isFinite(lenVal) && lenVal > 0) params[lp] = lenVal;
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
  // Price range of the visible candles — used to decide whether an overlay
  // sits ON the price (MAs, VWAP, bands, levels) or is an OSCILLATOR whose
  // values live in a different range (RSI 0-100, ATR/true_range tiny). The
  // latter get their own band at the bottom of the chart, like a TV sub-pane
  // — otherwise an RSI line at ~50 is drawn far below candles at ~747 and is
  // invisible.
  let pLo = Infinity, pHi = -Infinity;
  for (const b of (j.bars || [])) { if (b.low < pLo) pLo = b.low; if (b.high > pHi) pHi = b.high; }
  const pSpan = (pHi - pLo) || 1;
  let usedOsc = false;
  const drawn = [];
  for (const s of (j.series || [])) {
    if (s.error) { drawn.push(`${s.name}: ⚠ ERROR ${s.error}`); continue; }
    const pts = (s.values || []).length;
    if (pts === 0) {
      drawn.push(`${s.name}: ⚠ 0 pts — length may exceed the ${(j.bars||[]).length} bars loaded; raise Days or lower length`);
      continue;
    }
    // Does this series overlap the price range? If its whole value range is
    // clearly outside the candles, treat it as an oscillator (bottom band).
    let sLo = Infinity, sHi = -Infinity;
    for (const v of s.values) { if (v.value < sLo) sLo = v.value; if (v.value > sHi) sHi = v.value; }
    const overlapsPrice = (sHi >= pLo - 0.5 * pSpan) && (sLo <= pHi + 0.5 * pSpan);
    const scaleId = overlapsPrice ? 'right' : 'osc';
    if (scaleId === 'osc') usedOsc = true;
    try {
      // Level primitives (S/R, pivots, opens) render as horizontal STEP
      // lines (LineType.WithSteps = 1); everything else stays smooth.
      const lineType = s.step ? 1 : 0;
      const line = addLine({ color: s.color, lineWidth: s.step ? 2 : 3, priceLineVisible: false,
                             title: s.name, lineStyle: s.style || 0, lineType: lineType,
                             crosshairMarkerVisible: true, lastValueVisible: true,
                             priceScaleId: scaleId });
      line.setData(s.values || []);
      // Verification markers from the server: pivot window ⟨ / PH / ✓,
      // VWAP ⚓ anchors, extremes ⟨len…⟩ window brackets.
      if (s.markers && s.markers.length && typeof line.setMarkers === 'function') {
        try { line.setMarkers(s.markers); } catch (_) {}
      }
      LINES.push(line);
      const extra = (s.markers && s.markers.length ? ` · ${s.markers.length} marks` : '');
      drawn.push(`${s.name}: ${pts} pts${scaleId === 'osc' ? ' (bottom pane)' : ''}${extra}`);
    } catch (e) {
      drawn.push(`${s.name}: draw error ${e.message}`);
    }
  }
  // Split the chart into two clean panes when an oscillator is present:
  // candles get the TOP ~65% (bottom margin pushes them up), the oscillator
  // gets the BOTTOM ~28% on its own scale — no overlap, like a TV sub-pane.
  // When there is no oscillator, restore the candles to (almost) full height.
  if (usedOsc) {
    try { CHART.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.34 } }); } catch(_){}
    try { CHART.priceScale('osc').applyOptions({ scaleMargins: { top: 0.72, bottom: 0.02 }, visible: true, borderColor: '#1e2632' }); } catch(_){}
  } else {
    try { CHART.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } }); } catch(_){}
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
                                        'chart_lib': _chart_js_version() or 'CDN',
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
