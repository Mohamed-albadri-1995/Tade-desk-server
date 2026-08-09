"""
Deciding a setup live: evaluate a strategy across a universe, then rank.

WHY THIS EXISTS RATHER THAN A SECOND IMPLEMENTATION.

The strategy is already fully expressed as a qp seed — chart/seeds/*.json — in
primitives the platform owns: `vwap.session` for the level and the stop,
`levels.window_low/high` for the morning range, a risk block with the stop
frozen at the anchor and a 2R target, and window_start/window_end pinning entry
to one minute. Everything the spec describes about ONE symbol is in there, and
strategy.evaluate() is the only thing that should ever read it.

What was missing is the last step, and it is genuinely not a strategy's job:
the setup ranks the day's signals against EACH OTHER and trades only the
strongest few. evaluate() sees one symbol and has no idea what the others did.
backtest.py already solved this for a historical run — `rank_per_day` — and
this module is the same decision taken live, over a card list, at the moment it
matters.

So the split is: qp decides whether a symbol qualifies and where its stop is;
this decides which of the qualifying symbols to take. The ranking metric is
imported from backtest rather than rewritten, so a live pick and a backtested
pick can never be ranked by two different definitions of the same number.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from chart import strategy as strat
from chart.backtest import rank_metric

_ET = 'America/New_York'

# How many symbols are evaluated at once.
#
# THIS IS A DEADLINE PROBLEM, not a throughput one. The decision is taken at
# 10:00 and the trade is entered at market on sight, so the whole card list has
# to be evaluated inside the minute it is worth acting in. Sequentially that is
# one network fetch per symbol — forty of them, and the alert arrives after the
# move it was describing.
#
# Threads rather than processes because the time goes on the network, not the
# maths. Both strategies for one symbol run in the same worker so the second
# hits the parquet cache the first just filled instead of fetching twice.
_WORKERS = 8


def _hhmm(ts_seconds: int) -> str:
    return (pd.Timestamp(int(ts_seconds), unit='s', tz='UTC')
            .tz_convert(_ET).strftime('%H:%M'))


def _et_date(ts_seconds: int) -> str:
    return (pd.Timestamp(int(ts_seconds), unit='s', tz='UTC')
            .tz_convert(_ET).strftime('%Y-%m-%d'))


def evaluate_symbol(strategies: list, symbol: str, date: str, tf: str,
                    feed: str, days: int = 2) -> list:
    """Every signal this symbol produced on `date`, across the strategies given.

    A setup is usually two strategies — a long and a short — and a symbol can
    only be one of them on a day, but which one is the strategy's decision and
    not this function's. Both are asked; whatever answers is returned.

    Failures are returned as rows rather than raised. One unreachable symbol
    must not stop a decision that is about to be taken over thirty-nine others.
    """
    out = []
    for s in strategies:
        try:
            res = strat.evaluate(s, symbol=symbol, tf=tf, days=days,
                                 feed=feed, view='rth', asof=date)
        except Exception as e:                       # noqa: BLE001 — reported, not raised
            out.append({'symbol': symbol, 'strategy': s.get('name'),
                        'error': str(e)})
            continue
        if not res.get('ok'):
            out.append({'symbol': symbol, 'strategy': s.get('name'),
                        'error': res.get('error') or 'evaluate failed'})
            continue

        # A trade that OPENED on the date asked for. The strategy's own
        # window_start/window_end already pin the minute; this only rejects
        # signals belonging to another session in the fetched window.
        for t in (res.get('trades') or []):
            if _et_date(t['entry_ts']) != date:
                continue
            out.append({
                'symbol': symbol,
                'strategy': s.get('name'),
                'side': res.get('side') or s.get('side') or 'long',
                'entry': t.get('entry'),
                'stop': t.get('stop'),
                'entry_at': _hhmm(t['entry_ts']),
                'entry_ts': int(t['entry_ts']),
            })
        # A position still open at the end of the window is the live case: the
        # entry has fired and nothing has closed it yet, which at 10:00 is
        # exactly what a fresh signal looks like.
        ot = res.get('open_trade')
        if ot and _et_date(ot.get('entry_ts', 0)) == date:
            out.append({
                'symbol': symbol,
                'strategy': s.get('name'),
                'side': res.get('side') or s.get('side') or 'long',
                'entry': ot.get('entry'),
                'stop': ot.get('stop'),
                'entry_at': _hhmm(ot['entry_ts']),
                'entry_ts': int(ot['entry_ts']),
                'open': True,
            })
    return out


def decide(strategies: list, symbols: list, date: str, *, tf: str = '1m',
           feed: str = 'yahoo', top_n: int = 2, target_r: float = 2.0,
           days: int = 2, workers: int = _WORKERS) -> dict:
    """Run the strategies over the universe and return the ranked picks.

    Returns the picks AND every candidate that was considered, because "why is
    this not on the list" is the question actually asked of a ranking and it
    cannot be answered from the list alone. `took_ms` is reported for the same
    reason the decision has a fixed time: whether it arrived while it was still
    worth acting on is a fact about the run, not a hope about it.
    """
    started = time.time()
    candidates: list = []
    errors: list = []

    # Evaluated in parallel because this runs against a deadline. Order is
    # restored by the ranking below, so concurrency cannot change which two
    # names are taken — only how long it takes to name them.
    def one(sym):
        return evaluate_symbol(strategies, sym, date, tf, feed, days=days)

    if symbols:
        with ThreadPoolExecutor(max_workers=max(1, min(workers, len(symbols)))) as pool:
            for rows in pool.map(one, symbols):
                for row in rows:
                    (errors if row.get('error') else candidates).append(row)

    signalled = []
    for c in candidates:
        m = rank_metric(c.get('side'), c.get('entry'), c.get('stop'))
        c['metric'] = None if m is None else round(m, 6)
        # A signal with no usable stop cannot be sized or ranked. Kept as a
        # candidate so it is visible, never taken.
        if m is not None:
            signalled.append(c)

    # Strongest first; ties broken by symbol so a run is reproducible. The same
    # ordering backtest.py applies, for the same reason.
    signalled.sort(key=lambda c: (-c['metric'], c['symbol']))
    for i, c in enumerate(signalled):
        c['rank'] = i + 1

    picks = signalled[:top_n] if top_n else signalled
    for p in picks:
        risk = abs(float(p['entry']) - float(p['stop']))
        p['risk'] = risk
        p['risk_pct'] = (risk / float(p['entry']) * 100.0) if p['entry'] else None
        p['target'] = (float(p['entry']) + target_r * risk if p['side'] == 'long'
                       else float(p['entry']) - target_r * risk)
        p['target_r'] = target_r

    return {
        'ok': True,
        'date': date,
        'feed': feed,
        'tf': tf,
        # The decision has a deadline, so how long it took is part of the
        # answer. A run that names the right two names at 10:01 is a run that
        # missed.
        'took_ms': int((time.time() - started) * 1000),
        'workers': workers,
        'universe': len(symbols),
        'picks': picks,
        'candidates': candidates,
        'errors': errors,
        'counts': {
            'evaluated': len(symbols),
            'signalled': len(signalled),
            'errored': len(errors),
        },
    }
