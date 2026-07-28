"""Live signal alerts — watch today's R1 + Shortlist, evaluate EVERY saved
strategy on live 1m bars, and raise an alert when a setup's entry condition
is TRUE on the latest completed bar. The chart UI turns alerts into a sound
plus a browser notification.

Design decisions (read before changing):
- SYMBOLS: union of today's R1 and Shortlist registers, refreshed every
  cycle — the screener accumulates today's rows live, so a stock flagged at
  11:00 is watched from the next cycle.
- STRATEGIES: store.list_strategies() every cycle — a setup saved next week
  is watched automatically ("current or future"), nothing to configure.
- SESSION: cycles run 09:25–16:05 ET Mon–Fri. A strategy outside its own
  window (risk.window_start/end, with a 5-minute pre-window grace so the
  first in-window signal is not missed) is skipped — fewer Polygon calls
  and no out-of-playbook alerts.
- SIGNAL: strategy.evaluate(..., days=1, fill='close')['entry_now'] — the
  entry group is TRUE on the last completed bar. THEN-sequences are spiky
  (true on the attack bar), so this is close to an edge already.
- DEDUP: one alert per (strategy, symbol) per signal bar; while a signal
  stays true on consecutive bars, repeats are suppressed for SUPPRESS_S
  seconds. State is in-memory only — a restart may re-alert once.
- ISOLATION: one bad symbol/strategy never kills a cycle; errors ring in
  state and surface via /api/alerts/status.
- COST: no bar cache exists, so each (strategy, symbol) pair is one feed
  fetch per cycle. Worst case ~6 strategies x ~15 symbols each cycle —
  keep INTERVAL_S at 60+ on a paid Polygon key, higher on a free one.
"""
from __future__ import annotations

import threading
import time

import pandas as pd

import tools.compare_server as cs

SUPPRESS_S = 600          # re-alert the same (strategy, symbol) after 10 min
MAX_ALERTS = 200          # ring buffer served to the UI
MAX_ERRORS = 20

_LOCK = threading.Lock()
_STATE = {
    'on': False, 'interval': 60, 'feed': 'polygon', 'tf': '1m',
    'cycles': 0, 'last_cycle': None, 'symbols': [], 'watched': 0,
    'alerts': [], 'errors': [],
}
_SEEN: dict = {}          # (strategy, symbol) -> {'bar': str, 'at': epoch}
_THREAD = None


def _now_et() -> pd.Timestamp:
    return pd.Timestamp.now(tz=cs._ET)


def _in_session(ts: pd.Timestamp) -> bool:
    hm = ts.hour * 100 + ts.minute
    return ts.weekday() < 5 and 925 <= hm <= 1605


