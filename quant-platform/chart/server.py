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

try:
    # An EMPTY database means something was lost, not that this is a fresh
    # install with nothing in it — a fresh install is also empty, and both want
    # the same thing: put the JSON copies back. Runs BEFORE seeding so the
    # bundle's insert-if-missing pass finds the restored rows already there.
    _restored = store.restore_strategies()
    if _restored:
        print(f'[store] restored {_restored} strategy(ies) from the JSON copies',
              flush=True)
except Exception as e:
    print(f'[store] could not restore strategies: {e}', flush=True)
try:                       # bundled seed strategies (the 5 pro scalps) — the
    store.seed_strategies()  # first boot after deploy adds any that are missing
except Exception:          # never let a seed problem stop the server
    pass
try:
    store.stamp_ready_stages()
except Exception as e:
    print(f'[store] could not stamp stages: {e}', flush=True)


@app.get('/', response_class=HTMLResponse)
def index():
    """The app shell. NEVER cached.

    Mobile Chrome caches an HTML document aggressively and there is no
    convenient hard-refresh on a phone, so after a deploy the browser kept
    rendering the PREVIOUS page — new controls simply absent, which reads as
    "the feature is broken" rather than "you are looking at last week's HTML".
    no-store forces a fetch every load; the page carries its own file
    fingerprint (see /api/health `ui`) so a stale shell can always be proven
    rather than argued about.
    """
    html = (_STATIC / 'index.html').read_text()
    return HTMLResponse(html, headers={
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache', 'Expires': '0'})


def _ui_fingerprint() -> str:
    """Short hash of the served index.html — proves which UI a browser has."""
    import hashlib
    try:
        return hashlib.sha256((_STATIC / 'index.html').read_bytes()).hexdigest()[:8]
    except OSError:
        return '????????'


@app.get('/api/health')
def health():
    return {'ok': True, 'build': cs._BUILD, 'ui': _ui_fingerprint(),
            'primitives': len(cs.REGISTRY),
            **cs._feed_status()}


@app.post('/api/settings/default-feed')
def set_default_feed(payload: dict = Body(...)):
    """Choose which feed everything defaults to.

    It used to be inferred — polygon whenever a POLYGON_API_KEY existed — and a
    key being present turned out not to mean the plan behind it includes the
    data being asked for. Every 1-minute request 403'd while the platform
    reported polygon as its best feed. Nothing here can test a plan's
    entitlements without spending a request per startup, so the guess is gone
    and this is how the answer gets set instead.

    200 with ok:false for a bad feed rather than a 4xx: the caller is a page,
    and the reason is more useful to it than the status.
    """
    try:
        feed = cs.set_default_feed(str(payload.get('feed') or ''))
        return JSONResponse({'ok': True, 'default_feed': feed, **cs._feed_status()})
    except Exception as exc:
        return JSONResponse({'ok': False, 'error': str(exc), **cs._feed_status()},
                            status_code=200)


@app.get('/api/primitives')
def primitives():
    return cs.list_primitives()


# ── Phase 2: screener register navigation ──────────────────────────────────
@app.get('/api/screener/health')
def screener_health():
    return {'registers': sc.REGISTERS, 'options': sc.register_options(),
            **sc.health()}


@app.get('/api/screener/sources')
def screener_sources(reload: int = 0):
    """Every configured scanning tool and whether it is UP right now, plus the
    register options the pickers should offer. `reload=1` re-reads the config
    (chart/screener_sources.json or $SCREENER_SOURCES) without a restart."""
    if reload:
        sc.reload_sources()
    return {'ok': True, 'sources': sc.source_health(),
            'default': sc.default_source(), 'registers': sc.REGISTERS,
            'options': sc.register_options()}


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
        # A human pressed Save. Recorded on the row so the startup seed sync
        # leaves it alone from now on — see store.seed_strategies.
        return {'ok': True, 'strategy': store.save_strategy(payload, user_edit=True)}
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


@app.post('/api/strategies/{sid}/tools')
def strategies_set_tools(sid: int, payload: dict = Body(...)):
    """Assign the scanning tools a strategy belongs to, and nothing else.

    Saving a strategy means POSTing the whole document back, which is right for
    the builder and wrong for everything else: assigning a tool from the
    screener would mean round-tripping every rule through another process, and
    any bug in that round trip silently rewrites the logic. This touches one
    field on the stored document and cannot touch the rest.

    It exists because the tools list is the one part of a strategy that is not
    decided in the builder. A strategy is built and backtested first and only
    then assigned, usually from the screener where its alerts will appear.
    """
    try:
        saved = store.set_tools(sid, payload.get('tools'))
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)
    if saved is None:
        return JSONResponse({'ok': False, 'error': f'no strategy {sid}'},
                            status_code=200)
    return {'ok': True, 'strategy': saved}


@app.delete('/api/strategies/{sid}')
def strategies_delete(sid: int):
    return {'ok': store.delete_strategy(sid)}


# ── Phase 4: backtests ──────────────────────────────────────────────────────
import threading as _threading
_BT_RUNNING: dict = {'id': None}
_BT_START_LOCK = _threading.Lock()     # closes the double-POST race window

# ── the print sheet: ONE AT A TIME, AND BOUNDED ───────────────────────────
#
# A print sheet is the heaviest thing this process does, and until now it was
# the only heavy thing with no limit on it. The backtest has taken the lock
# above since it was written; printing took nothing, and two or three sheets
# started together were three of everything at once.
#
# WHAT ONE SHEET COSTS, per ticker:
#
#   compute_data() materialises up to _MAX_DAYS[tf] days of bars to draw a
#   two-day window — 60 days of 1-minute bars in full extended hours is about
#   57,600 rows, fetched to display roughly 1,900 of them, plus every overlay
#   series computed across the whole span.
#
# and then, ONCE, for the whole sheet:
#
#   json.dumps(sheets) builds the entire payload as one string; the f-string
#   template copies it into a larger one; HTMLResponse encodes that to UTF-8.
#   Three copies of everything, live at the same moment, before a byte is sent.
#
# Multiply that by three concurrent requests and the box has no headroom left —
# which is why adding RAM did not help. More memory does not bound an unbounded
# job; it only moves the point where it falls over.
#
# REFUSED, NOT QUEUED. Blocking on the lock would hold a threadpool worker for
# the minutes a rate-limited Polygon fetch can take, so a second request is
# turned away immediately with a page that says what is happening. Waiting and
# dying is worse than being told to wait.
_PRINT_LOCK = _threading.Lock()

# A hard ceiling on one sheet. A register day is normally tens of tickers; the
# cap exists for the day it is not, and it TRUNCATES LOUDLY rather than dying
# halfway through — a sheet that silently stopped at chart 90 would be read as
# "only 90 names qualified".
_PRINT_MAX_CHARTS = 150


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
            # THE RUN KEEPS A COPY OF WHAT IT RAN.
            #
            # The spec stored only `strategy_id`. Edit that strategy tomorrow
            # and the stored run points at a different rule set from the one
            # that produced its numbers — the record says "strategy 7" and
            # strategy 7 has moved. Nothing in the run says so, which makes
            # every archived result unverifiable.
            #
            # Freezing the resolved documents fixes that, and has a second
            # use: it makes every backtest a dated snapshot of the strategy,
            # so one lost from the database can be read back out of any run
            # that used it. See tools/recover_strategies.py.
            try:
                payload['_strategy_docs'] = [
                    {k: v for k, v in s.items() if k != 'exit_protocol'}
                    for s in bt._resolve_strategies(payload)]
            except Exception:      # a snapshot must never stop a run
                pass
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


@app.get('/api/desk/backtest-defaults')
def desk_backtest_defaults():
    """The live desk's settings, in this backtest's own key names.

    Proxied rather than fetched by the browser because the desk answers on a
    different port: the page would need CORS on every tool, and a page that
    silently fails to reach one of them would fall back to typed-in numbers —
    which is the failure this whole endpoint exists to remove.
    """
    from chart import screener as sc
    try:
        return sc.backtest_defaults()
    except Exception as e:  # noqa: BLE001 — a dead desk is an answer, not a 500
        return {'ok': False, 'error': str(e)}


@app.get('/api/cache')
def cache_stats():
    """How much disk the bar cache is using, and whether that is a problem.

    Three loaders write parquet frames into ~/.qp-cache and NOTHING used to
    delete one. A print sheet is what fills it fastest: 150 charts a day, a
    file each, hundreds of kilobytes apiece — a few afternoons of printing is
    gigabytes, and when it filled the disk the platform stopped working in a
    way that pointed nowhere near the cache.
    """
    from tools.data import cache
    try:
        return {'ok': True, **cache.stats()}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/oneil/market')
def oneil_market(refresh: int = 0, days: int = 500, feed: str = 'yahoo'):
    """O'Neil's market model — the M in CAN SLIM.

    He found THREE OUT OF FOUR stocks follow the general market direction and
    called M the letter most investors ignore. Everything else on a card is
    about one company; this decides whether to be buying at all.

    Cached in `data/oneil-market.json` and served from there, because nine
    screener tools read the same file and the model is one fact about the
    market — computing it nine times is nine chances to disagree, on nine
    different page loads. `refresh=1` recomputes and republishes.

    NEVER A CAUSE OF FAILURE. A reader that cannot get an answer here renders
    its page exactly as it does today; the market model being stale must not be
    able to stop a scan.
    """
    import datetime as _dt
    from chart import oneil, oplog
    try:
        if not refresh:
            cached = oneil.read_shared()
            # A CACHE WITH NO EXPIRY IS A STALE MARKET READ. Nothing else in
            # this system rebuilds the model on a schedule, so without a TTL
            # the file written the day it was first requested would still be
            # answering in November — and a market status is the one number
            # where being a month old is worse than being absent.
            #
            # Twelve hours: the bars are daily, the rebuild is two requests,
            # and the first page opened after a close picks up that close.
            if cached:
                try:
                    built = _dt.datetime.fromisoformat(cached.get('built_at'))
                    age_h = (_dt.datetime.now(_dt.timezone.utc) - built).total_seconds() / 3600
                except Exception:                   # noqa: BLE001
                    age_h = 1e9                     # unparseable → rebuild
                if age_h < 12:
                    return {'ok': True, 'cached': True,
                            'age_hours': round(age_h, 1), **cached}
        model = oneil.build(days=days, feed=feed)
        where = oneil.write_shared(model) if model.get('ok') else None
        oplog.record('oneil_market', status=model.get('status'),
                     live=len(model.get('distribution_days') or []),
                     partial=model.get('partial'), wrote=where)
        # `wrote` is in the RESPONSE, not only the log. "Did it publish, and
        # where?" was a question that needed an SSH session to answer.
        return {'ok': model.get('ok', False), 'cached': False,
                'wrote': where, **model}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/oneil/groups')
def oneil_groups(refresh: int = 0):
    """The L in CAN SLIM: group ranks, and each stock's rank inside its group.

    O'Neil published the arithmetic — 37% of a stock's move is its industry
    group, 12% its sector. The existing sector heatmap is the coarse level;
    this is the one he actually trades.

    Cached in `data/oneil-groups.json` with a 12-hour TTL, for the same reason
    the market model is: nine tools read it, it is one ranking of one universe,
    and computing it nine times is nine chances to disagree.
    """
    import datetime as _dt
    from chart import groups, oplog
    try:
        if not refresh:
            cached = groups.read_shared()
            if cached:
                try:
                    built = _dt.datetime.fromisoformat(cached.get('built_at'))
                    age_h = (_dt.datetime.now(_dt.timezone.utc) - built).total_seconds() / 3600
                except Exception:                   # noqa: BLE001
                    age_h = 1e9
                if age_h < 12:
                    return {'ok': cached.get('ok', False), 'cached': True,
                            'age_hours': round(age_h, 1), **cached}
        model = groups.build()
        where = groups.write_shared(model)
        oplog.record('oneil_groups', ok=model.get('ok'),
                     total=model.get('total_groups'),
                     mapped=model.get('mapped_symbols'), wrote=where)
        return {'cached': False, 'wrote': where, **model}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/oneil/fundamentals')
def oneil_fundamentals(symbols: str = '', refresh: int = 0,
                       cached_only: int = 0):
    """C and A — the earnings tables, from SEC EDGAR. Free, no key.

    Served from a per-ticker cache with a WEEK's life, because fundamentals
    move quarterly and a card must never trigger a fetch. `refresh=1` rebuilds.

    `cached_only=1` MEANS IT. A cache miss answers "not fetched yet" instead of
    walking EDGAR, and that is the mode the cards use. Without it, opening a
    scan of 25 cold tickers walked EDGAR 25 times inside one request: the page
    waited on the slowest source before it drew anything, and the burst got the
    news feed's EDGAR source rate-limited, which is why every card in that scan
    printed "edgar not answering". The panel — one symbol, a deliberate tap —
    still builds on demand.

    Every table carries the date it was built: filings land weeks after
    quarter-end, so a card in May legitimately showing a February filing is the
    system working, and the as-of date is the difference between that and a bug.
    """
    from chart import edgar
    try:
        syms = [s for s in (symbols or '').replace(' ', ',').split(',') if s][:40]
        if not syms:
            return {'ok': False, 'error': 'no symbols'}
        out = {}
        for s in syms:
            hit = None if refresh else edgar.cached(s)
            if hit is None and cached_only:
                out[s.upper()] = {
                    'ok': False, 'cached': False,
                    'error': 'not fetched yet — EDGAR is walked nightly',
                }
                continue
            if hit is None:
                hit = edgar.build(s)
                if hit.get('ok'):
                    edgar.write_cached(hit)
                hit['cached'] = False
            else:
                hit['cached'] = True
            out[s.upper()] = hit
        return {'ok': True, 'stocks': out}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/oneil/13f')
def oneil_13f(refresh: int = 0):
    """I — how many institutions own each stock, and which way that is going.

    Served from data/oneil-13f.json, which the nightly job writes. 13F is
    QUARTERLY data: rebuilding it on request would spend a several-hundred-
    megabyte download to produce the same answer it produced yesterday.
    `refresh=1` forces it anyway.
    """
    from chart import f13
    import json as _json
    try:
        if not refresh and f13.SHARED.exists():
            return {'ok': True, 'cached': True,
                    **_json.loads(f13.SHARED.read_text())}
        return f13.build(log=lambda *_: None)
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)[:300]}


@app.get('/api/oneil/base')
def oneil_base(symbols: str = '', feed: str = 'yahoo'):
    """The base — cup with handle, rounding bottom — on a WEEKLY chart.

    Weekly because that is how O'Neil taught it and how MarketSmith draws it,
    and it is not a display choice: a base is 7-65 WEEKS, and the same shape
    tests on daily bars measure something else entirely.

    Two years of daily bars, resampled: 65 weeks is the longest base worth
    reading and the lip needs history before it.
    """
    from chart import base as bmod, data_manager
    try:
        syms = [s for s in (symbols or '').replace(' ', ',').split(',') if s][:60]
        if not syms:
            return {'ok': False, 'error': 'no symbols'}
        out = {}
        for raw in syms:
            s = raw.strip().upper()
            try:
                df = data_manager.load_bars(s, '1d', 560, feed)
                out[s] = bmod.analyse(df)
            except Exception as e:                  # noqa: BLE001
                out[s] = {'ok': False, 'error': f'could not fetch bars: {str(e)[:120]}'}
        return {'ok': True, 'timeframe': 'weekly', 'stocks': out}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/datacheck')
def datacheck(symbol: str = 'SPY'):
    """Does every data source actually return USABLE data?

    Not "is it up" — a source answering 200 with an empty frame, a stale one,
    or one where a split was never applied renders as a normal-looking card,
    and nothing else in this platform would catch any of them.

    Slow on purpose: it fetches from every loader and compares them against
    each other. Not on a schedule and not on a page load — this is a button.
    """
    from chart import datacheck as dc
    try:
        return dc.run_all(symbol)
    except Exception as e:                          # noqa: BLE001
        # A health check that can itself fail is not one, so even this path
        # answers in the shape the caller expects.
        return {'ok': False, 'total': 0, 'passed': 0, 'down': 1, 'degraded': 0,
                'checks': [], 'summary': f'the check itself failed: {str(e)[:200]}'}


