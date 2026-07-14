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
        return [(d, s, {}) for d in _dates(spec) for s in syms]
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
            rows = sc.register_rows(reg, d, full=True)
            if not rows.get('ok'):
                raise ValueError(f'screener register fetch failed for {d}: '
                                 f'{rows.get("error", "unreachable")}')
            for r in rows.get('rows') or []:
                t = (r.get('ticker') or '').strip().upper()
                if t:
                    # the FULL frozen R1/Shortlist card rides along with every
                    # trade so results can be filtered by ANY register column
                    pairs.append((d, t, r))
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


def _ttp_block(closed: list, opens: list, spec: dict) -> dict | None:
    """Prop-firm accounting (Trade The Pool defaults, all overridable):
    per-share commission with a per-order minimum, dollar P&L for a fixed
    share size, and the MIN-PROFIT rule — winners under `min_profit_ps`
    $/share do NOT count toward the profit target; losses always count.
    pnl_ps is the raw entry→exit price difference (their rule is on average
    prices, before commissions)."""
    fps = float(spec.get('fee_per_share', 0) or 0)
    fmin = float(spec.get('fee_min', 0) or 0)
    mps = spec.get('min_profit_ps')
    if not (fps or fmin or mps is not None):
        return None
    shares = max(1.0, float(spec.get('shares', 100) or 100))
    mps = float(0.10 if mps is None else mps)
    fee = (lambda: max(fps * shares, fmin)) if (fps or fmin) else (lambda: 0.0)
    fees = net = counted = 0.0
    below = 0
    for t in closed:
        sgn = 1.0 if t['side'] == 'long' else -1.0
        pps = sgn * (t['exit'] - t['entry'])
        f = fee() * 2                      # entry order + exit order
        n_usd = shares * pps - f
        fees += f; net += n_usd
        if 0 < pps < mps:
            below += 1                     # win too small → target credit is 0
        else:
            counted += n_usd
    fees += fee() * len(opens)             # open positions paid the entry side
    return {'shares': shares, 'fee_per_share': fps, 'fee_min_per_order': fmin,
            'min_profit_ps': mps, 'fees_usd': round(fees, 2),
            'net_pnl_usd': round(net, 2),
            'counted_pnl_usd': round(counted, 2),
            'wins_below_min': below}


def _summary(closed: list, opens: list, n_pairs: int, errors: list,
             all_dates: list | None = None, cost_bps: float = 0.0,
             spec: dict | None = None, coverage: dict | None = None) -> dict:
    out = {'pairs': n_pairs, 'trades': len(closed), 'open_trades': len(opens),
           'errors': len(errors), 'error_samples': errors[:10],
           'cost_bps_per_side': cost_bps, 'dates': list(all_dates or [])}
    if coverage is not None:
        out['coverage'] = coverage
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
        # Chan-style DAILY metrics: build the daily return series over ALL
        # evaluated days (flat days = 0 — leaving them out inflates Sharpe),
        # then annualized Sharpe (√252) and max-drawdown DURATION in days.
        if all_dates:
            daily = {d: 0.0 for d in all_dates}
            for t in closed:
                daily[t['date']] = daily.get(t['date'], 0.0) + t['ret']
            vals = [daily[d] for d in sorted(daily)]
            n = len(vals)
            mean = sum(vals) / n
            var = sum((v - mean) ** 2 for v in vals) / (n - 1) if n > 1 else 0.0
            sd = var ** 0.5
            out['sharpe'] = round(mean / sd * (252 ** 0.5), 2) if sd > 1e-12 else None
            cum = peak = 0.0
            run = worst = 0
            for v in vals:
                cum += v
                if cum >= peak - 1e-12:
                    peak = cum; run = 0
                else:
                    run += 1; worst = max(worst, run)
            out['max_dd_days'] = worst
    ttp = _ttp_block(closed, opens, spec or {})
    if ttp:
        out['ttp'] = ttp
    return out