def in_window(strategy: dict, hhmm: int, grace_min: int = 5) -> bool:
    """Is `hhmm` ET inside the strategy's session window (start minus a small
    grace so the first in-window bar's signal is caught)? No window = always.
    hhmm is NOT linear across hours (09:55 → 955, 10:00 → 1000), so compare
    in true minutes-of-day."""
    def _mins(x: int) -> int:
        return (int(x) // 100) * 60 + int(x) % 100
    r = strategy.get('risk') or {}
    ws, we = r.get('window_start'), r.get('window_end')
    m = _mins(hhmm)
    if ws is not None and m < _mins(ws) - grace_min:
        return False
    if we is not None and m > _mins(we):
        return False
    return True


def _symbols_today(reg_fn) -> list[str]:
    """Union of today's R1 + Shortlist tickers (order kept, first-seen)."""
    out: list[str] = []
    for reg in ('R1', 'Shortlist'):
        try:
            rows = reg_fn(reg)
        except Exception:  # noqa: BLE001 — screener down ≠ alerts crash
            continue
        if not rows.get('ok'):
            continue
        for r in rows.get('rows') or []:
            t = (r.get('ticker') or '').strip().upper()
            if t and t not in out:
                out.append(t)
    return out


def scan_once(strategies: list[dict], symbols: list[str], eval_fn,
              now_epoch: float | None = None) -> list[dict]:
    """One pass over (strategy x symbol); returns the NEW alerts. Pure logic —
    eval_fn is injected so tests drive it without a feed or a thread."""
    now = float(now_epoch if now_epoch is not None else time.time())
    fresh: list[dict] = []
    for sym in symbols:
        for s in strategies:
            name = s.get('name') or '?'
            try:
                r = eval_fn(s, sym)
            except Exception as e:  # noqa: BLE001
                with _LOCK:
                    _STATE['errors'] = (_STATE['errors']
                                        + [f'{name}/{sym}: {e}'])[-MAX_ERRORS:]
                continue
            if not (isinstance(r, dict) and r.get('ok') and r.get('entry_now')):
                continue
            bar = str(r.get('last') or '')
            key = (name, sym)
            prev = _SEEN.get(key)
            if prev and (prev['bar'] == bar or now - prev['at'] < SUPPRESS_S):
                continue
            _SEEN[key] = {'bar': bar, 'at': now}
            fresh.append({'ts': int(now), 'bar': bar, 'symbol': sym,
                          'strategy': name, 'side': s.get('side', 'long')})
    if fresh:
        with _LOCK:
            _STATE['alerts'] = (_STATE['alerts'] + fresh)[-MAX_ALERTS:]
    return fresh


def _cycle(list_strats_fn, reg_fn, eval_fn) -> list[dict]:
    now = _now_et()
    if not _in_session(now):
        return []
    hm = now.hour * 100 + now.minute
    syms = _symbols_today(reg_fn)
    strats = [s for s in (list_strats_fn() or []) if in_window(s, hm)]
    with _LOCK:
        _STATE['symbols'] = syms
        _STATE['watched'] = len(strats)
        _STATE['cycles'] += 1
        _STATE['last_cycle'] = now.strftime('%Y-%m-%d %H:%M:%S ET')
    return scan_once(strats, syms, eval_fn)


def _default_eval(s: dict, sym: str) -> dict:
    from chart import strategy as strat
    return strat.evaluate(s, sym, _STATE['tf'], 1, feed=_STATE['feed'],
                          view='all', asof=None, fill='close')


def _default_regs(reg: str) -> dict:
    from chart import screener as sc
    return sc.register_rows(reg, None)     # None = today (live register)


def _default_strats() -> list[dict]:
    from chart import store
    return store.list_strategies()


_WAKE = threading.Event()   # the CURRENT generation's stop signal
_GEN = 0                    # watcher generation; a stale thread sees its gen
                            # change and retires without touching state


def _loop(gen: int, wake: threading.Event):
    """One watcher generation. `gen` is captured at start(): stop()+start()
    bumps the generation, so a thread still inside its sleep from the previous
    generation exits instead of running a SECOND scan loop alongside the new
    one (which doubled every cycle, every Polygon call and every alert).

    `wake` is that generation's OWN event, so the next start() cannot
    accidentally un-signal a retiring thread and leave it sleeping."""
    while _STATE['on'] and gen == _GEN:
        try:
            _cycle(_default_strats, _default_regs, _default_eval)
        except Exception as e:  # noqa: BLE001 — the watcher must survive
            with _LOCK:
                _STATE['errors'] = (_STATE['errors'] + [f'cycle: {e}'])[-MAX_ERRORS:]
        # interruptible sleep: stop() returns immediately instead of leaving a
        # zombie thread alive for up to a whole interval.
        if wake.wait(max(15, int(_STATE['interval']))):
            break


def start(interval: int | None = None) -> dict:
    """Start the watcher (idempotent). NOTHING here may call status(): _LOCK
    is a plain Lock, not an RLock, and status() takes it too — a second
    "start" request used to deadlock inside the lock and hang every later
    /api/alerts/* call for the life of the process."""
    global _THREAD, _GEN, _WAKE
    with _LOCK:
        if interval:
            _STATE['interval'] = max(15, int(interval))
        running = _STATE['on'] and _THREAD is not None and _THREAD.is_alive()
        if not running:
            _GEN += 1
            gen = _GEN
            _WAKE = threading.Event()   # a FRESH event; the old one stays set
            wake = _WAKE
            _STATE['on'] = True
    if not running:
        _THREAD = threading.Thread(target=_loop, args=(gen, wake), daemon=True,
                                   name=f'qp-alerts-{gen}')
        _THREAD.start()
    return status()


def stop() -> dict:
    global _GEN
    with _LOCK:
        _STATE['on'] = False
        _GEN += 1                    # retire the current generation
        wake = _WAKE
    wake.set()                       # and wake it out of its sleep now
    return status()


def status() -> dict:
    with _LOCK:
        out = {k: (list(v) if isinstance(v, list) else v)
               for k, v in _STATE.items() if k != 'alerts'}
        out['alerts_buffered'] = len(_STATE['alerts'])   # 3.9-safe merge
        return out


def recent(since_ts: int = 0) -> list[dict]:
    with _LOCK:
        return [a for a in _STATE['alerts'] if a['ts'] > int(since_ts)]
