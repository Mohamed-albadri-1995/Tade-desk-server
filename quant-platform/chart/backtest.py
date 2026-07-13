"""
Backtest runner — Phase 4.

Replays a saved strategy day by day over a universe (a fixed symbol list, or
the screener's frozen R1/Shortlist registers with per-day membership) by
calling the SAME `chart.strategy.evaluate()` the chart preview uses — same
JSON, same math, same fill model. There is no separate backtest evaluator, so
preview and backtest can never disagree.

Honesty rules (see chart/PHASE4_PLAN.md — decisions 2-4):
- Each (day D, symbol) pair is evaluated with `asof=D`; only trades whose
  ENTRY bar falls on the ET date D count for day D. Warm-up-day signals are
  context, never trades.
- A position still open at the evaluation window's end is recorded with
  reason 'open' and its unrealized return — reported separately, never mixed
  into the closed-trade win rate.
- Fill model is explicit per run: 'close' (preview assumption) or
  'next_open' (honest live fills).

Sequential by design (t3.micro): one (day, symbol) at a time, progress
reported as the fraction of pairs completed.
"""

from __future__ import annotations

import traceback

import pandas as pd

import tools.compare_server as cs
from chart import store
from chart import strategy as strat


def _et_date(ts_s: int) -> str:
    return pd.Timestamp(int(ts_s), unit='s', tz='UTC').tz_convert(cs._ET).strftime('%Y-%m-%d')


def _dates(spec: dict) -> list[str]:
    """Trading days (Mon-Fri) in [start, end]. Days without bars simply
    produce nothing when evaluated — no special-casing of holidays."""
    start, end = spec.get('start'), spec.get('end')
    if not start or not end:
        raise ValueError('spec needs start and end (YYYY-MM-DD)')
    days = pd.bdate_range(start, end)
    if len(days) == 0:
        raise ValueError(f'no trading days between {start} and {end}')
    return [d.strftime('%Y-%m-%d') for d in days]


def _pairs(spec: dict) -> list[tuple[str, str]]:
    """(day, symbol) evaluation pairs. Symbols universe: same list every day.
    Register universe: the screener's frozen membership FOR that day."""
    uni = spec.get('universe') or {}
    kind = uni.get('kind', 'symbols')
    if kind == 'symbols':
        syms = [s.strip().upper() for s in (uni.get('symbols') or []) if s and s.strip()]
        if not syms:
            raise ValueError('universe.symbols is empty')
        return [(d, s) for d in _dates(spec) for s in syms]
    if kind == 'register':
        from chart import screener as sc
        reg = uni.get('register', 'R1')
        want = set(_dates(spec))
        dates = [d for d in (sc.available_dates(reg) or []) if d in want]
        if not dates:
            raise ValueError(f'no {reg} register dates between '
                             f'{spec.get("start")} and {spec.get("end")} — is the '
                             f'screener reachable and does it have frozen days in range?')
        pairs = []
        for d in sorted(dates):
            rows = sc.register_rows(reg, d)
            if not rows.get('ok'):
                raise ValueError(f'screener register fetch failed for {d}: '
                                 f'{rows.get("error", "unreachable")}')
            for r in rows.get('rows') or []:
                t = (r.get('ticker') or '').strip().upper()
                if t:
                    pairs.append((d, t))
        if not pairs:
            raise ValueError(f'{reg} register has no tickers in range')
        return pairs
    raise ValueError(f'unknown universe kind {kind!r}')


def _resolve_strategy(spec: dict) -> dict:
    s = spec.get('strategy')
    if isinstance(s, dict) and (s.get('entry') or s.get('exit')):
        return s
    sid = spec.get('strategy_id')
    if sid:
        s = store.get_strategy(int(sid))
        if s:
            return s
    raise ValueError('spec needs strategy (inline) or a valid strategy_id')