@app.get('/api/oneil/ratings')
def oneil_ratings(symbols: str = '', feed: str = 'yahoo', index: str = '^GSPC'):
    """Phase 4: U/D volume, Accumulation/Distribution, the RS line, divergence.

    The last two are the workshop's section 3 — the RS line entering new high
    ground BEFORE price, and the stock refusing to make a new low while the
    index does. They are stock-against-index, so the index frame is fetched
    once for the whole list rather than once per symbol.
    """
    from chart import oneil
    try:
        syms = [s for s in (symbols or '').replace(' ', ',').split(',') if s][:120]
        if not syms:
            return {'ok': False, 'error': 'no symbols'}
        return {'ok': True, 'index': index,
                'stocks': oneil.stocks_ratings(syms, feed=feed, index=index)}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/oneil/stock')
def oneil_stock(symbols: str = '', feed: str = 'yahoo'):
    """What each of these stocks did on the live distribution days.

    THE REASON THE MARKET MODEL IS WORTH PUTTING ON A CARD. Stamping "uptrend
    under pressure" on a register day is 150 identical lines, and a field with
    the same value on every row says nothing about any row. This one is
    different on every card and is computed from a market-level fact: O'Neil's
    "leaders hold up during market pullbacks", made checkable.

    Served from qp because qp holds the parquet bar cache — nine tools asking
    for the same names would otherwise be nine fetches of the same bars.
    """
    from chart import oneil
    try:
        syms = [s for s in (symbols or '').replace(' ', ',').split(',') if s][:200]
        if not syms:
            return {'ok': False, 'error': 'no symbols'}
        model = oneil.read_shared() or {}
        days = model.get('distribution_days') or []
        return {
            'ok': True,
            'as_of': model.get('as_of'),
            'status': model.get('status'),
            'distribution_days': days,
            'stocks': oneil.stocks_vs_distribution(syms, days, feed=feed),
        }
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.post('/api/cache/clear')
def cache_clear(payload: dict = Body(default={})):
    """Delete the cached bars. Safe by construction.

    Every file here is a COPY of something the feeds can return again, so
    losing all of it costs the next fetch its network time and nothing else.
    That is why this needs no confirmation beyond pressing it.

    `older_than_days` deletes only what has not been written since then —
    for reclaiming a print sheet's worth without dropping today's bars.
    """
    from tools.data import cache
    from chart import oplog
    try:
        days = payload.get('older_than_days')
        days = float(days) if days not in (None, '') else None
        before = cache.stats()
        out = cache.clear(older_than_days=days)
        # RECORDED. Deleting a few gigabytes is worth being able to find
        # afterwards — "the cache was empty on Tuesday" has an answer now.
        oplog.record('cache_clear', deleted=out.get('deleted'),
                     freed_mb=out.get('freed_mb'), older_than_days=days,
                     was_mb=before.get('mb'))
        return {'ok': True, **out, 'now': cache.stats()}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.post('/api/cache/sweep')
def cache_sweep():
    """Trim to the limit now, rather than waiting for the next fetch to do it.

    The cache trims itself where it GROWS — every loader calls the sweeper
    after writing a file — so this is only for a box that has stopped fetching
    and is still over, which is exactly the state a full disk produces.
    """
    from tools.data import cache
    from chart import oplog
    try:
        out = cache.sweep(force=True)
        if out.get('deleted'):
            oplog.record('cache_sweep', **{k: v for k, v in out.items()
                                           if k != 'freed_bytes'})
        return {'ok': True, **out, 'now': cache.stats()}
    except Exception as e:                          # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/oplog')
def oplog_read(limit: int = 200, op: str = '', day: str = '', summary: int = 0):
    """What qp has been asked to do, newest first.

    The record that did not exist: `print()` to stdout is kept by systemd for a
    while, read by nobody, and cannot be queried. After the fact this is what
    answers "was the 09:35 decision even asked", "how long did it take" and
    "how many charts was the sheet building when it died".

    `summary=1` gives counts and timings per operation instead of the rows —
    the shape of a session in one object.
    """
    from chart import oplog
    try:
        if summary:
            return {'ok': True, 'day': day, 'summary': oplog.summary(day)}
        return {'ok': True, 'rows': oplog.read(limit=limit, op=op, day=day)}
    except Exception as e:  # noqa: BLE001 — a log reader must not 500
        return {'ok': False, 'error': str(e)}


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
    # strategy name, most-reliable first: the summary (new runs), else RESOLVE
    # from the run's spec (inline strategy or strategy_id → stored name) so
    # even runs recorded before summaries carried it still self-identify.
    def _sname(g):
        s = (g.get('summary') or {}).get('strategy_name')
        if s:
            return s
        spec = g.get('spec') or {}
        inl = spec.get('strategy')
        if isinstance(inl, dict) and inl.get('name'):
            return inl['name']
        sid = spec.get('strategy_id')
        if sid:
            st = store.get_strategy(int(sid))
            if st and st.get('name'):
                return st['name']
        return g.get('name') or ''
    sname = _sname(g)
    ctx_keys = sorted({k for t in trades for k in (t.get('ctx') or {})})
    # 'strategy' as the FIRST column so every row self-identifies which setup
    # produced it (a CSV with no strategy name is un-attributable).
    base = ['strategy', 'date', 'symbol', 'side', 'entry_ts', 'exit_ts', 'entry',
            'exit', 'ret_pct', 'pnl_ps', 'reason']
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(base + [f'ctx_{k}' for k in ctx_keys])
    for t in trades:
        c = t.get('ctx') or {}
        # per-share P&L of the WHOLE position (scale-out weighted, not just the
        # runner leg): ret is the size-weighted fractional return, so
        # ret×entry is the true blended $/share.
        pps = (round((t.get('ret') or 0.0) * t['entry'], 4)
               if t.get('ret') is not None else '')
        w.writerow([sname, t['date'], t['symbol'], t['side'], t['entry_ts'], t['exit_ts'],
                    t['entry'], t['exit'],
                    round(t['ret'] * 100, 4) if t.get('ret') is not None else '',
                    pps, t['reason']] + [c.get(k, '') for k in ctx_keys])
    # filename carries the strategy slug too, so downloads don't collide
    slug = ''.join(ch if ch.isalnum() else '_' for ch in sname)[:40].strip('_')
    fname = f'backtest_{bid}_{slug}.csv' if slug else f'backtest_{bid}.csv'
    return PlainTextResponse(buf.getvalue(), media_type='text/csv', headers={
        'Content-Disposition': f'attachment; filename="{fname}"'})


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


def _account_html(s: dict) -> str:
    a = (s or {}).get('account')
    if not a:
        return ''
    warn = ''
    if a.get('unsized_no_stop'):
        warn += (f"<div class=\"warn\">⚠ {a['unsized_no_stop']} trades EXCLUDED — no "
                 f"usable stop, so risk-based size is undefined</div>")
    if a.get('size_capped_by_leverage'):
        warn += (f"<div class=\"warn\">⚠ {a['size_capped_by_leverage']} trades hit the "
                 f"CAPITAL cap (the position, PLUS whatever was already open, "
                 f"would exceed {a['max_leverage']}x the balance) — they risked "
                 f"LESS than {a['risk_pct']}%</div>")
    if a.get('size_capped_by_position'):
        warn += (f"<div class=\"warn\">⚠ {a['size_capped_by_position']} trades hit the "
                 f"PER-TRADE cap ({a['max_position_pct']}% of equity in one name) — "
                 f"they risked LESS than {a['risk_pct']}%. This is the cap that "
                 f"leaves room for the rest of the day.</div>")
    if a.get('skipped_no_capital'):
        warn += (f"<div class=\"warn\">⚠ {a['skipped_no_capital']} trades SKIPPED — no "
                 f"buying power left: earlier positions were still open and had "
                 f"used the whole balance. A real account could not take these.</div>")
    ch = a.get('challenge')
    if ch:
        verdict = {'target': ('ok', 'PASSED'), 'drawdown': ('warn', 'FAILED'),
                   'neither': ('warn', 'NEITHER LINE REACHED')}[ch['result']]
        where = (f" on {ch['hit_on']} ({ch['hit_symbol']})"
                 if ch.get('hit_on') else '')
        warn += (f"<div class=\"{verdict[0]}\"><b>CHALLENGE {verdict[1]}</b> "
                 f"+{ch['target_pct']}% vs -{ch['max_dd_pct']}%{where} · "
                 f"best +{ch['peak_profit_pct']}% · worst -{ch['worst_case_dd_pct']}% "
                 f"(closed -{ch['closed_dd_pct']}%)"
                 f"<details class=\"why\"><summary>why</summary><div>"
                 f"Drawdown measured {'from the starting balance' if ch['basis'] == 'start' else 'from the highest balance reached'}, "
                 f"on the worst case: at every moment every position still open "
                 f"is assumed to stop out at once. The closed figure ignores "
                 f"open positions and is the optimistic one. "
                 f"Not modelled: {ch['not_modelled']}."
                 f"</div></details></div>")
    if not a.get('trades_sized'):
        warn += ("<div class=\"warn\">⚠ NO trade could be sized — the account numbers "
                 "below are the starting balance, unchanged.</div>")
    # every one of these can be None when nothing was sizable — format safely
    def _n(v, fmt='{:,.2f}', dash='—'):
        return dash if v is None else fmt.format(v)
    # The heading has to name the model that was actually run. Printing
    # "risking 0% per trade" over a flat-dollar book reads as a broken report.
    _risk = (f"${a['risk_usd']:,.0f} per trade (flat, no compounding)"
             if a.get('risk_usd') else f"{a['risk_pct']}% per trade")
    return f"""<h3>Real account — ${a['account_equity_start']:,.0f} risking {_risk}</h3>
{warn}<div class="grid">
<div class="kpi"><b>${_n(a.get('equity_end'))}</b><span>ending equity (compounded in trade order)</span></div>
<div class="kpi"><b>{_n(a.get('return_pct'), '{:+.2f}%')}</b><span>account return</span></div>
<div class="kpi"><b>${_n(a.get('net_pnl_usd'))}</b><span>net P&amp;L after ${_n(a.get('fees_usd'))} commissions</span></div>
<div class="kpi"><b>{_n(a.get('max_drawdown_pct'), '{}')}%</b><span>max drawdown (realized equity)</span></div>
<div class="kpi"><b>{_n(a.get('win_rate_pct'), '{}')}%</b><span>win rate on sized trades ({a.get('trades_sized', 0)})</span></div>
<div class="kpi"><b>${_n(a.get('avg_pnl_usd'))}</b><span>average P&amp;L per trade</span></div>
<div class="kpi"><b>{a.get('max_concurrent_positions', 0)}</b><span>most positions held at once (they share the {a['max_leverage']}x balance)</span></div>
<div class="kpi"><b>${a.get('fee_per_share', 0)}/sh, min ${a.get('fee_min_per_order', 0)}</b><span>commission charged per order</span></div>
</div>"""