def run(spec: dict, progress_cb=None) -> dict:
    """Execute the backtest. Returns {'summary', 'trades'} — `trades` rows are
    store-shaped (see store.add_bt_trades). Raises ValueError on a bad spec."""
    strategy = _resolve_strategy(spec)
    side = strategy.get('side', 'long')
    # `or` (not dict defaults): the UI can send '' for an untouched select, and
    # an empty feed/tf must NOT reach the loaders as a mystery value.
    tf = spec.get('tf') or '5m'
    feed = spec.get('feed') or 'polygon'
    view = spec.get('view') or 'all'
    fill = spec.get('fill') or 'close'
    base_days = int(spec.get('days', 3) or 3)  # evaluate() auto-extends warm-up
    # transaction costs (Chan ch.3: costs flip marginal strategies negative —
    # a backtest without them lies). Fractional cost per SIDE in basis points
    # (spread + slippage + commission); a round trip pays it twice.
    cost = float(spec.get('cost_bps', 0.0) or 0.0) / 10000.0
    pairs = _pairs(spec)

    closed, opens, errors = [], [], []
    # COVERAGE accounting — "1 trade" is uninterpretable unless the run also
    # says how much of the universe was ACTUALLY evaluated. A pair whose feed
    # returns zero bars is not an error and produces no trade; before this
    # block it vanished silently, which can make a thin feed (alpaca IEX on
    # small caps) look like a strategy that never fires.
    cov = {'pairs': len(pairs), 'evaluated': 0, 'no_data': 0,
           'no_data_samples': [], 'signals_on_day': 0, 'signal_pairs': 0,
           'traded_pairs': 0, 'tf': tf, 'feed': feed, 'fill': fill}
    bar_counts = []
    for i, (day, sym, rctx) in enumerate(pairs):
        try:
            r = strat.evaluate(strategy, sym, tf, base_days, feed=feed,
                               view=view, asof=day, fill=fill,
                               rules=spec.get('rules'))
            if r.get('ok') and r.get('bars'):
                cov['evaluated'] += 1
                bar_counts.append(int(r['bars']))
                sigs = sum(1 for e in (r.get('entries') or [])
                           if _et_date(e['time']) == day)
                if sigs:
                    cov['signal_pairs'] += 1
                    cov['signals_on_day'] += sigs
                took = False
                for t in r.get('trades') or []:
                    if _et_date(t['entry_ts']) == day:      # day-slice honesty
                        took = True
                        closed.append({'date': day, 'symbol': sym, 'side': side,
                                       'entry_ts': t['entry_ts'], 'exit_ts': t['exit_ts'],
                                       'entry': t['entry'], 'exit': t['exit'],
                                       'ret': t['ret'] - 2.0 * cost,   # round trip
                                       'reason': t['reason'], 'ctx': rctx})
                ot = r.get('open_trade')
                if ot and _et_date(ot['time']) == day:
                    took = True
                    opens.append({'date': day, 'symbol': sym, 'side': side,
                                  'entry_ts': ot['time'], 'exit_ts': None,
                                  'entry': ot['entry'], 'exit': None,
                                  'ret': ot['ret_pct'] / 100.0 - cost,  # one side so far
                                  'reason': 'open', 'ctx': rctx})
                if took:
                    cov['traded_pairs'] += 1
            else:
                cov['no_data'] += 1
                if len(cov['no_data_samples']) < 12:
                    cov['no_data_samples'].append(f'{day} {sym}')
        except Exception as e:  # noqa: BLE001 — one bad day/symbol must not kill the run
            errors.append(f'{day} {sym}: {e}')
        if progress_cb:
            progress_cb((i + 1) / len(pairs))

    if bar_counts:
        bar_counts.sort()
        cov['bars_median'] = int(bar_counts[len(bar_counts) // 2])
    per_day: dict = {}
    for d, _, _ in pairs:
        per_day[d] = per_day.get(d, 0) + 1
    cov['pairs_per_day'] = per_day
    all_dates = sorted(per_day)
    return {'summary': _summary(closed, opens, len(pairs), errors,
                                all_dates=all_dates,
                                cost_bps=float(spec.get('cost_bps', 0.0) or 0.0),
                                spec=spec, coverage=cov),
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