def _summary(closed: list, opens: list, n_pairs: int, errors: list) -> dict:
    out = {'pairs': n_pairs, 'trades': len(closed), 'open_trades': len(opens),
           'errors': len(errors), 'error_samples': errors[:10]}
    if closed:
        rets = [t['ret'] for t in closed]
        wins = sum(1 for r in rets if r > 0)
        by = {}
        for t in closed:
            by[t['reason']] = by.get(t['reason'], 0) + 1
        # equity curve: cumulative % return in exit order; max drawdown on it
        seq = sorted(closed, key=lambda t: t['exit_ts'])
        curve, cum, peak, maxdd = [], 0.0, 0.0, 0.0
        for t in seq:
            cum += t['ret']
            peak = max(peak, cum)
            maxdd = max(maxdd, peak - cum)
            curve.append({'time': int(t['exit_ts']), 'value': round(100.0 * cum, 3)})
        out.update({
            'wins': wins,
            'win_rate': round(100.0 * wins / len(closed), 1),
            'avg_return_pct': round(100.0 * sum(rets) / len(rets), 3),
            'total_return_pct': round(100.0 * sum(rets), 3),
            'max_drawdown_pct': round(100.0 * maxdd, 3),
            'exits_by': by,
            'equity_curve': curve,
        })
    return out


def run(spec: dict, progress_cb=None) -> dict:
    """Execute the backtest. Returns {'summary', 'trades'} — `trades` rows are
    store-shaped (see store.add_bt_trades). Raises ValueError on a bad spec."""
    strategy = _resolve_strategy(spec)
    side = strategy.get('side', 'long')
    tf = spec.get('tf', '5m')
    feed = spec.get('feed', 'polygon')
    view = spec.get('view', 'all')
    fill = spec.get('fill', 'close')
    base_days = int(spec.get('days', 3))       # evaluate() auto-extends warm-up
    pairs = _pairs(spec)

    closed, opens, errors = [], [], []
    for i, (day, sym) in enumerate(pairs):
        try:
            r = strat.evaluate(strategy, sym, tf, base_days, feed=feed,
                               view=view, asof=day, fill=fill)
            if r.get('ok') and r.get('bars'):
                for t in r.get('trades') or []:
                    if _et_date(t['entry_ts']) == day:      # day-slice honesty
                        closed.append({'date': day, 'symbol': sym, 'side': side,
                                       'entry_ts': t['entry_ts'], 'exit_ts': t['exit_ts'],
                                       'entry': t['entry'], 'exit': t['exit'],
                                       'ret': t['ret'], 'reason': t['reason']})
                ot = r.get('open_trade')
                if ot and _et_date(ot['time']) == day:
                    opens.append({'date': day, 'symbol': sym, 'side': side,
                                  'entry_ts': ot['time'], 'exit_ts': None,
                                  'entry': ot['entry'], 'exit': None,
                                  'ret': ot['ret_pct'] / 100.0, 'reason': 'open'})
        except Exception as e:  # noqa: BLE001 — one bad day/symbol must not kill the run
            errors.append(f'{day} {sym}: {e}')
        if progress_cb:
            progress_cb((i + 1) / len(pairs))

    return {'summary': _summary(closed, opens, len(pairs), errors),
            'trades': closed + opens}


def run_and_store(bt_id: int, spec: dict) -> None:
    """Orchestrator for the API thread: runs, streams progress to the store,
    persists trades + summary, and never lets an exception escape unlogged."""
    last = {'p': 0.0}

    def _cb(p):
        if p - last['p'] >= 0.02 or p >= 1.0:   # throttle DB writes
            last['p'] = p
            store.update_backtest(bt_id, progress=p)

    try:
        out = run(spec, progress_cb=_cb)
        store.add_bt_trades(bt_id, out['trades'])
        store.update_backtest(bt_id, status='done', progress=1.0,
                              summary=out['summary'])
    except Exception as e:  # noqa: BLE001
        store.update_backtest(bt_id, status='error',
                              error=f'{e}\n{traceback.format_exc()[-300:]}')