def _warn_html(warn: list) -> str:
    """Warnings as one scannable line each, with the reasoning folded away.

    Every one of these was added because something was misread once, so none of
    them may be deleted. But a wall of prose above the numbers gets skipped
    wholesale, which loses the warning just as completely — and the run that
    matters is the one where a reader is hunting for a figure, not reading.

    So: the FACT is always on screen, one line, no essay. The "why" is a tap.
    Entries may be a bare string (nothing to explain) or (fact, why).
    """
    if not warn:
        return ''
    out = []
    for w in warn:
        fact, why = w if isinstance(w, (tuple, list)) else (w, None)
        line = f'⚠ {fact}'
        if why:
            line += (f'<details class="why"><summary>why</summary>'
                     f'<div>{why}</div></details>')
        out.append(line)
    return '<div class="warn">' + '<br>'.join(out) + '</div>'


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
    # (fact, why) — the FACT is always on screen, the explanation folds away.
    # Every line here earned its place by having been got wrong once, but a wall
    # of prose above the numbers is read by nobody, which loses the warning too.
    warn = []
    if not spec.get('cost_bps'):
        warn.append(('costs 0 bps — spread and slippage not modelled', None))
    _fill = spec.get('fill', 'close')
    if _fill == 'close':
        warn.append(("fill = close — THIS RUN IS NOT WHAT THE DESK WOULD GET",
                     "Every entry is booked at the signal bar's close, which is "
                     "a price no order can reach: it only becomes knowable at "
                     "the instant the bar ends, and the market order goes out "
                     "after that. Re-run on 'desk'."))
    elif _fill == 'next_open':
        warn.append(("fill = next_open — the entry is honest, the levels are not",
                     "The entry is the next bar's open, which is right. But the "
                     "stop and every target are then re-measured from that fill, "
                     "which hands the trade back the exact R the strategy was "
                     "tested at. The desk prices them from the DECISION close "
                     "and sends them to the broker before the fill exists, so "
                     "its real R differs on every trade. 'desk' models that."))
    cov = s.get('coverage') or {}
    if cov.get('entry_drops'):
        # These are BAR-LEVEL events, not lost opportunities, and printing them
        # in one list invited exactly the wrong reading: a setup whose window is
        # a single minute shows outside_window in the millions, because the
        # entry expression is true on most bars of most days and the clock
        # refuses all of them. That is the time gate WORKING. Split into the
        # gate doing its job and the drops that actually cost a trade, so the
        # second list is small enough to act on.
        _d = dict(cov['entry_drops'])
        _clock = {k: _d.pop(k) for k in ('outside_window', 'rth_session',
                                         'eod_bar', 'last_bar') if k in _d}
        if _d:
            _dl = ', '.join(f'{k}={v}' for k, v in sorted(_d.items(),
                                                          key=lambda kv: -kv[1]))
            warn.append((f"signals in-window that did not trade — {_dl}",
                         "daily_cap = the per-day attempt limit. cooldown = too "
                         "soon after the last exit. unpriceable_stop = the stop "
                         "level had not formed yet. target_too_close = the "
                         "nearest profit target was under the strategy's "
                         "min_target_usd. target_unpriced_kept = an exit-RULE "
                         "strategy with no priced target, kept rather than "
                         "guessed at."))
        if _clock:
            _cl = ', '.join(f'{k}={v:,}' for k, v in sorted(_clock.items(),
                                                            key=lambda kv: -kv[1]))
            warn.append((f"bars refused by the clock — {_cl}",
                         "The time window doing its job. Counted per BAR across "
                         "the whole evaluated history, not trades you missed — "
                         "for a one-minute window, millions is normal."))
    # The watchlist gate. Stated whichever way it went: that trades were
    # removed is the headline, and that the gate was switched OFF is a bigger
    # one — every number below then includes trades that could not have been
    # taken.
    if cov.get('scan_gate') is False:
        warn.append(('watchlist gate OFF — trades are counted from before the '
                     'scanner found the stock',
                     "The strategy's entry could fire at 09:45 in a name the "
                     'scanner did not surface until 10:00. Live, no alert and '
                     'no order were possible at 09:45. Every statistic below is '
                     'flattered, and most in the strategies that trade earliest.'))
    elif cov.get('before_scan'):
        _bs = cov['before_scan']
        warn.append((f'{_bs} trades removed — the scanner had not found the name yet',
                     'The entry fired before the stock was on the watchlist, so '
                     'no alert and no order were possible. Examples: '
                     + '; '.join(cov.get('before_scan_samples') or [])))
    if cov.get('scan_time_unknown'):
        warn.append((f"{cov['scan_time_unknown']} pairs have no scan time — not gated",
                     'Register rows frozen before the scanner started stamping '
                     'when it first matched a ticker. They are counted as they '
                     'always were; a guessed 09:30 would pass exactly the trades '
                     'the gate exists to catch.'))
    if cov.get('rvol_min'):
        warn.append((f"In-Play filter rvol ≥ {cov['rvol_min']} at {cov.get('rvol_at')} ET — "
                     f"excluded {cov.get('rvol_below', 0)} below + "
                     f"{cov.get('rvol_unknown', 0)} unverifiable",
                     "Honest cumulative RVOL (volume so far today vs the average "
                     "by this time of day), not the register's one-bar 5-minute "
                     "snapshot."))
    if cov.get('by_source'):
        _bs = ' · '.join(
            f"{b['name']}: {b['pairs']} pairs ({b['pct_of_pairs']}%) over {b['days']}d, "
            f"{b['trades']} trades, {b['total_return_pct']:+.2f}%"
            for b in cov['by_source'])
        warn.append(('universe by scanning tool — ' + _bs, None))
    if cov.get('source_imbalance'):
        warn.append((cov['source_imbalance'], None))
    if cov.get('no_data'):
        warn.append((f"{cov['no_data']} of {cov.get('pairs')} pairs returned NO bars "
                     f"on feed '{cov.get('feed')}' — universe only PARTIALLY evaluated",
                     "alpaca/IEX carries no data for many small caps. Rerun on "
                     "polygon."))
    if cov.get('blank_days'):
        _bd = cov['blank_days']
        warn.append((f"{len(_bd)} session(s) produced NO bars at all — this run really "
                     f"covers {cov.get('covered_days', 0)} session(s)"
                     + (f" ({cov.get('covered_from')} → {cov.get('covered_to')})"
                        if cov.get('covered_from') else ''),
                     "yahoo serves roughly a month of 1-minute bars and the window "
                     "SLIDES, so the oldest days of a range drop out over time and "
                     "the same backtest returns fewer trades than it did a fortnight "
                     "ago. Use polygon for anything older than a week. Blank: "
                     + ', '.join(_bd[:12]) + ('…' if len(_bd) > 12 else '')))
    # A VWAP-ANCHORED STOP IS ONLY AS GOOD AS THE VOLUME UNDER IT.
    #
    # Both live setups stop at the session VWAP, which is a volume-weighted
    # number, so the feed does not merely supply the bars, it DEFINES where the
    # stop sits. yahoo and polygon are consolidated (the whole market); Alpaca's
    # free tier is IEX only, a few percent of the volume, and its VWAP is a
    # different line on the same chart.
    #
    # Backtesting a VWAP-stopped strategy on IEX therefore does not measure that
    # strategy. It measures a strategy nobody wrote, with a stop nobody would
    # place, and reports it in the same shape as a real result. The runner
    # already says this at the moment of a live pick; a backtest that stayed
    # quiet about it was the louder of the two silences.
    if str(spec.get('feed') or '') == 'alpaca':
        _vwap_stopped = []
        for _st in (spec.get('strategies') or ([spec.get('strategy')]
                                               if spec.get('strategy') else [])):
            _sl = ((_st or {}).get('risk') or {}).get('sl') or {}
            _anchor = json.dumps(_sl.get('anchor') or {})
            if 'vwap' in _anchor:
                _vwap_stopped.append((_st or {}).get('name') or '?')
        if _vwap_stopped:
            warn.append(("THE STOP IS THE SESSION VWAP AND THIS RAN ON ALPACA/IEX — "
                         "the numbers below are not this strategy",
                         "VWAP is volume-weighted, so the feed decides where the "
                         "stop sits. Alpaca's free tier carries IEX only — a few "
                         "percent of the market — and its VWAP is a different line "
                         "from the one the chart and the live desk use. Rerun on "
                         "polygon or yahoo. Affected: "
                         + ', '.join(_vwap_stopped)))
    from chart import report as rpt
    trades = g.get('trades') or []
    st = rpt.compute(trades, s, spec)
    U = st.get('unit', '$')
    warn += st.get('warnings') or []

    def _f(v, dp=2, sign=False, dash='—'):
        if v is None:
            return dash
        return f"{v:+,.{dp}f}" if sign else f"{v:,.{dp}f}"

    def _u(v, sign=True):
        """A money/percent figure in the report's own basis."""
        if v is None:
            return '—'
        return (f"{'+' if v >= 0 else '-'}${abs(v):,.2f}" if U == '$'
                else f"{v:+,.2f}%")

    def _cls(v):
        return 'up' if (v or 0) > 0 else ('dn' if (v or 0) < 0 else '')

    def _kpi(val, label, cls=''):
        return (f'<div class="kpi"><b class="{cls}">{val}</b>'
                f'<span>{label}</span></div>')

    def _tbl(head, body, cls=''):
        h = ''.join(f'<th>{x}</th>' for x in head)
        return (f'<div class="wrap"><table class="{cls}"><tr>{h}</tr>{body}</table></div>')

    def _grp_rows(d, label_of=lambda k: k, limit=None):
        items = list(d.items())[:limit] if limit else list(d.items())
        return ''.join(
            f"<tr><td>{label_of(k)}</td><td>{e['n']}</td>"
            f"<td>{e['win_rate_pct']}%</td>"
            f"<td class='{_cls(e['net'])}'>{_u(e['net'])}</td>"
            f"<td class='{_cls(e['avg'])}'>{_u(e['avg'])}</td></tr>"
            for k, e in items)

    # ── 1. EXECUTIVE SUMMARY ──────────────────────────────────────────────
    acct = s.get('account') or {}
    if acct:
        head_val = f"{'+' if acct.get('net_pnl_usd', 0) >= 0 else '-'}${abs(acct.get('net_pnl_usd') or 0):,.2f}"
        head_sub = (f"${acct['account_equity_start']:,.0f} → "
                    f"${(acct.get('equity_end') or 0):,.2f} "
                    f"({(acct.get('return_pct') or 0):+.2f}%) · "
                    f"net of ${(acct.get('fees_usd') or 0):,.2f} commissions")
        head_cls = _cls(acct.get('net_pnl_usd'))
    else:
        head_val = f"{st.get('net_profit', 0):+,.2f}%"
        head_sub = ('sum of per-unit percentage moves — set account $ and risk % '
                    'for a dollar result')
        head_cls = _cls(st.get('net_profit'))

    kpis = (
        _kpi(head_val, head_sub, head_cls)
        + _kpi(st.get('n_trades', 0), f"trades taken ({s.get('open_trades', 0)} still open at close)")
        + _kpi(f"{st.get('win_rate_pct', 0)}%", f"win rate — {st.get('wins',0)}W / {st.get('losses',0)}L / {st.get('breakeven',0)}BE")
        + _kpi(_f(st.get('profit_factor')), 'profit factor — won per unit lost (&gt;1.5 is healthy)')
        + _kpi(_u(st.get('expectancy')), 'expectancy — what one average trade returns')
        + _kpi(f"{st.get('max_dd_pct','—')}%", f"max drawdown ({_u(-abs(st.get('max_dd_abs') or 0))} peak-to-trough)")
        + _kpi(_f(st.get('recovery_factor')), 'recovery factor — net profit ÷ max drawdown')
        + _kpi(_f(st.get('sharpe')), 'Sharpe (daily, annualised ×√252, flat days counted)')
        # Placed among the headline numbers on purpose: a reader who stops at
        # the KPIs must not walk away thinking every dollar counted.
        + ((_kpi(f"${abs(acct.get('no_credit_pnl_usd') or 0):,.2f}",
                 f"PROFIT THAT WILL NOT COUNT — {acct.get('no_credit_wins')} win(s) "
                 f"under ${acct.get('min_profit_ps')}/share. Yours to keep; no "
                 f"credit toward a funded target", 'dn')
            if acct.get('no_credit_wins') else
            _kpi('$0.00', f"profit that will not count — every win cleared "
                          f"${acct.get('min_profit_ps')}/share", 'up'))
           if acct.get('min_profit_ps') is not None else '')
    )

    # ── 2. PERFORMANCE ────────────────────────────────────────────────────
    perf = _tbl(['metric', 'value', 'what it means'], ''.join(f"<tr><td>{a}</td><td class='{c}'>{b}</td><td class='muted'>{d}</td></tr>" for a, b, c, d in [
        ('Net profit', _u(st.get('net_profit')), _cls(st.get('net_profit')), 'everything below is after commissions'),
        ('Gross profit', _u(st.get('gross_profit')), 'up', 'sum of the winners only'),
        ('Gross loss', _u(st.get('gross_loss')), 'dn', 'sum of the losers only'),
        ('Profit factor', _f(st.get('profit_factor')), '', 'gross profit ÷ gross loss. Below 1.0 the strategy loses money'),
        ('Expectancy / trade', _u(st.get('expectancy')), _cls(st.get('expectancy')), 'net ÷ number of trades'),
        ('Average win', _u(st.get('avg_win')), 'up', ''),
        ('Average loss', _u(st.get('avg_loss')), 'dn', ''),
        ('Payoff ratio', _f(st.get('payoff_ratio')), '', 'avg win ÷ avg loss. With a 50% win rate you need &gt;1.0'),
        ('Largest win', _u(st.get('largest_win')), 'up', ''),
        ('Largest loss', _u(st.get('largest_loss')), 'dn', 'if this dwarfs the average loss, one trade is carrying the risk'),
        ('Best / worst day', f"{_u(st.get('best_day'))} / {_u(st.get('worst_day'))}", '', ''),
        ('CAGR (annualised)', (f"{st['cagr_pct']:+.2f}%" if st.get('cagr_pct') is not None else '—'), _cls(st.get('cagr_pct')), 'extrapolated from this window — not a forecast'),
    ]))

    # ── 3. RISK ───────────────────────────────────────────────────────────
    risk_tbl = _tbl(['metric', 'value', 'what it means'], ''.join(f"<tr><td>{a}</td><td>{b}</td><td class='muted'>{d}</td></tr>" for a, b, d in [
        ('Max drawdown', f"{st.get('max_dd_pct','—')}% ({_u(-abs(st.get('max_dd_abs') or 0))})", 'deepest peak-to-trough fall of the closed-trade equity'),
        ('Drawdown length', f"{st.get('max_dd_trades','—')} trades", 'longest stretch spent below a prior equity peak'),
        ('Recovery factor', _f(st.get('recovery_factor')), 'net profit ÷ max drawdown — profit earned per unit of pain'),
        ('Sharpe', _f(st.get('sharpe')), 'return ÷ volatility of DAILY results, annualised'),
        ('Sortino', _f(st.get('sortino')), 'same, but only downside volatility is penalised'),
        ('Calmar', _f(st.get('calmar')), 'CAGR ÷ max drawdown'),
        ('Daily volatility', (f"{st['daily_vol_pct']}%" if st.get('daily_vol_pct') is not None else '—'), 'standard deviation of daily returns'),
        ('Max consecutive losses', str(st.get('max_consec_losses', '—')), 'the streak the account has to survive'),
        ('Max consecutive wins', str(st.get('max_consec_wins', '—')), ''),
        ('Winning / losing days', f"{st.get('winning_days',0)} / {st.get('losing_days',0)} of {st.get('sessions',0)} sessions", 'sessions with no trade count as flat'),
        ('Exposure', (f"{st['exposure_pct']}%" if st.get('exposure_pct') is not None else '—'), 'position-minutes ÷ available RTH minutes — capital idle the rest of the time'),
        ('Most positions at once', str(acct.get('max_concurrent_positions', '—')), 'they share one balance'),
    ]))

    # ── 4. TRADE ANALYSIS ─────────────────────────────────────────────────
    _h = st.get('hold') or {}
    hold_tbl = _tbl(['metric', 'value'], ''.join(f"<tr><td>{a}</td><td>{b}</td></tr>" for a, b in [
        ('Average hold', f"{_h.get('avg_min','—')} min"),
        ('Average hold — winners', f"{_h.get('avg_win_min','—')} min"),
        ('Average hold — losers', f"{_h.get('avg_loss_min','—')} min"),
        ('Shortest / longest', f"{_h.get('min_min','—')} / {_h.get('max_min','—')} min"),
        ('Total time in market', f"{_h.get('total_position_min','—')} position-minutes"),
    ]))
    _r = st.get('r') or {}
    r_tbl = ''
    if _r:
        bars = ''.join(
            f"<tr><td>{b['label']}</td><td>{b['n']}</td><td>{b['pct']}%</td>"
            f"<td><span style='display:inline-block;height:9px;background:"
            f"{'#ef5350' if b['label'].startswith('≤') or b['label'].startswith('-') else '#22c55e'};"
            f"width:{max(2, int(b['pct'] * 2))}px'></span></td></tr>"
            for b in _r['buckets'])
        r_tbl = (f"<h3>R-multiple distribution</h3><div class='muted' style='font-size:11.5px'>"
                 f"R = profit ÷ the dollars risked on that trade. Total <b>{_r['total']}R</b> "
                 f"over {_r['n']} trades · average <b>{_r['avg']}R</b> · "
                 f"best {_r['best']}R · worst {_r['worst']}R. A stop that holds pins the "
                 f"worst bucket at -1R; anything below it means slippage through the stop.</div>"
                 + _tbl(['bucket', 'trades', 'share', ''], bars))

    # ── 5. BREAKDOWNS ─────────────────────────────────────────────────────
    cuts = (f"<h3>By side</h3>"
            + _tbl(['side', 'trades', 'win rate', 'net', 'avg'], _grp_rows(st.get('by_side') or {}))
            + f"<h3>By exit reason</h3>"
            + _tbl(['exit', 'trades', 'win rate', 'net', 'avg'], _grp_rows(st.get('by_reason') or {}))
            + f"<h3>By session</h3>"
            + _tbl(['date', 'trades', 'win rate', 'net', 'avg'], _grp_rows(st.get('by_day') or {}))
            + f"<h3>By symbol</h3>"
            + _tbl(['symbol', 'trades', 'win rate', 'net', 'avg'], _grp_rows(st.get('by_symbol') or {})))

    # ── 5b. PROP-FIRM RULES, and which trades they touched ────────────────
    pf_html = ''
    # FIRST at the account's own size, because that is the number that is
    # actually at stake. The rule is per share, so the same trades fail it at
    # any size — but the credit withheld scales with the position, and only
    # the flat-100-share view was ever reported.
    if acct and acct.get('min_profit_ps') is not None:
        _lost = acct.get('no_credit_pnl_usd') or 0.0
        _cnt = acct.get('counted_pnl_usd') or 0.0
        _nw = acct.get('no_credit_wins') or 0
        _rows_nc = ''.join(
            f"<tr><td>{t['date']}</td><td><b>{t['symbol']}</b></td>"
            f"<td>{t['side']}</td>"
            f"<td>{(t.get('ctx') or {}).get('acct_shares', 0):,.0f}</td>"
            f"<td class='dn'>${(t.get('ctx') or {}).get('acct_pnl_per_share', 0):.4f}/share</td>"
            f"<td class='up'>+${(t.get('ctx') or {}).get('acct_pnl_usd', 0):,.2f}</td>"
            f"<td class='muted'>kept, but earns no credit</td></tr>"
            for t in trades if (t.get('ctx') or {}).get('acct_no_credit'))
        pf_html += (
            f"<h3>Prop-firm minimum, at YOUR size</h3>"
            f"<details class='defs'><summary>what this is</summary>"
            f"The ${acct['min_profit_ps']}/share rule at the account block's own "
            f"position sizes, not a flat 100 shares. Your P&amp;L does not change "
            f"— ${(acct.get('net_pnl_usd') or 0):,.2f} is still yours. What "
            f"changes is how much counts toward a funded target.</details>"
            + _tbl(['toward the target', 'earned but not credited', 'wins affected'],
                   f"<tr><td class='up'><b>${_cnt:,.2f}</b></td>"
                   f"<td class='dn'><b>${_lost:,.2f}</b></td><td>{_nw}</td></tr>")
            + (f"<div style='margin-top:6px'><b>Wins earning no credit</b></div>"
               + _tbl(['date', 'symbol', 'side', 'shares', 'per share', 'P&L', 'note'],
                      _rows_nc) if _nw else
               "<div class='muted' style='margin-top:6px'>Every win cleared the "
               "minimum at this size.</div>"))

    pf = rpt.prop_firm_detail(trades, s)
    if pf:
        wrows = ''.join(
            f"<tr><td>{w['date']}</td><td><b>{w['symbol']}</b></td>"
            f"<td>{w['side']}</td><td>${w['entry']:.2f}</td>"
            f"<td class='dn'>${w['per_share']:.4f}/share</td>"
            f"<td class='muted'>below the ${pf['min_profit_ps']} minimum — "
            f"the profit is real, it just earns no credit toward the target</td></tr>"
            for w in pf['wasted'])
        pf_html += (
            f"<h3>Prop-firm rules — the flat {pf['shares']:.0f}-share view</h3>"
            f"<div class='muted' style='font-size:11.5px'>A SEPARATE simulation "
            f"from the account block above: it ignores your balance and trades "
            f"the same {pf['shares']:.0f} shares every time.<br>"
            f"Net <b>${pf['net_pnl_usd']:,.2f}</b> after ${pf['fees_usd']:,.2f} "
            f"commissions · of which <b>${pf['counted_pnl_usd']:,.2f}</b> counts "
            f"toward the profit target "
            f"(${pf['wasted_credit_lost']:,.2f} earned but not credited).</div>"
            + (f"<div style='margin-top:6px'><b>Wins that earned no credit "
               f"({len(pf['wasted'])})</b></div>"
               + _tbl(['date', 'symbol', 'side', 'entry', 'per share', 'why'], wrows)
               if pf['wasted'] else
               "<div class='muted' style='margin-top:6px'>Every win cleared the "
               "minimum — no credit was lost.</div>")
            + "<div class='warn' style='margin-top:6px'>NOT modelled: "
            + '; '.join(pf['not_modelled']) + "</div>")

    # ── 6. THE JOURNAL ────────────────────────────────────────────────────
    jrows = rpt.journal(trades, s)
    _money = lambda v: ('—' if v is None else f"${v:,.2f}")
    _plain = lambda v: ('—' if v is None else (f"{v:,.2f}" if isinstance(v, float) else str(v)))
    jbody = ''.join(
        "<tr>"
        f"<td>{j['n']}</td><td>{j['date']}</td><td><b>{j['symbol']}</b></td>"
        f"<td>{j['side']}</td>"
        f"<td>{j['entry_time']}</td><td>{_plain(j['entry_price'])}</td>"
        f"<td>{_plain(j['stop_price'])}</td><td>{_plain(j['risk_per_share'])}</td>"
        f"<td>{j['exit_time']}</td><td>{_plain(j['exit_price'])}</td>"
        f"<td>{j['exit_reason']}</td><td>{_plain(j['hold_min'])}</td>"
        f"<td>{_plain(j['shares'])}</td><td>{_money(j['position_usd'])}</td>"
        f"<td>{_money(j['risk_usd'])}</td><td>{_money(j['gross_usd'])}</td>"
        f"<td>{_money(j['fees_usd'])}</td>"
        f"<td class='{_cls(j['net_usd'])}'><b>{_money(j['net_usd'])}</b></td>"
        f"<td class='{_cls(j['r_multiple'])}'>{_plain(j['r_multiple'])}</td>"
        f"<td class='{_cls(j['return_pct'])}'>{_plain(j['return_pct'])}%</td>"
        f"<td>{_money(j['equity_before'])}</td><td>{_money(j['equity_after'])}</td>"
        f"<td>{_money(j['open_notional_usd'])}</td>"
        f"<td>{_plain(j['pnl_per_share'])}</td>"
        f"<td class='{'dn' if j['counts_toward_target'].startswith('NO') else ''}'>"
        f"{j['counts_toward_target']}</td>"
        f"<td>{_plain(j['rvol_day'])}</td><td>{_plain(j['reg_score'])}</td>"
        f"<td>{_plain(j['reg_gap_pct'])}</td><td>{_plain(j['reg_sector'])}</td>"
        f"<td>{_plain(j['source'])}</td><td class='muted'>{j['note'] or ''}</td>"
        "</tr>"
        for j in jrows)
    jhead = ['#', 'date', 'symbol', 'side', 'entry', 'entry $', 'stop $',
             'risk/sh', 'exit', 'exit $', 'why', 'held min', 'shares',
             'position $', 'risk $', 'gross $', 'fees $', 'net $', 'R',
             'move %', 'equity before', 'equity after', 'exposure $',
             '$/share', 'counts?',
             'rvol', 'score', 'gap %', 'sector', 'tool', 'note']
    fee_rule = (jrows[0]['_fee_rule'] if jrows else 'none')

    m = (lambda k, d='—': s.get(k) if s.get(k) is not None else d)
    html = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Backtest #{bid} — {s.get('strategy_name') or g.get('name', '')}</title><style>
body{{background:#0e1116;color:#e2e8f0;font-family:-apple-system,'Segoe UI',sans-serif;margin:0;padding:14px;-webkit-text-size-adjust:100%}}
h2{{margin:0 0 4px;font-size:19px}} h3{{margin:20px 0 4px;font-size:14px;color:#94a3b8;
  border-bottom:1px solid #1e2632;padding-bottom:4px;text-transform:uppercase;letter-spacing:.06em}}
.muted{{color:#64748b;font-size:12px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:8px;margin:12px 0}}
.kpi{{background:#151a24;border:1px solid #1e2632;border-radius:8px;padding:10px}}
.kpi b{{font-size:18px;display:block;line-height:1.3}} .kpi span{{color:#94a3b8;font-size:11px}}
.kpi:first-child{{grid-column:1/-1;border-color:#3b82f6}}
.kpi:first-child b{{font-size:27px}}
table{{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}}
td,th{{padding:5px 7px;border-bottom:1px solid #1e2632;text-align:left;white-space:nowrap}}
th{{color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;position:sticky;top:0;background:#0e1116}}
tr:hover td{{background:#151a24}}
.up{{color:#22c55e}} .dn{{color:#ef5350}}
.warn{{color:#f5a623;font-size:12px;margin:6px 0;line-height:1.5}}
.defs{{color:#64748b;font-size:11.5px;line-height:1.7;margin-top:18px}}
details.defs summary,details.why summary{{cursor:pointer;color:#475569;font-size:11px;
  list-style:none;padding:2px 0}}
details.why{{display:inline}}
details.why summary{{display:inline;text-decoration:underline dotted;margin-left:6px}}
details.why[open] > div{{color:#64748b;font-size:11px;line-height:1.5;
  margin:2px 0 6px 14px;white-space:normal}}
.wrap{{overflow-x:auto;-webkit-overflow-scrolling:touch}}
a.btn{{display:inline-block;background:#1c2431;color:#e2e8f0;border:1px solid #1e2632;
  border-radius:4px;padding:6px 11px;text-decoration:none;font-size:12px;margin:6px 6px 0 0}}
</style></head><body>

<h2>Backtest #{bid} — {s.get('strategy_name') or g.get('name', '')}</h2>
<div class="muted">
{spec.get('start')} → {spec.get('end')} · {st.get('sessions', 0)} sessions ·
{cov.get('tf') or spec.get('tf')} bars · feed <b>{cov.get('feed') or spec.get('feed') or '?'}</b> ·
fill <b>{spec.get('fill', 'close')}</b> · {uni_txt}<br>
side: {s.get('strategy_side') or spec.get('side') or 'long'} ·
slippage/spread modelled: {spec.get('cost_bps', 0)} bps per side ·
commissions: {fee_rule} ·
{('RTH entries + forced 15:50 close' if (spec.get('rules') or {}).get('eod_close') else 'no session rules')} ·
status {g.get('status')}</div>
<a class="btn" href="/api/backtest/{bid}/journal.csv">⤓ journal CSV</a>
<a class="btn" href="/api/backtest/{bid}/stats.json">⤓ statistics JSON</a>

{_warn_html(warn)}
{('<div class="warn">⚠ ' + str(s.get('errors')) + ' day·symbol pairs skipped (no data / feed error):<br>'
  + '<br>'.join('· ' + str(x)[:120] for x in (s.get('error_samples') or [])[:5]) + '</div>')
 if s.get('errors') else ''}

<h3>Result</h3>
<div class="grid">{kpis}</div>

<h3>Performance</h3>{perf}
<h3>Risk</h3>{risk_tbl}
<h3>Holding time</h3>{hold_tbl}
{r_tbl}
{cuts}
{pf_html}

<h3>Trade journal — every trade, every field</h3>
<details class="defs"><summary>column notes</summary>Times are ET.
&quot;exposure $&quot; is the total position value open across the account the moment
this trade was added — what the leverage cap is measured against.</details>
{_tbl(jhead, jbody, 'journal')}

<details class="defs"><summary>How these numbers are produced</summary>
· Every trade came from the exact strategy JSON and the same verified qp math the chart draws — the report re-reads stored rows, it does not re-simulate.<br>
· Only trades ENTERED on each evaluated session count. No warm-up leakage, no look-ahead.<br>
· Register universes are frozen each morning, so there is no survivorship bias. A typed symbol list carries whatever bias you typed.<br>
· Trades still open at the window's end are excluded from every statistic above.<br>
· {'Dollar figures size each position from the STOP (equity x risk% ÷ per-share risk), compound in trade order, and share one capital pool capped at ' + str(acct.get('max_leverage', 1)) + 'x the balance.' if acct else 'Percent figures are per-unit-position; set account $ and risk % for real-money sizing.'}<br>
· Commissions are charged per ORDER, so a scale-out pays one entry fee plus one per leg. Spread and slippage are only modelled if you set cost bps.<br>
· Profit factor, Sharpe, Sortino and Calmar are standard definitions; each is spelled out in the tables above rather than assumed.</details>
</body></html>"""
    return HTMLResponse(html)


@app.get('/api/backtest/{bid}/journal.csv')
def backtest_journal_csv(bid: int):
    """The per-trade journal as a spreadsheet — one row per trade, every field
    the report shows. Separate from /csv (which exports the raw trade rows plus
    whatever register columns rode along): this one is the trading journal,
    with derived fields (stop price, per-share risk, gross vs net, hold time,
    equity before/after) already computed so nothing has to be re-derived in
    Excel, where a wrong formula would go unnoticed."""
    import csv
    import io
    from fastapi.responses import Response
    from chart import report as rpt
    g = store.get_backtest(bid)
    if not g:
        return Response('backtest not found', status_code=404, media_type='text/plain')
    rows = rpt.journal(g.get('trades') or [], g.get('summary') or {})
    keys = [k for k, _ in rpt.JOURNAL_COLUMNS]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([lbl for _, lbl in rpt.JOURNAL_COLUMNS])
    for r in rows:
        w.writerow([('' if r.get(k) is None else r.get(k)) for k in keys])
    return Response(buf.getvalue(), media_type='text/csv',
                    headers={'Content-Disposition':
                             f'attachment; filename="journal_backtest_{bid}.csv"'})


@app.get('/api/backtest/{bid}/stats.json')
def backtest_stats(bid: int):
    """Every computed statistic as JSON — so the numbers in the report can be
    checked, charted or diffed against another run without scraping HTML."""
    g = store.get_backtest(bid)
    if not g:
        return {'ok': False, 'error': 'backtest not found'}
    from chart import report as rpt
    return {'ok': True, 'id': bid,
            'spec': g.get('spec') or {},
            'stats': rpt.compute(g.get('trades') or [], g.get('summary') or {},
                                 g.get('spec') or {}),
            'journal': rpt.journal(g.get('trades') or [], g.get('summary') or {})}


@app.delete('/api/backtest/{bid}')
def backtest_delete(bid: int):
    g = store.get_backtest(bid, with_trades=False)
    if g and g['status'] == 'running':
        return JSONResponse({'ok': False, 'error': 'still running'}, status_code=200)
    return {'ok': store.delete_backtest(bid)}


@app.get('/api/strategy/explain')
def strategy_explain_route(name: str, symbol: str, day: str,
                           tf: str = '1m', feed: str = 'polygon'):
    """SIGNAL FUNNEL (GET, browser-friendly): why didn't a strategy fire?
    Evaluates every entry step — and every rule inside it — independently on
    one symbol+day, reporting true-bar counts. The 0-count rule is the blocker.
    /api/strategy/explain?name=RubberBand%20Scalp%20(Short)&symbol=VEEE&day=2026-07-14
    """
    match = [s for s in store.list_strategies() if s.get('name') == name]
    if not match:
        return {'ok': False, 'error': f'no strategy named {name!r}',
                'have': [s.get('name') for s in store.list_strategies()]}
    try:
        return strat.explain_entry(match[0], str(symbol).upper(), tf, 1,
                                   feed=feed, view='all', asof=day)
    except Exception as e:                        # noqa: BLE001
        return {'ok': False, 'error': str(e)}


@app.get('/api/strategy/explain_scan')
def strategy_explain_scan(name: str, day: str, tf: str = '1m',
                          feed: str = 'polygon', register: str = 'R1'):
    """CANDIDATE SWEEP: run the explain funnel over EVERY symbol in that day's
    frozen register and rank who came closest to firing — so hunting for the
    right test day/symbol is a query, not chart-scrolling without dates.
    /api/strategy/explain_scan?name=RubberBand%20Scalp%20(Short)&day=2026-07-07
    """
    match = [s for s in store.list_strategies() if s.get('name') == name]
    if not match:
        return {'ok': False, 'error': f'no strategy named {name!r}',
                'have': [s.get('name') for s in store.list_strategies()]}
    from chart import screener as sc
    reg = sc.register_rows(register, day)
    if not reg.get('ok'):
        return {'ok': False, 'error': f"register fetch failed: {reg.get('error')}"}
    symbols = []
    for r in reg.get('rows') or []:
        t = str(r.get('ticker') or '').upper()
        if t and t not in symbols:
            symbols.append(t)
    if not symbols:
        return {'ok': True, 'day': day, 'rows': [],
                'note': f'{register} register has no tickers on {day}'}
    out = []
    for sym in symbols:
        try:
            e = strat.explain_entry(match[0], sym, tf, 1,
                                    feed=feed, view='all', asof=day)
            steps = [st.get('true_bars', 0) for st in (e.get('steps') or [])]
            out.append({'symbol': sym, 'fires': int(e.get('sequence_fires') or 0),
                        'step_true_bars': steps})
        except Exception as ex:                     # noqa: BLE001
            out.append({'symbol': sym, 'error': str(ex)})
    def _rank(r):
        st = r.get('step_true_bars') or []
        return (-(r.get('fires') or 0),
                -sum(1 for x in st if x > 0),
                -(st[-1] if st else 0))
    out.sort(key=_rank)
    return {'ok': True, 'day': day, 'strategy': name, 'rows': out,
            'note': 'ranked by: sequence fires, then how many steps fired at '
                    'all, then final-step true bars. Drill into a symbol with '
                    '/api/strategy/explain for per-rule counts + without_this.'}


@app.post('/api/alerts/start')
def alerts_start(interval: int = 0):
    """Start the live signal watcher: today's R1 + Shortlist x every saved
    strategy, one scan per `interval` seconds (default 60, min 15). 0 = keep
    the current interval. (No PEP-604 unions in ROUTE signatures — FastAPI
    evaluates them at import and the server runs Python 3.9.)"""
    from chart import alerts
    return alerts.start(interval or None)


@app.post('/api/alerts/stop')
def alerts_stop():
    from chart import alerts
    return alerts.stop()


@app.get('/api/alerts/status')
def alerts_status():
    from chart import alerts
    return alerts.status()


@app.get('/api/alerts/recent')
def alerts_recent(since_ts: int = 0):
    """Alerts newer than since_ts (epoch s) — the UI polls this and turns each
    row into a sound + browser notification."""
    from chart import alerts
    return {'alerts': alerts.recent(since_ts)}


@app.post('/api/setup/decide')
def setup_decide(payload: dict = Body(...)):
    """Run a strategy across a universe on one date and return the RANKED picks.

    The last step of a setup that a strategy cannot take: evaluate() sees one
    symbol, and the setup trades only the strongest few of the day's signals.
    Same ranking metric as a backtest — chart.backtest.rank_metric, imported
    rather than restated — so a live pick and a backtested pick are scored by
    one definition.

    Body: {strategy_id | strategies, symbols[], date, tf, feed, top_n, target_r}

    `feed` defaults to yahoo because this is the live path: polygon is a day
    behind on the free plan and would return nothing for today, and alpaca's
    free tier is IEX.
    """
    try:
        from chart import decide as dec
        strategies = payload.get('strategies')
        if not strategies:
            sid = payload.get('strategy_id')
            if not sid:
                return JSONResponse({'ok': False,
                                     'error': 'strategies or strategy_id required'})
            # Every strategy whose name starts with the id — a setup is usually
            # a long and a short saved as a pair.
            allst = store.list_strategies()
            strategies = [s for s in allst
                          if str(s.get('id')) == str(sid)
                          or str(s.get('name', '')).startswith(str(sid))]
            if not strategies:
                return JSONResponse({'ok': False, 'error': f'no strategy for {sid!r}'})

        symbols = [str(s).upper().strip() for s in (payload.get('symbols') or []) if str(s).strip()]
        if not symbols:
            return JSONResponse({'ok': False, 'error': 'symbols required'})

        from chart import oplog
        with oplog.timed('decide',
                         setup=str(payload.get('strategy_id') or ''),
                         date=str(payload.get('date') or ''),
                         symbols=len(symbols),
                         fill=str(payload.get('fill') or 'close'),
                         tf=payload.get('tf', '1m'),
                         feed=payload.get('feed', 'yahoo')) as _t:
            out = dec.decide(
                strategies, symbols,
                date=str(payload.get('date') or ''),
                tf=payload.get('tf', '1m'),
                feed=payload.get('feed', 'yahoo'),
                # 0 = take every signal. NOT 2: a silent top-2 is the same error
                # as a silent metric, one layer down.
                top_n=int(payload.get('top_n') or 0),
                metric=payload.get('metric') or None,
                direction=payload.get('direction') or None,
                ctx=payload.get('ctx') or None,
                target_r=float(payload.get('target_r') or 2.0),
                days=int(payload.get('days') or 2),
                # 'close' fills at the signal bar's close; 'next_open' at the
                # following bar's open, which is what a market order really gets.
                # It moves the entry, and with it the risk, the target and the
                # ranking metric, so it is a caller's decision rather than a default
                # nobody chose.
                fill=str(payload.get('fill') or 'close'),
                # Defaults to the BACKTEST's default so the two see the same bars.
                # 'regular' was hardcoded here and it changed every rolling
                # indicator's warm-up — see the note in decide.evaluate_symbol.
                view=str(payload.get('view') or 'all'),
            )
            # THE SHAPE OF THE ANSWER, never the answer. "0 picks from 39
            # symbols with 2 errors" is the line that explains a quiet morning;
            # the picks themselves are already in the alert feed.
            _c = (out or {}).get('counts') or {}
            _t.add(picks=len((out or {}).get('picks') or []),
                   evaluated=_c.get('evaluated'),
                   signalled=_c.get('signalled'),
                   errored=_c.get('errored'),
                   ok=bool((out or {}).get('ok', True)))
        return JSONResponse(out)
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


@app.post('/api/strategy/exit_plan')
def strategy_exit_plan(payload: dict = Body(...)):
    """The legs, the runner and the stop behaviour for one strategy at a price.

    The ONLY place this arithmetic lives. The screener has to know how many
    orders a signal becomes and what goes in each, and re-deriving that on the
    other side of the wire is how the live orders stop matching the backtest —
    the same mistake the exit protocol was written to end. So the answer is
    served, not copied.

    Body: {name | strategy_id, side, entry, stop, target_r}
    """
    try:
        entry = float(payload.get('entry'))
        stop = float(payload.get('stop'))
    except (TypeError, ValueError):
        return JSONResponse({'ok': False, 'error': 'entry and stop are required numbers'},
                            status_code=200)
    st = None
    if payload.get('strategy_id'):
        st = store.get_strategy(int(payload['strategy_id']))
    elif payload.get('name'):
        want = str(payload['name']).strip()
        st = next((x for x in store.list_strategies() if x.get('name') == want), None)
    if not st:
        return JSONResponse({'ok': False, 'error': 'no such strategy',
                             'have': [x.get('name') for x in store.list_strategies()]},
                            status_code=200)
    from chart import decide as _dec
    side = str(payload.get('side') or st.get('side') or 'long').lower()
    plan = _dec.exit_plan(st, side, entry, stop,
                          target_r=float(payload.get('target_r') or 2.0))
    return {'ok': True, 'name': st.get('name'), 'side': side,
            'entry': entry, 'stop': stop, 'plan': plan}


@app.post('/api/strategy/manage')
def strategy_manage(payload: dict = Body(...)):
    """What to do with a position that is already open.

    The half a broker cannot hold: an exit RULE (no broker watches for a VWAP
    cross) and a stop that MOVES (a broker is handed one price and keeps it).
    Answered from the same functions the backtest uses, so the live position is
    managed by the strategy rather than by a second reading of it.

    Body: {name | strategy_id, symbol, side, entry, entry_iso, stop_at_entry,
           tf, feed, days, asof, drop_last}
    """
    try:
        st = None
        if payload.get('strategy_id'):
            st = store.get_strategy(int(payload['strategy_id']))
        elif payload.get('name'):
            want = str(payload['name']).strip()
            st = next((x for x in store.list_strategies() if x.get('name') == want), None)
        if not st:
            return JSONResponse({'ok': False, 'error': 'no such strategy',
                                 'have': [x.get('name') for x in store.list_strategies()]},
                                status_code=200)
        from chart import manage as _mg
        stop = payload.get('stop_at_entry')
        return JSONResponse(_mg.manage(
            st,
            symbol=str(payload.get('symbol', '')).upper(),
            side=str(payload.get('side') or st.get('side') or 'long'),
            entry=float(payload.get('entry')),
            entry_iso=payload.get('entry_iso') or None,
            tf=payload.get('tf', '1m'),
            feed=payload.get('feed', 'yahoo'),
            days=int(payload.get('days', 2)),
            view=payload.get('view', 'regular'),
            asof=payload.get('asof') or None,
            stop_at_entry=(None if stop in (None, '') else float(stop)),
            drop_last=bool(payload.get('drop_last')),
        ))
    except Exception as e:                                # noqa: BLE001
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


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
    stats. Body: {strategy, symbol, tf, days, feed, view, asof, fill, rules}.
    fill + rules let the UI REPLAY a backtest's exact settings on the chart —
    without them a preview (close fill, no session rules) can legitimately
    show a different trade than the backtest took."""
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
            rules=payload.get('rules') or None,
        )
        return JSONResponse(out)
    except Exception as e:
        return JSONResponse({'ok': False, 'error': str(e)}, status_code=200)


def _snapshot(symbol: str, tf: str, days: int, feed: str, view: str,
              overlays: list, asof: str | None = None) -> dict:
    """Candles + indicator series for the requested window.

    The FETCH is extended so every indicator has its warm-up history BEFORE
    the window starts (a 5-day MA needs ~9 days of bars before its first
    value, so on a 20-day chart it would otherwise be blank for the first
    third). Those extra bars exist only to feed the maths — the RESULT is
    sliced back to the days that were asked for, so "Days: 20" still draws 20
    days, now with every indicator running edge to edge.

    `asof` (YYYY-MM-DD) replays the stock as of a historical register date.
    """
    want = int(days)
    fetched = dm.required_days(overlays, tf, want)
    out = cs.compute_data(symbol=symbol.upper(), tf=tf, days=fetched,
                          overlays=overlays, feed=feed, view=view,
                          asof=asof or None)
    bars = out.get('bars') or []
    if bars and fetched > want:
        # keep the LAST `want` days of the fetched span; the warm-up bars have
        # done their job inside the indicator maths already
        import pandas as _pd
        cutoff = int((_pd.Timestamp(bars[-1]['time'], unit='s', tz='UTC')
                      - _pd.Timedelta(days=want)).timestamp())
        vis = [b for b in bars if b['time'] >= cutoff]
        if vis:                       # never slice the chart away to nothing
            out['bars'] = vis
            out['series'] = [
                {**s, 'values': [v for v in (s.get('values') or [])
                                 if v['time'] >= cutoff]}
                for s in (out.get('series') or [])]
            out['day_starts'] = [d for d in (out.get('day_starts') or [])
                                 if (d.get('time') if isinstance(d, dict) else d) >= cutoff]
            out['first'] = (_pd.Timestamp(vis[0]['time'], unit='s', tz='UTC')
                            .tz_convert(cs._ET).strftime('%Y-%m-%d %H:%M ET'))
            out['warmup_days'] = fetched - want
    # NEVER silently under-warm an indicator: Alpaca's 1m feed is capped to a
    # 7-day window inside prepare_bars, so anything needing more history
    # (month VWAP, weekly levels, 5-day MA) is computed on a truncated window.
    if tf == '1m' and feed == 'alpaca' and fetched > 7:
        out['warn'] = (f'alpaca 1m is capped to a 7-day window but these '
                       f'overlays need ~{fetched} days of history — multi-day '
                       f'VWAPs/levels are UNRELIABLE here. Use the polygon '
                       f'feed (or a coarser TF) for them.')
    # the per-timeframe ceiling can bite before the warm-up is satisfied; say
    # so rather than let a long indicator start part-way across the chart
    elif fetched >= dm._MAX_DAYS.get(tf, 400) and fetched < want + dm.required_days(
            overlays, tf, 0):
        out['warn'] = (f'{tf} fetches are capped at {fetched} days, which is '
                       f'less than this window plus the warm-up these overlays '
                       f'need — the longest ones may start part-way in. Use a '
                       f'coarser timeframe or fewer days.')
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


def _print_window(day: str, days_before: int, days_after: int):
    """The print window for register day `day`, in ET, as (start, end).

    `days_before`/`days_after` count TRADING days, not calendar days — "one
    day before a Monday" is the previous SESSION (Friday), which is the whole
    point of the context day: its post-market and the overnight into the
    register morning's premarket. Counting calendar days landed on Sunday and
    silently produced a chart with no context bars at all.

    The window always spans full extended hours: 04:00 ET on the first day
    through 20:00 ET on the last.
    """
    import pandas as _pd
    d0 = _pd.Timestamp(day).normalize()
    nb, na = max(0, int(days_before)), max(0, int(days_after))
    # bdate_range = Mon-Fri. Exchange holidays are not modelled: a holiday in
    # the span just yields a day with no bars, exactly like any other empty
    # symbol/day, and is reported as "no bars in window" rather than guessed at.
    first = _pd.bdate_range(end=d0, periods=nb + 1)[0] if nb else d0
    last = _pd.bdate_range(start=d0, periods=na + 1)[-1] if na else d0
    return (_pd.Timestamp(first.strftime('%Y-%m-%d') + ' 04:00', tz=cs._ET),
            _pd.Timestamp(last.strftime('%Y-%m-%d') + ' 20:00', tz=cs._ET))


def _print_span(w_start, w_end) -> int:
    """CALENDAR days the fetch must cover to fill a print window — the window
    is measured in trading days but the loader fetches calendar days, so a
    weekend inside it has to be paid for."""
    return max(1, int((w_end - w_start).total_seconds() // 86400) + 1)


# ── THE SWING SHEET ───────────────────────────────────────────────────────
#
# The register print sheet above is a DAY TRADE sheet and everything about it
# says so: 1-minute bars, a window of one or two sessions, extended hours
# shaded because the premarket is where the setup forms. It answers "what did
# this stock do on the morning it was found".
#
# A swing sheet asks a different question, and none of those choices survive
# the change:
#
#     where was this stock in its OWN year before the scanner found it —
#     at a high, at a base, halfway down a decline — and what has it done in
#     every session SINCE?
#
# So: daily bars, at least a year of them before the day it was found, and
# then every bar after it up to the last one that exists. The found day is
# MARKED, which is the one rule the intraday sheet deliberately breaks the
# other way ("the register day gets no special colour") — there the window is
# two sessions wide and you can see which is which, here it is one bar in
# three hundred and unmarked it cannot be found at all.
#
# ONE TRADING YEAR. 252 sessions is the convention and it is the right default
# for the question: it puts the 52-week high and low on the chart, which is
# what "where is it in its own range" means to anyone reading one.
_SWING_LOOKBACK = 252
# Coarser than 1d is a different sheet; finer cannot hold a year. Held to the
# timeframes whose bars ARE sessions, because "the day it was found" has to be
# one bar for the mark to mean anything.
_SWING_TFS = ('1d',)


def _swing_window(day: str, lookback: int):
    """(window start, fetch calendar days) for a swing sheet anchored on `day`.

    The window runs `lookback` TRADING days before the found day and then
    forward to NOW — not to a fixed number of days after. "Until the last
    available day" is the whole ask: a name found three weeks ago has three
    weeks of follow-through and one found in January has seven months, and
    both are the honest answer for that name rather than a window someone
    chose.

    Returns the ET start and the CALENDAR days a loader must fetch to cover
    start → now, because loaders take calendar days and a trading-day window
    has to pay for its weekends.
    """
    import pandas as _pd
    d0 = _pd.Timestamp(day).normalize()
    nb = max(1, int(lookback))
    first = _pd.bdate_range(end=d0, periods=nb + 1)[0]
    w_start = _pd.Timestamp(first.strftime('%Y-%m-%d') + ' 00:00', tz=cs._ET)
    now = _pd.Timestamp.now(tz=cs._ET)
    # +1 so the boundary day is inside the fetch rather than exactly on its edge.
    return w_start, max(1, int((now - w_start).total_seconds() // 86400) + 2)


def _swing_stats(bars: list, found_ts: int) -> dict:
    """What the sheet exists to produce: where it was when it was found, and
    what has happened since.

    NOT a backtest and deliberately not dressed as one. There is no entry, no
    stop and no exit here — a name being on a register is not a trade. These
    are four facts about the bars: what it closed at that day, where it is
    now, the best it got, and the worst. Anyone reading a swing sheet is
    asking exactly those, and reading them off three hundred candles by eye is
    how you end up remembering the winners.

    MFE AND MAE ARE BOTH REPORTED, and the adverse one is not optional. A
    sheet that showed only "+37% since" would be a machine for making every
    register look good — the name that went to +37% after first going to −22%
    is a different name, and the −22% is the half that decides whether it was
    holdable.
    """
    after = [b for b in bars if b['time'] > found_ts]
    found = next((b for b in bars if b['time'] == found_ts), None)
    if not found:
        return {}
    ref = float(found['close'])
    out = {'close': ref, 'bars_before': sum(1 for b in bars if b['time'] < found_ts),
           'bars_after': len(after)}
    if not after or not ref:
        return out
    hi = max(float(b['high']) for b in after)
    lo = min(float(b['low']) for b in after)
    last = float(after[-1]['close'])
    out.update({
        'last': last,
        'since_pct': round((last - ref) / ref * 100, 2),
        'max_up_pct': round((hi - ref) / ref * 100, 2),
        'max_dn_pct': round((lo - ref) / ref * 100, 2),
        'high': hi, 'low': lo,
    })
    return out


def _build_swing_sheets(start: str, end: str, day: str, tf: str, feed: str,
                        overlays: str, register: str, lookback: int):
    """Daily bars for every ticker of every register day in a range, from a
    year before the day it was found through to the last bar that exists.

    Same contract as _build_sheets — the payload BOTH the sheet and the CSV
    are built from, so the two can never disagree about a number.
    """
    import json as _json
    import pandas as _pd
    if day and not start and not end:
        start = end = day
    start = start or end
    end = end or start
    if not start:
        return [], [], [], '', 'need a date (start/end, or day)'
    if tf not in _SWING_TFS:
        return [], [], [], '', (f'a swing sheet needs session bars — {tf} is not '
                                f'one of {", ".join(_SWING_TFS)}')
    try:
        ovs = _json.loads(overlays) if overlays else []
    except _json.JSONDecodeError:
        ovs = []
    rng = start if start == end else f'{start} → {end}'

    have = sc.available_dates(register) or []
    days = sorted(d for d in have if str(start) <= d <= str(end))
    if not days:
        return [], [], ovs, rng, f'no frozen {register} days between {start} and {end}'

    sheets, errors = [], []
    for d in days:
        reg = sc.register_rows(register, d, full=True)
        if not reg.get('ok'):
            errors.append(f'{d}: register fetch failed ({reg.get("error")})')
            continue
        tickers, cards, seen = [], {}, set()
        for r in reg.get('rows') or []:
            t = str(r.get('ticker') or '').strip().upper()
            if t and t not in seen:
                seen.add(t); tickers.append(t); cards[t] = r
        if not tickers:
            errors.append(f'{d}: no tickers')
            continue

        w_start, span = _swing_window(d, lookback)
        lo_ts = int(w_start.timestamp())
        need = dm.required_days(ovs, tf, span)
        # The found day, as the ET calendar date its bar carries. Daily bars are
        # stamped at the session date, so the mark is found by DATE rather than
        # by an assumed hour — the hour differs between loaders and an assumed
        # one would mark nothing on the feed that disagreed.
        want_date = str(_pd.Timestamp(d).date())

        charts = []
        for sym in tickers:
            if len(charts) >= _PRINT_MAX_CHARTS:
                errors.append(f'{d}: stopped at {_PRINT_MAX_CHARTS} charts — '
                              f'{len(tickers) - len(charts)} more ticker(s) NOT drawn. '
                              'Narrow the day range or the register.')
                break
            try:
                # LIVE, not `asof`. The sheet runs to the last bar that exists,
                # which is the point of it — anchoring to the found day would
                # cut off exactly the half being asked for.
                #
                # view='regular' because a daily bar IS the regular session.
                # With 'all' every bar is stamped at midnight ET, which the
                # session classifier reads as post-market — so a year of daily
                # candles would come back shaded as after-hours from end to end,
                # and the legend would be describing something that is not there.
                data = cs.compute_data(symbol=sym, tf=tf, days=need,
                                       overlays=ovs, feed=feed, view='regular')
                bars = [b for b in (data.get('bars') or []) if b['time'] >= lo_ts]
                if not bars:
                    errors.append(f'{d} {sym}: no daily bars in the window'); continue
                found_ts = next(
                    (b['time'] for b in bars
                     if str(_pd.Timestamp(b['time'], unit='s', tz='UTC')
                            .tz_convert(cs._ET).date()) == want_date), None)
                ser = []
                for sr in (data.get('series') or []):
                    ser.append({**sr, 'values': [v for v in (sr.get('values') or [])
                                                 if v['time'] >= lo_ts]})
                ch = {'symbol': sym, 'bars': bars, 'series': ser,
                      'card': cards.get(sym) or {}}
                if found_ts is None:
                    # SAID, not skipped. No bar on the day the scanner found it
                    # means a halt, a holiday, or a symbol that has since been
                    # renamed — and an unmarked chart that looked like every
                    # other one would be read as "it was found here", pointing
                    # at nothing.
                    errors.append(f'{d} {sym}: no daily bar ON the found day — '
                                  'drawn without a mark')
                else:
                    ch['found'] = {'time': found_ts, 'date': d,
                                   **_swing_stats(bars, found_ts)}
                # HOW MUCH HISTORY ACTUALLY ARRIVED. The feed decides this, not
                # the request: Yahoo serves at most a year of daily bars per
                # call whatever was asked for, so "one year before the found
                # day" can come back as a chart that starts ON it. Unmarked,
                # that reads as a stock that listed the week it was scanned.
                ch['history_days'] = (ch.get('found') or {}).get('bars_before', 0)
                charts.append(ch)
            except Exception as e:      # one bad symbol never kills the sheet
                errors.append(f'{d} {sym}: {e}')
            finally:
                data = None
        if charts:
            short = [c['symbol'] for c in charts
                     if c.get('found') and c['history_days'] < lookback * 0.75]
            if short:
                errors.append(
                    f'{d}: less than {lookback} sessions of history before the found '
                    f'day for {", ".join(short[:8])}'
                    + (f' +{len(short) - 8} more' if len(short) > 8 else '')
                    + f' — the {feed} feed did not return it. A newly listed stock '
                    'looks the same as a truncated fetch; polygon serves the longer '
                    'history.')
            sheets.append({'day': d, 'charts': charts})
    return sheets, errors, ovs, rng, ''


def _build_sheets(start: str, end: str, day: str, tf: str, feed: str,
                  overlays: str, register: str, days_before: int, days_after: int):
    """Bars + indicator series for every ticker of every register day in a
    range — the payload BOTH the print sheet and the CSV export are built
    from, so the two can never disagree about a number.

    Returns (sheets, errors, ovs, rng, err_msg). `err_msg` non-empty means the
    request itself was unusable (no date, or no frozen day in the range) and
    nothing was fetched.

    Window per register day D: `days_before` TRADING days before D through
    `days_after` TRADING days after D, all in FULL extended hours
    (04:00-20:00 ET) — see _print_window.
    """
    import json as _json
    if day and not start and not end:
        start = end = day
    start = start or end
    end = end or start
    if not start:
        return [], [], [], '', 'need a date (start/end, or day)'
    try:
        ovs = _json.loads(overlays) if overlays else []
    except _json.JSONDecodeError:
        ovs = []
    rng = start if start == end else f'{start} → {end}'

    # which register days actually exist in the range
    have = sc.available_dates(register) or []
    days = sorted(d for d in have if str(start) <= d <= str(end))
    if not days:
        return [], [], ovs, rng, f'no frozen {register} days between {start} and {end}'

    sheets, errors = [], []
    for d in days:
        # full=True: keep the WHOLE register row, not just the ticker. This is
        # the screener's own card — score, rvol, gap, regime, sector, catalyst,
        # and every other column it froze that morning. It was being fetched
        # and thrown away, so the sheet showed a chart with no idea WHY the
        # stock was on the register.
        reg = sc.register_rows(register, d, full=True)
        if not reg.get('ok'):
            errors.append(f'{d}: register fetch failed ({reg.get("error")})')
            continue
        tickers, cards, seen = [], {}, set()
        for r in reg.get('rows') or []:
            t = str(r.get('ticker') or '').strip().upper()
            if t and t not in seen:
                seen.add(t); tickers.append(t); cards[t] = r
        if not tickers:
            errors.append(f'{d}: no tickers')
            continue

        charts = _charts_for_day(d, tickers, cards, tf, feed, ovs,
                                 days_before, days_after, errors)
        if charts:
            sheets.append({'day': d, 'charts': charts})
    return sheets, errors, ovs, rng, ''


def _charts_for_day(d: str, tickers: list, cards: dict, tf: str, feed: str,
                    ovs: list, days_before: int, days_after: int,
                    errors: list) -> list:
    """Bars + indicator series for each ticker, over ONE anchor day's window.

    Shared by the register sheet (every ticker of a frozen day) and the
    ticker-list sheet (an explicit set of dates you name), so both produce
    byte-identical charts for the same (ticker, day) — the only difference is
    how the list of tickers was chosen.
    """
    w_start, w_end = _print_window(d, days_before, days_after)
    lo_ts, hi_ts = int(w_start.timestamp()), int(w_end.timestamp())
    # the fetch must END after the window, so asof is the window's LAST day
    asof = w_end.strftime('%Y-%m-%d')
    span = _print_span(w_start, w_end)
    need = dm.required_days(ovs, tf, span)

    charts = []
    for sym in tickers:
        # TRUNCATE LOUDLY. A sheet that quietly stopped at the cap would be read
        # as "only this many names qualified", which is a different and much
        # more damaging statement than "the sheet was too big".
        if len(charts) >= _PRINT_MAX_CHARTS:
            errors.append(f'{d}: stopped at {_PRINT_MAX_CHARTS} charts — '
                          f'{len(tickers) - len(charts)} more ticker(s) NOT drawn. '
                          'Narrow the day range or the register.')
            break
        try:
            data = cs.compute_data(symbol=sym, tf=tf, days=need, overlays=ovs,
                                   feed=feed, view='all', asof=asof)
            bars = [b for b in (data.get('bars') or [])
                    if lo_ts <= b['time'] <= hi_ts]
            if not bars:
                errors.append(f'{d} {sym}: no bars in window'); continue
            ser = []
            for sr in (data.get('series') or []):
                ser.append({**sr, 'values': [v for v in (sr.get('values') or [])
                                             if lo_ts <= v['time'] <= hi_ts]})
            charts.append({'symbol': sym, 'bars': bars, 'series': ser,
                           'card': (cards or {}).get(sym) or {}})
        except Exception as e:          # one bad symbol never kills the sheet
            errors.append(f'{d} {sym}: {e}')
        finally:
            # `data` holds up to _MAX_DAYS[tf] days of bars plus every overlay
            # series computed across them — tens of thousands of rows, to keep
            # the ~1,900 inside the window. Dropped the moment it is filtered,
            # so the peak is ONE ticker's history rather than the whole sheet's.
            data = None
    return charts


_TICKER_RE = __import__('re').compile(r'[A-Z][A-Z0-9.\-]{0,5}')
_DATE_RE = __import__('re').compile(r'\d{4}-\d{2}-\d{2}')


def parse_pairs(text: str) -> list:
    """Read a pasted list of (TICKER, YYYY-MM-DD) pairs, tolerantly.

    Accepts whatever a spreadsheet or a chat message actually produces:
    `WLDS,2026-07-24` one per line, tab-separated columns, a numbered table,
    or the same table pasted VERTICALLY (one cell per line). The rule is
    simply: walk the tokens, remember the last thing that looks like a ticker,
    and when a date appears, pair them.

    Deliberately ignores the surrounding columns (result, entry, catalyst…) —
    the card shown on the chart comes from the screener's own frozen register
    row, not from retyped numbers that could disagree with it.

    Returns [(TICKER, 'YYYY-MM-DD'), ...] in the order given, de-duplicated.
    """
    out, seen, last = [], set(), None
    for tok in __import__('re').split(r'[\s,;|]+', text or ''):
        tok = tok.strip()
        if not tok:
            continue
        if _DATE_RE.fullmatch(tok):
            if last:
                key = (last, tok)
                if key not in seen:
                    seen.add(key); out.append(key)
                last = None          # one date per ticker; don't re-use it
        elif _TICKER_RE.fullmatch(tok):
            last = tok
    return out


def _parse_trades(trades_json: str) -> dict:
    """(SYMBOL, date) → the trade to mark on that chart.

    Kept OUT of parse_pairs, which deliberately ignores the columns beside a
    ticker: the card drawn on a register chart comes from the screener's own
    frozen row, never from retyped numbers that could disagree with it.

    A trade is a different kind of fact. It is not a claim about what the
    market did — it is the record of what YOU did, and nothing else holds it.
    So it arrives explicitly, as JSON, and is drawn exactly as given.

    Each entry: {symbol, date, entry_ts, exit_ts, entry, exit, side}, with
    timestamps in epoch SECONDS to match the bar times.
    """
    import json as _json
    try:
        rows = _json.loads(trades_json) if trades_json else []
    except _json.JSONDecodeError:
        return {}
    out = {}
    for r in (rows if isinstance(rows, list) else []):
        if not isinstance(r, dict):
            continue
        sym = str(r.get('symbol') or '').upper().strip()
        day = str(r.get('date') or '').strip()
        if not sym or not _DATE_RE.fullmatch(day):
            continue
        out[(sym, day)] = r
    return out


def _build_pair_sheets(pairs_text: str, tf: str, feed: str, overlays: str,
                       days_before: int, days_after: int, register: str = 'R1',
                       trades_json: str = ''):
    """The same sheet payload as _build_sheets, but for an EXPLICIT list of
    (ticker, date) pairs instead of whole register days — a trade journal, a
    review list, "these 13 names on these 13 days".

    Pairs are grouped by date so each date is one section, exactly like a
    register day, and the SAME ticker on two different dates is two charts
    (that is the normal case in a journal). Where a named ticker happens to
    have been on that day's register, its frozen card is attached too.
    """
    import json as _json
    try:
        ovs = _json.loads(overlays) if overlays else []
    except _json.JSONDecodeError:
        ovs = []
    marks = _parse_trades(trades_json)
    pairs = parse_pairs(pairs_text)
    if not pairs:
        return [], [], ovs, '', ('no TICKER + YYYY-MM-DD pairs found — paste '
                                 'lines like "WLDS,2026-07-24"')
    by_day: dict = {}
    for sym, d in pairs:
        by_day.setdefault(d, [])
        if sym not in by_day[d]:
            by_day[d].append(sym)
    days = sorted(by_day)
    rng = days[0] if len(days) == 1 else f'{days[0]} → {days[-1]}'

    sheets, errors = [], []
    for d in days:
        # the register card is a BONUS here: these dates need not be register
        # days at all, so a miss is silent — never an error.
        cards = {}
        try:
            reg = sc.register_rows(register, d, full=True)
            if reg.get('ok'):
                for r in reg.get('rows') or []:
                    t = str(r.get('ticker') or '').strip().upper()
                    if t:
                        cards[t] = r
        except Exception:               # noqa: BLE001 — cards are optional
            pass
        charts = _charts_for_day(d, by_day[d], cards, tf, feed, ovs,
                                 days_before, days_after, errors)
        # YOUR trade on that chart, when one was supplied. Attached here rather
        # than inside _charts_for_day because a register sheet has no trades to
        # attach — the same chart builder serves both.
        for c in charts:
            mk = marks.get((str(c.get('symbol') or '').upper(), d))
            if mk:
                c['trade'] = mk
        if charts:
            sheets.append({'day': d, 'charts': charts})
    return sheets, errors, ovs, rng, ''


@app.get('/api/r1/print', response_class=HTMLResponse)
def r1_print(start: str = '', end: str = '', day: str = '', tf: str = '1m',
             feed: str = 'polygon', overlays: str = '[]', register: str = 'R1',
             days_before: int = 1, days_after: int = 0,
             cols: int = 1, height: int = 420):
    """PRINT SHEET: one chart per ticker, for EVERY register day in a range.

    Window per register day D: `days_before` TRADING days before D through
    `days_after` TRADING days after D, all in FULL extended hours
    (04:00-20:00 ET). So the previous session's post-market, the overnight,
    D's premarket/RTH/post-market — and, with days_after, how it followed
    through — are on one chart.

    Every day in the window is drawn IDENTICALLY — the register day gets no
    special colour. Only the SESSION is coloured: premarket and post-market
    are shaded on all days, the regular session is left plain.

    `start`/`end` select the range (inclusive); `day` is accepted as a
    shorthand for start=end=day. Everything is computed by the SAME
    cs.compute_data() the live chart uses; /api/r1/csv exports these exact
    numbers as a spreadsheet.
    """
    if not _PRINT_LOCK.acquire(blocking=False):
        # RECORDED, because a refusal is the interesting event: it means two
        # sheets were started together, which is the shape of the crash this
        # lock exists to prevent.
        from chart import oplog
        oplog.record('print_refused', ok=False, reason='another sheet is building')
        return _print_busy()
    try:
        sheets, errors, ovs, rng, bad = _build_sheets(
            start, end, day, tf, feed, overlays, register, days_before, days_after)
    finally:
        # Released as soon as the BARS are in hand. Rendering the page is string
        # work on data already held — it does not fetch, and holding the lock
        # across it would serialise two cheap operations behind one expensive one.
        _PRINT_LOCK.release()
    if bad:
        return HTMLResponse(f'<h3>{bad}</h3>')
    from urllib.parse import urlencode as _ue
    csv_qs = _ue({'start': start or day, 'end': end or day, 'day': day, 'tf': tf,
                  'feed': feed, 'overlays': overlays, 'register': register,
                  'days_before': days_before, 'days_after': days_after})
    cards_qs = _ue({'start': start or day, 'end': end or day, 'day': day,
                    'register': register})
    return _sheet_page(sheets, errors, ovs, register, rng, tf, feed,
                       days_before, days_after, cols, height,
                       csv_url=f'/api/r1/csv?{csv_qs}',
                       cards_url=f'/api/r1/cards.csv?{cards_qs}',
                       day_prefix='register day ')


@app.get('/api/r1/swing', response_class=HTMLResponse)
def r1_swing(start: str = '', end: str = '', day: str = '', tf: str = '1d',
             feed: str = 'polygon', overlays: str = '[]', register: str = 'R1',
             lookback: int = _SWING_LOOKBACK,
             cols: int = 1, height: int = 420):
    """SWING SHEET: one DAILY chart per register ticker — a year of its own
    history before the day the scanner found it, the found day marked, and
    every session since.

    The other sheet (/api/r1/print) is the day-trade one: 1-minute bars over a
    session or two, extended hours shaded. This answers the other question —
    where was this stock in its own year when it was found, and what has it
    done since — and none of those choices survive the change, so the bars are
    daily, the window is a trading year plus everything after, and the found
    day is marked.

    `lookback` counts TRADING days before the found day; 252 is one year.
    There is no `days_after`: the window runs to the last bar that exists,
    which is different for every register day and is the honest answer for
    each.
    """
    if not _PRINT_LOCK.acquire(blocking=False):
        from chart import oplog
        oplog.record('print_refused', ok=False, kind='swing',
                     reason='another sheet is building')
        return _print_busy()
    try:
        sheets, errors, ovs, rng, bad = _build_swing_sheets(
            start, end, day, tf, feed, overlays, register, lookback)
    finally:
        _PRINT_LOCK.release()
    if bad:
        return HTMLResponse(f'<h3>{bad}</h3>')
    from urllib.parse import urlencode as _ue
    csv_qs = _ue({'start': start or day, 'end': end or day, 'day': day, 'tf': tf,
                  'feed': feed, 'overlays': overlays, 'register': register,
                  'lookback': lookback})
    cards_qs = _ue({'start': start or day, 'end': end or day, 'day': day,
                    'register': register})
    return _sheet_page(
        sheets, errors, ovs, f'{register} SWING', rng, tf, feed,
        lookback, 0, cols, height,
        csv_url=f'/api/r1/swing.csv?{csv_qs}',
        cards_url=f'/api/r1/cards.csv?{cards_qs}',
        day_prefix='found on ',
        window_html=(f'window: {lookback} trading days before the found day '
                     '(≈1 year) → the LAST bar available, daily'),
        shade_html=('<span class="sw" style="background:rgba(245,158,11,.55)"></span>'
                    'the day the scanner found it &nbsp;'
                    '<span class="sw" style="background:rgba(16,185,129,.10)"></span>'
                    'every session since &nbsp; · unshaded = its year before'))


@app.get('/api/r1/swing.csv')
def r1_swing_csv(start: str = '', end: str = '', day: str = '', tf: str = '1d',
                 feed: str = 'polygon', overlays: str = '[]', register: str = 'R1',
                 lookback: int = _SWING_LOOKBACK):
    """The swing sheet as a SPREADSHEET — same parameters, same window, same
    numbers, one row per daily bar.

    Two columns the intraday export has no use for: `phase` says whether a bar
    is BEFORE the found day, IS it, or comes AFTER, and `pct_from_found` is
    that bar's close against the found day's close. Those two are what turns a
    pile of OHLC into the question being asked, and computing them in a
    spreadsheet means re-deriving which row was the found day.
    """
    import csv
    import io
    from fastapi.responses import PlainTextResponse
    sheets, errors, _ovs, rng, bad = _build_swing_sheets(
        start, end, day, tf, feed, overlays, register, lookback)
    if bad:
        return PlainTextResponse(bad, status_code=200)
    buf = io.StringIO()
    # Indicator columns, named exactly as the sheet's legend names them, with a
    # #2 suffix for a repeated label — same rule as the intraday export, so the
    # two spreadsheets can be read by the same eyes.
    labels: list = []
    for sh in sheets:
        for c in sh['charts']:
            for sr in c['series']:
                lbl = str(sr.get('name') or '?')
                n, out_lbl = 1, lbl
                while out_lbl in labels:
                    n += 1; out_lbl = f'{lbl} #{n}'
                if out_lbl not in labels:
                    labels.append(out_lbl)
    w = csv.writer(buf)
    w.writerow(['found_day', 'symbol', 'date_et', 'epoch', 'phase',
                'open', 'high', 'low', 'close', 'volume', 'pct_from_found']
               + labels)
    import pandas as pd
    for sh in sheets:
        for c in sh['charts']:
            found = c.get('found') or {}
            f_ts = found.get('time')
            ref = found.get('close')
            by_time = {}
            used: list = []
            for sr in c['series']:
                lbl = str(sr.get('name') or '?')
                n, out_lbl = 1, lbl
                while out_lbl in used:
                    n += 1; out_lbl = f'{lbl} #{n}'
                used.append(out_lbl)
                by_time[out_lbl] = {v['time']: v.get('value')
                                    for v in (sr.get('values') or [])}
            for b in c['bars']:
                et = pd.Timestamp(b['time'], unit='s', tz='UTC').tz_convert(cs._ET)
                phase = ('found' if f_ts is not None and b['time'] == f_ts
                         else 'after' if f_ts is not None and b['time'] > f_ts
                         else 'before' if f_ts is not None else '')
                # BLANK, never zero, when there is nothing to compare against.
                # A 0.0 here reads as "unchanged", which is a measurement.
                pct = ('' if not ref else round((b['close'] - ref) / ref * 100, 4))
                w.writerow([sh['day'], c['symbol'], et.strftime('%Y-%m-%d'),
                            b['time'], phase, b['open'], b['high'], b['low'],
                            b['close'], b['volume'], pct]
                           + [('' if by_time.get(lbl, {}).get(b['time']) is None
                               else by_time[lbl][b['time']]) for lbl in labels])
    if errors:
        # In the FILE, because a spreadsheet is opened away from the page that
        # would otherwise have carried the warning.
        w.writerow([])
        for e in errors[:20]:
            w.writerow(['# skipped', e])
    return PlainTextResponse(buf.getvalue(), media_type='text/csv')


def _print_busy() -> HTMLResponse:
    """What a second print sheet gets while the first is still building.

    A page, not a 503: this is opened in a browser tab, and an error status
    renders as the browser's own failure screen with none of this text on it.
    """
    return HTMLResponse(
        '<body style="background:#fff;color:#111;font:15px system-ui;margin:40px">'
        '<h3 style="margin:0 0 8px">Another print sheet is still building.</h3>'
        '<p style="color:#555;max-width:52ch">Only one runs at a time — each one '
        'fetches weeks of bars for every ticker on the sheet, and three at once '
        'is what takes the server down. Wait for the first tab to finish, then '
        'reload this one.</p></body>')


def _sheet_page(sheets: list, errors: list, ovs: list, title: str, rng: str,
                tf: str, feed: str, days_before: int, days_after: int,
                cols: int, height: int, csv_url: str = '', cards_url: str = '',
                day_prefix: str = '', window_html: str = '',
                shade_html: str = '') -> HTMLResponse:
    """Render a sheet payload as the printable page. ONE renderer for the
    register sheet, the ticker-list sheet and the swing sheet, so a change to
    the legend, the card block or the chart itself reaches all three.

    `window_html` and `shade_html` exist because the two SENTENCES that
    describe a sheet are the two things that do not survive between them. The
    intraday sheet's "−1 → +0 TRADING days (04:00–20:00 ET, pre/post included)"
    and its premarket/post-market swatches are true of a 1-minute session
    window and false of a year of daily bars, where there is no premarket to
    shade and the shading means something else entirely. Left as defaults they
    would be a legend that describes a chart nobody drew — which is worse than
    no legend, because it is read as a fact about the picture."""
    import json as _json
    # LEGEND: name + colour of every indicator line, taken from the series the
    # engine actually produced (not from the request), so the swatch can never
    # disagree with the drawn line. An overlay that errored is listed as such.
    legend, seen_lbl = [], set()
    for sh in sheets:
        for c in sh['charts']:
            for sr in c['series']:
                lbl = str(sr.get('name') or '?')
                key = (lbl, sr.get('color'))
                if key in seen_lbl:
                    continue
                seen_lbl.add(key)
                legend.append({'label': lbl, 'color': sr.get('color') or '#2563eb',
                               'err': bool(sr.get('error'))})
    ind_html = ''.join(
        f'<span class="ind" style="color:{i["color"]}">'
        f'<span class="sw" style="background:{i["color"]}"></span>'
        f'{i["label"]}{" (failed)" if i["err"] else ""}</span>'
        for i in legend) or '<span class="ind">none — add indicators on the chart first</span>'
    ov_names = ', '.join(str(o.get('key', '?')) for o in ovs) or 'none'
    payload = _json.dumps(sheets)
    n_charts = sum(len(s['charts']) for s in sheets)
    err_html = (f'<div class="warn">skipped: {"; ".join(errors[:10])}'
                + (f' … +{len(errors) - 10} more' if len(errors) > 10 else '')
                + '</div>') if errors else ''
    if not sheets:
        return HTMLResponse(f'<h3>nothing to draw — {err_html or "no bars in any window"}</h3>')
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8">
<title>{title} {rng} — print</title>
<script src="/static/lightweight-charts.js"></script>
<style>
 body{{background:#fff;color:#111;font:13px system-ui,Segoe UI,Roboto,sans-serif;margin:14px}}
 h2{{margin:0 0 2px}} .sub{{color:#555;margin-bottom:12px}}
 h3.day{{margin:18px 0 8px;padding:5px 9px;background:#fde68a;border-radius:6px;
   border:1px solid #f0c96a;break-before:page;page-break-before:always}}
 h3.day:first-of-type{{break-before:auto;page-break-before:auto}}
 .warn{{background:#fff4e5;border:1px solid #f0c48a;padding:6px 10px;border-radius:6px;margin-bottom:10px}}
 .grid{{display:grid;grid-template-columns:repeat({max(1, int(cols))},1fr);gap:14px}}
 .card{{border:1px solid #ddd;border-radius:8px;padding:8px;break-inside:avoid;page-break-inside:avoid}}
 .tk{{font-weight:700;font-size:14px}} .rng{{color:#666;font-size:11px}}
 .key{{color:#666;font-size:11px;margin:2px 0 8px}}
 .sw{{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;
   margin:0 4px 0 0;border:1px solid rgba(0,0,0,.45)}}
 .ind{{display:inline-block;margin-right:12px;white-space:nowrap}}
 .card-meta{{font-size:11px;color:#334155;background:#f1f5f9;border:1px solid #e2e8f0;
   border-radius:6px;padding:5px 7px;margin:2px 0 8px;line-height:1.7}}
 .cd{{display:inline-block;margin-right:10px;white-space:nowrap}}
 .cd b{{color:#64748b;font-weight:600}}
 /* The swing line sits between the ticker and the chart because it is the
    conclusion, and a conclusion under the picture is one people scroll past.
    Amber to match the stripe and the arrow on the chart itself — the eye
    should connect the number to the bar without being told to. */
 .swing{{font-size:11.5px;color:#78350f;background:#fef3c7;border:1px solid #fcd34d;
   border-radius:6px;padding:4px 7px;margin:4px 0 6px;line-height:1.6}}
 /* PRINTING: browsers drop every BACKGROUND colour by default, which silently
    erased the whole point of this sheet — the indicator swatches, the
    register-day header and the warning band all came out blank on paper and
    in Save-as-PDF. print-color-adjust:exact keeps them. The swatch also has a
    border, and each indicator's NAME is drawn in its own colour, so the
    legend still identifies every line even in a browser that ignores it. */
 *{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
 @media print{{ body{{margin:0}} .card{{border:1px solid #bbb}} .noprint{{display:none}}
   *{{-webkit-print-color-adjust:exact;print-color-adjust:exact}} }}
</style></head><body>
<h2>{title} · {rng}</h2>
<div class="sub">{n_charts} charts over {len(sheets)} day(s) · {tf} · feed {feed} ·
 {window_html or f'window: −{days_before} → +{days_after} TRADING days (04:00–20:00 ET, pre/post included)'}</div>
<div class="key"><b>indicators:</b> {ind_html}</div>
<div class="key">{shade_html or '''shaded = extended hours on every day:
 <span class="sw" style="background:rgba(59,130,246,.35)"></span>premarket (04:00-09:30)
 <span class="sw" style="background:rgba(168,85,247,.35)"></span>post-market (16:00-20:00)
 &middot; unshaded = regular session'''}</div>
{err_html}
<button class="noprint" onclick="window.print()">🖨 Print / Save as PDF</button>
{f'''<a class="noprint" href="{csv_url}"
   style="display:inline-block;margin-left:8px;padding:6px 12px;background:#059669;color:#fff;
          border-radius:6px;text-decoration:none;font:inherit">⬇ Bars CSV</a>''' if csv_url else ''}
{f'''<a class="noprint" href="{cards_url}"
   style="display:inline-block;margin-left:6px;padding:6px 12px;background:#7c3aed;color:#fff;
          border-radius:6px;text-decoration:none;font:inherit">⬇ Cards CSV</a>''' if cards_url else ''}
<span class="noprint" style="color:#666;font-size:11px;margin-left:8px">bars = OHLCV + every
 indicator value, one row per bar · cards = the register row behind each chart</span>
<div id="root"></div>
<script>
const SHEETS = {payload};
const H = {int(height)};
const root = document.getElementById('root');
const fmt = t => new Date(t*1000).toLocaleString('en-US',
    {{timeZone:'America/New_York', month:'numeric', day:'numeric',
      hour:'2-digit', minute:'2-digit'}});
for (const sheet of SHEETS) {{
  const h = document.createElement('h3'); h.className='day';
  h.textContent = {_json.dumps(day_prefix)} + sheet.day;
  root.appendChild(h);
  const grid = document.createElement('div'); grid.className='grid';
  root.appendChild(grid);
  for (const c of sheet.charts) {{
    const card = document.createElement('div'); card.className='card';
    const a = c.bars[0], z = c.bars[c.bars.length-1];
    const hd = document.createElement('div');
    hd.innerHTML = '<span class="tk">'+c.symbol+'</span> <span class="rng">'
                 + fmt(a.time)+' → '+fmt(z.time)+' ET · '+c.bars.length+' bars</span>';
    card.appendChild(hd);
    // ── WHAT IT HAS DONE SINCE IT WAS FOUND ────────────────────────────
    // The four numbers a swing sheet exists to produce, above the chart
    // rather than inside it: reading them off three hundred candles by eye is
    // how you end up remembering only the winners.
    //
    // BOTH EXCURSIONS, always. A line that showed "+37% since" and nothing
    // else is a machine for making every register look good — the name that
    // reached +37% after first going to −22% is a different name, and the
    // −22% is the half that decides whether it was holdable.
    if (c.found && c.found.bars_after) {{
      const f = c.found;
      const pc = n => (n > 0 ? '+' : '') + n.toFixed(1) + '%';
      const col = f.since_pct >= 0 ? '#15803d' : '#b91c1c';
      const sw = document.createElement('div'); sw.className = 'swing';
      sw.innerHTML =
        '<b>found ' + f.date + '</b> at ' + f.close
        + ' · <span style="color:' + col + ';font-weight:700">' + pc(f.since_pct)
        + '</span> now ' + f.last
        + ' · best ' + pc(f.max_up_pct) + ' · worst ' + pc(f.max_dn_pct)
        + ' · ' + f.bars_after + ' session(s) since'
        + ' · ' + f.bars_before + ' before';
      card.appendChild(sw);
    }} else if (c.found) {{
      const sw = document.createElement('div'); sw.className = 'swing';
      // FOUND TODAY. Nothing has happened yet, and saying so is different from
      // leaving the line off — an absent line reads as a sheet that failed.
      sw.innerHTML = '<b>found ' + c.found.date + '</b> at ' + c.found.close
        + ' · no sessions since yet · ' + c.found.bars_before + ' before';
      card.appendChild(sw);
    }}
    // per-chart indicator legend: name + its exact line colour
    if ((c.series||[]).length) {{
      const lg = document.createElement('div'); lg.className='key';
      // the NAME is drawn in the line's own colour as well as the swatch:
      // text colour always prints, a background swatch only does when the
      // browser honours print-color-adjust (see the @media print block).
      lg.innerHTML = c.series.map(s =>
        '<span class="ind" style="color:'+(s.color||'#2563eb')
        + '"><span class="sw" style="background:'+(s.color||'#2563eb')
        + '"></span>' + (s.name||'?') + (s.error ? ' (failed)' : '') + '</span>').join('');
      card.appendChild(lg);
    }}
    // THE REGISTER CARD — why this stock was on the register that morning.
    // Every field the screener froze, the well-known ones first in a fixed
    // order so the same fact is always in the same place across charts, then
    // anything else it carried, alphabetically. Empty fields are dropped.
    if (c.card && Object.keys(c.card).length) {{
      const FIRST = ['score','price','change','gapPct','rvol','atr','regime',
                     'secBias','sector','bias','catalyst','method','inShortlist'];
      const seen = new Set(['ticker','date']);
      const order = [];
      for (const k of FIRST) if (k in c.card) {{ order.push(k); seen.add(k); }}
      for (const k of Object.keys(c.card).sort()) if (!seen.has(k)) order.push(k);
      const cells = order.map(k => {{
        let v = c.card[k];
        if (v === null || v === undefined || v === '') return '';
        if (typeof v === 'number') v = Math.round(v*10000)/10000;
        return '<span class="cd"><b>'+k+'</b> '+v+'</span>';
      }}).filter(Boolean).join('');
      if (cells) {{
        const cw = document.createElement('div'); cw.className='card-meta';
        cw.innerHTML = cells; card.appendChild(cw);
      }}
    }}
    const box = document.createElement('div'); card.appendChild(box); grid.appendChild(card);
    const ch = LightweightCharts.createChart(box, {{
      width: box.clientWidth, height: H,
      layout:{{background:{{color:'#fff'}}, textColor:'#333'}},
      grid:{{vertLines:{{color:'#eee'}}, horzLines:{{color:'#eee'}}}},
      rightPriceScale:{{borderColor:'#ccc'}},
      timeScale:{{borderColor:'#ccc', timeVisible:true, secondsVisible:false}},
    }});
    // background band: REGISTER DAY gets its own colour; pre/post tinted too
    const bg = ch.addHistogramSeries({{priceScaleId:'bg', priceLineVisible:false,
        lastValueVisible:false}});
    ch.priceScale('bg').applyOptions({{scaleMargins:{{top:0, bottom:0}},
        visible:false}});
    // PRE / POST get their own colour on EVERY day; RTH is plain white, so
    // the register day looks exactly like its context days.
    //
    // ON A SWING SHEET THE RULE IS THE OPPOSITE, and deliberately. There the
    // window is two sessions and you can see which is which; here it is one
    // bar in three hundred, and an unmarked found day cannot be found at all.
    // So that bar gets a strong stripe and everything after it a faint tint —
    // which is the request drawn rather than described: the day it was found,
    // and the days since.
    const F = c.found ? c.found.time : null;
    bg.setData(c.bars.map(b => ({{time:b.time, value:1,
      color: (F !== null && b.time === F) ? 'rgba(245,158,11,.55)'
           : (F !== null && b.time  >  F) ? 'rgba(16,185,129,.10)'
           : b.sess==='pre'  ? 'rgba(59,130,246,.16)'
           : b.sess==='post' ? 'rgba(168,85,247,.16)'
           : 'rgba(0,0,0,0)'}})));
    const cs_ = ch.addCandlestickSeries({{upColor:'#16a34a', downColor:'#dc2626',
        borderUpColor:'#16a34a', borderDownColor:'#dc2626',
        wickUpColor:'#16a34a', wickDownColor:'#dc2626'}});
    cs_.setData(c.bars);
    for (const s of (c.series||[])) {{
      if (!s.values || !s.values.length) continue;
      const ln = ch.addLineSeries({{color:s.color||'#2563eb', lineWidth:1,
          lineStyle:s.style||0, priceLineVisible:false, lastValueVisible:false,
          ...(s.step ? {{lineType:1}} : {{}})}});
      ln.setData(s.values);
    }}
    // ── THE DAY THE SCANNER FOUND IT ─────────────────────────────────────
    // Three marks, because the stripe alone answers only WHEN. The arrow puts
    // the date on the bar so a printed page still says which one it is, and
    // the price line carries the number across the whole chart — that line is
    // what makes "and what has it done since" readable at a glance, because
    // every bar after it is simply above or below it.
    //
    // ONE MARKER LIST FOR THE WHOLE CHART. setMarkers REPLACES rather than
    // adds, so two callers each setting their own means the second silently
    // erases the first — and it erases it on the page, with no error, which is
    // the shape of a bug nobody finds. Both the found day and a trade push
    // here and the list is set once, below.
    const MARKS = [];
    if (c.found) {{
      cs_.createPriceLine({{price:c.found.close, color:'#f59e0b', lineWidth:1,
        lineStyle:2, axisLabelVisible:true, title:'found '+c.found.close}});
      MARKS.push({{time:c.found.time, position:'aboveBar', color:'#d97706',
        shape:'arrowDown', text:'FOUND '+c.found.date}});
    }}
    // ── YOUR TRADE on the chart ──────────────────────────────────────────
    // Drawn three ways because each answers a different question at a glance:
    // arrows say WHEN, price lines say AT WHAT, and the shaded band says how
    // long it was held and what the bars did while it was on. Green or red is
    // taken from the two fills and the side — never from the day's direction,
    // which is a different thing and is what makes a losing short look like a
    // winner on a red day.
    if (c.trade) {{
      const t = c.trade;
      const long_ = String(t.side||'long').toLowerCase() !== 'short';
      const inP = Number(t.entry), outP = Number(t.exit);
      const won = (isFinite(inP) && isFinite(outP))
        ? (long_ ? outP > inP : outP < inP) : null;
      const col = won === null ? '#64748b' : (won ? '#16a34a' : '#dc2626');
      const t0 = Number(t.entry_ts) || null, t1 = Number(t.exit_ts) || null;

      // shade the held bars — visible under the candles, so the eye lands on
      // the window that was actually risked
      if (t0 && t1) {{
        const held = c.bars.filter(b => b.time >= Math.min(t0,t1)
                                     && b.time <= Math.max(t0,t1));
        if (held.length) {{
          const band = ch.addHistogramSeries({{
            priceScaleId:'', priceLineVisible:false, lastValueVisible:false,
            base:0, color:(won===false?'rgba(220,38,38,.10)':'rgba(22,163,74,.10)')}});
          band.priceScale().applyOptions({{scaleMargins:{{top:0, bottom:0}}}});
          band.setData(held.map(b => ({{time:b.time, value:1}})));
        }}
      }}
      // the two fills, as price lines that carry their own number
      if (isFinite(inP)) cs_.createPriceLine({{price:inP, color:'#94a3b8',
        lineWidth:1, lineStyle:2, axisLabelVisible:true,
        title:(long_?'BUY ':'SELL ')+inP}});
      if (isFinite(outP)) cs_.createPriceLine({{price:outP, color:col,
        lineWidth:1, lineStyle:2, axisLabelVisible:true, title:'EXIT '+outP}});
      // and the arrows, on the bars they happened on
      if (t0) MARKS.push({{time:t0, position:(long_?'belowBar':'aboveBar'),
        color:'#94a3b8', shape:(long_?'arrowUp':'arrowDown'),
        text:(long_?'IN':'IN ▼')}});
      if (t1) MARKS.push({{time:t1, position:(long_?'aboveBar':'belowBar'),
        color:col, shape:(long_?'arrowDown':'arrowUp'), text:'OUT'}});
    }}
    // Set ONCE, sorted — the library requires ascending time and drops the
    // whole list if it is not.
    if (MARKS.length) cs_.setMarkers(MARKS.sort((a,b)=>a.time-b.time));
    ch.timeScale().fitContent();
  }}
}}
</script></body></html>""")


@app.get('/api/r1/csv')
def r1_csv(start: str = '', end: str = '', day: str = '', tf: str = '1m',
           feed: str = 'polygon', overlays: str = '[]', register: str = 'R1',
           days_before: int = 1, days_after: int = 0):
    """The print sheet as a SPREADSHEET — same parameters, same window, same
    numbers, one row per bar.

    Columns: register_day, symbol, datetime_et, epoch, session (pre/rth/post),
    open, high, low, close, volume, then ONE COLUMN PER INDICATOR, named
    exactly as the sheet's legend names it. A bar where an indicator is still
    warming up is left EMPTY, never zero-filled — a blank means "no value
    yet", and that distinction is the whole reason to export raw numbers.

    Two indicators can carry the same label (the same primitive added twice on
    the chart, e.g. two 5-day MAs): the duplicate gets a #2 suffix so the
    columns stay addressable instead of one silently overwriting the other.
    """
    import csv
    import io
    import pandas as pd
    from fastapi.responses import PlainTextResponse
    sheets, errors, _ovs, rng, bad = _build_sheets(
        start, end, day, tf, feed, overlays, register, days_before, days_after)
    if bad:
        return PlainTextResponse('# ' + bad, status_code=200)

    body, n_rows = _bars_csv(sheets, errors)
    fname = (f'{register}_{(start or day) or "x"}_{(end or day) or "x"}_{tf}'
             .replace('-', '') + '.csv')
    return PlainTextResponse(
        body, media_type='text/csv; charset=utf-8',
        headers={'Content-Disposition': f'attachment; filename="{fname}"',
                 'X-Rows': str(n_rows)})


def _bars_csv(sheets: list, errors: list):
    """Serialize a sheet payload as the bars CSV — used by BOTH the register
    export and the ticker-list export, so the two files have identical shape.
    Returns (csv_text, n_rows)."""
    import csv
    import io
    import pandas as pd
    # COLUMN ORDER: the union of series labels in the order the sheet lists
    # them, so the spreadsheet reads like the legend. Same (label, colour) key
    # the legend dedupes on — a repeated primitive is a real second column.
    cols, seen = [], set()
    for sh in sheets:
        for c in sh['charts']:
            for sr in c['series']:
                key = (str(sr.get('name') or '?'), sr.get('color'))
                if key not in seen:
                    seen.add(key); cols.append(key)
    names, used = [], {}
    for lbl, _color in cols:
        used[lbl] = used.get(lbl, 0) + 1
        names.append(lbl if used[lbl] == 1 else f'{lbl} #{used[lbl]}')

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(['register_day', 'symbol', 'datetime_et', 'epoch', 'session',
                'open', 'high', 'low', 'close', 'volume'] + names)
    et = cs._ET
    n_rows = 0
    for sh in sheets:
        for c in sh['charts']:
            # each series -> {epoch: value}; a bar with no entry stays blank
            by_key: dict = {}
            for sr in c['series']:
                key = (str(sr.get('name') or '?'), sr.get('color'))
                m = by_key.setdefault(key, {})
                for v in (sr.get('values') or []):
                    m[int(v['time'])] = v.get('value')
            for b in c['bars']:
                t = int(b['time'])
                dt = pd.Timestamp(t, unit='s', tz='UTC').tz_convert(et)
                row = [sh['day'], c['symbol'], dt.strftime('%Y-%m-%d %H:%M:%S'),
                       t, b.get('sess', ''),
                       b.get('open'), b.get('high'), b.get('low'), b.get('close'),
                       b.get('volume')]
                for key in cols:
                    val = by_key.get(key, {}).get(t)
                    row.append('' if val is None else val)
                w.writerow(row)
                n_rows += 1
    # every skipped symbol is named IN the file — a short export must never
    # look complete when a ticker silently failed to load.
    for e in errors:
        w.writerow(['# skipped', e])
    return buf.getvalue(), n_rows


@app.post('/api/pairs/parse')
def pairs_parse(payload: dict = Body(...)):
    """What the pasted text WILL be read as — shown in the UI before anything
    is fetched, so a mis-read line is visible instead of quietly producing the
    wrong chart."""
    pairs = parse_pairs(str(payload.get('pairs') or ''))
    return {'ok': True, 'count': len(pairs),
            'pairs': [{'ticker': t, 'date': d} for t, d in pairs]}


@app.get('/api/pairs/print', response_class=HTMLResponse)
def pairs_print(pairs: str = '', tf: str = '5m', feed: str = 'polygon',
                overlays: str = '[]', register: str = 'R1',
                days_before: int = 1, days_after: int = 1,
                cols: int = 1, height: int = 420, trades: str = '[]'):
    """PRINT SHEET for an explicit LIST of (ticker, date) pairs — a trade
    journal or review list rather than a whole register day.

    `pairs` is free text: "WLDS,2026-07-24" per line, a tab-separated table
    with extra columns, or that table pasted vertically — see parse_pairs.

    `trades` is optional JSON: [{symbol, date, entry_ts, exit_ts, entry, exit,
    side}, ...]. Where one matches a chart, the entry and exit are drawn on it
    — arrows on the bars, price lines at the two fills, and the held bars
    shaded. That turns a chart OF a day into a chart of a TRADE, which is what
    a journal review is actually looking at.

    Identical window, indicators, session shading and register-card block as
    /api/r1/print; the only difference is how the tickers were chosen. GET
    (not POST) so the sheet is a real navigable URL — bookmarkable, and its
    /static assets resolve normally. A few hundred pairs fit in a query
    string; beyond that, split the list.
    """
    # Same lock as the register sheet: this is the SAME work, chosen a
    # different way. Two print endpoints with one guard between them would
    # simply move the crash to whichever one was left unguarded.
    if not _PRINT_LOCK.acquire(blocking=False):
        # RECORDED, because a refusal is the interesting event: it means two
        # sheets were started together, which is the shape of the crash this
        # lock exists to prevent.
        from chart import oplog
        oplog.record('print_refused', ok=False, reason='another sheet is building')
        return _print_busy()
    try:
        sheets, errors, ovs, rng, bad = _build_pair_sheets(
            pairs, tf, feed, overlays, days_before, days_after, register, trades)
    finally:
        _PRINT_LOCK.release()
    if bad:
        return HTMLResponse(f'<h3>{bad}</h3>')
    from urllib.parse import urlencode as _ue
    csv_qs = _ue({'pairs': pairs, 'tf': tf, 'feed': feed, 'overlays': overlays,
                  'register': register, 'days_before': days_before,
                  'days_after': days_after})
    n = sum(len(s['charts']) for s in sheets)
    return _sheet_page(sheets, errors, ovs, f'my list ({n} charts)', rng,
                       tf, feed, days_before, days_after, cols, height,
                       csv_url=f'/api/pairs/csv?{csv_qs}', day_prefix='')


@app.get('/api/pairs/csv')
def pairs_csv(pairs: str = '', tf: str = '5m', feed: str = 'polygon',
              overlays: str = '[]', register: str = 'R1',
              days_before: int = 1, days_after: int = 1):
    """The ticker-list sheet as a spreadsheet — same columns as /api/r1/csv
    (register_day here is the date you named), one row per bar."""
    from fastapi.responses import PlainTextResponse
    sheets, errors, _ovs, _rng, bad = _build_pair_sheets(
        pairs, tf, feed, overlays, days_before, days_after, register)
    if bad:
        return PlainTextResponse('# ' + bad)
    body, n = _bars_csv(sheets, errors)
    return PlainTextResponse(
        body, media_type='text/csv; charset=utf-8',
        headers={'Content-Disposition': 'attachment; filename="my_list_bars.csv"',
                 'X-Rows': str(n)})


@app.get('/api/r1/cards.csv')
def r1_cards_csv(start: str = '', end: str = '', day: str = '', register: str = 'R1'):
    """THE REGISTER CARDS as a spreadsheet — one row per (register day,
    ticker), carrying EVERY column the screener froze that morning: score,
    rvol, gap %, ATR, price, regime, sector bias, catalyst, and whatever else
    the register row held.

    This is the "why was it on the list" half of the print sheet, and it needs
    no bar data at all, so it returns in a second even over a month-long
    range. Columns are the well-known card fields first, in a fixed order, so
    the same fact is always in the same column, then any extra fields the
    register carried, alphabetically.
    """
    import csv
    import io
    from fastapi.responses import PlainTextResponse
    if day and not start and not end:
        start = end = day
    start = start or end
    end = end or start
    if not start:
        return PlainTextResponse('# need a date (start/end, or day)')
    have = sc.available_dates(register) or []
    days = sorted(d for d in have if str(start) <= d <= str(end))
    if not days:
        return PlainTextResponse(
            f'# no frozen {register} days between {start} and {end}')

    rows, errors = [], []
    for d in days:
        reg = sc.register_rows(register, d, full=True)
        if not reg.get('ok'):
            errors.append(f'{d}: register fetch failed ({reg.get("error")})')
            continue
        for r in (reg.get('rows') or []):
            t = str(r.get('ticker') or '').strip().upper()
            if t:
                rows.append({'register_day': d, **r, 'ticker': t})

    FIRST = ['register_day', 'ticker', 'score', 'price', 'change', 'gapPct',
             'rvol', 'atr', 'regime', 'secBias', 'sector', 'bias', 'catalyst',
             'method', 'inShortlist', 'date']
    extra = sorted({k for r in rows for k in r} - set(FIRST))
    cols = [c for c in FIRST if any(c in r for r in rows)] + extra
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(cols)
    for r in rows:
        w.writerow([('' if r.get(c) is None else r.get(c)) for c in cols])
    for e in errors:
        w.writerow(['# skipped', e])
    fname = (f'{register}_cards_{start}_{end}'.replace('-', '') + '.csv')
    return PlainTextResponse(
        buf.getvalue(), media_type='text/csv; charset=utf-8',
        headers={'Content-Disposition': f'attachment; filename="{fname}"',
                 'X-Rows': str(len(rows))})


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
