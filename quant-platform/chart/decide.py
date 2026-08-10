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
                    feed: str, days: int = 2, fill: str = 'close') -> list:
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
                                 feed=feed, view='regular', asof=date, fill=fill)
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
        # exactly what a fresh signal looks like. It is also the ONLY shape a
        # fresh signal has, so getting it wrong loses every trade.
        #
        # It carries `time`, not `entry_ts` — a closed trade uses entry_ts and
        # an open one does not. Reading the wrong field returned 0, which is
        # 1970, which never matches the date, so the pick was dropped without a
        # word and the run reported "nothing qualified" on a day with two
        # signals. Hence the explicit failure below rather than another default.
        ot = res.get('open_trade')
        if ot:
            when = ot.get('time', ot.get('entry_ts'))
            if when is None:
                out.append({'symbol': symbol, 'strategy': s.get('name'),
                            'error': 'open_trade carried no timestamp — '
                                     f'has {sorted(ot)}'})
            elif _et_date(when) == date:
                out.append({
                    'symbol': symbol,
                    'strategy': s.get('name'),
                    'side': res.get('side') or s.get('side') or 'long',
                    'entry': ot.get('entry'),
                    'stop': ot.get('stop'),
                    'entry_at': _hhmm(when),
                    'entry_ts': int(when),
                    'open': True,
                })
    return out


def exit_plan(strategy: dict, side: str, entry: float, stop: float,
              target_r: float = 2.0) -> dict:
    """How this strategy actually gets out — its legs and its stop behaviour.

    THIS EXISTS BECAUSE THE SCREENER WAS INVENTING ONE. Every pick used to be
    given a single target at `target_r` times the risk, whatever the strategy
    said. For a strategy whose risk block carries scale-out `targets` — take a
    third at 1R, a third at 2R, let the rest run — that is not a smaller
    approximation of the tested trade, it is a different trade, and the live
    order would not have matched the backtest that justified it.

    Returns
        legs        [{fraction, r_multiple, price}] in the order they are hit.
                    A strategy with no targets gets one leg at target_r for the
                    whole position, which is what it always effectively had.
        runner      the fraction left after every leg, riding the stop.
        stop_kind   'fixed'    the stop never moves (risk.sl.freeze)
                    'trailing' the stop follows a line, bar by bar
        trail       how it follows, when that can be said as a distance:
                    {'kind': 'pct'|'points', 'value': x}. None for a stop
                    anchored to an indicator — see the note below.

    A trail anchored to a PRIMITIVE (the 9 EMA, session VWAP) has no fixed
    distance: it is wherever that line is on the bar. No broker-side trailing
    stop can follow it, so this reports None rather than a number that would
    look right and be wrong, and the caller has to say so out loud.
    """
    risk_block = (strategy or {}).get('risk') or {}
    per_share = abs(entry - stop)
    sign = 1.0 if str(side).lower() == 'long' else -1.0

    legs = []
    for t in (risk_block.get('targets') or []):
        if not isinstance(t, dict):
            continue
        try:
            fraction = float(t.get('fraction'))
        except (TypeError, ValueError):
            continue
        if fraction <= 0:
            continue
        rm = t.get('r_multiple')
        tp = t.get('tp') if isinstance(t.get('tp'), dict) else None
        price = None
        r_mult = None
        if rm not in (None, '', 0):
            r_mult = float(rm)
            price = entry + sign * r_mult * per_share
        elif tp and tp.get('type') == 'pct' and tp.get('value') not in (None, ''):
            price = entry * (1.0 + sign * float(tp['value']) / 100.0)
            r_mult = (abs(price - entry) / per_share) if per_share else None
        elif tp and tp.get('type') == 'points' and tp.get('value') not in (None, ''):
            price = entry + sign * float(tp['value'])
            r_mult = (abs(price - entry) / per_share) if per_share else None
        # A prim-anchored leg target trails per bar and has no price at the
        # decision. Reported with price None so the caller can see the leg
        # exists and refuse to place a resting order for it.
        legs.append({'fraction': fraction,
                     'r_multiple': None if r_mult is None else round(r_mult, 4),
                     'price': None if price is None else round(price, 4),
                     'anchored': bool(tp and tp.get('type') == 'prim')})

    booked = sum(l['fraction'] for l in legs)
    if not legs:
        legs = [{'fraction': 1.0, 'r_multiple': target_r,
                 'price': round(entry + sign * target_r * per_share, 4),
                 'anchored': False}]
        booked = 1.0

    sl = risk_block.get('sl') or {}
    frozen = bool(sl.get('freeze'))
    kind = sl.get('type')
    trail = None
    if not frozen and kind == 'pct' and sl.get('value') not in (None, ''):
        trail = {'kind': 'pct', 'value': float(sl['value'])}
    elif not frozen and kind == 'points' and sl.get('value') not in (None, ''):
        trail = {'kind': 'points', 'value': float(sl['value'])}

    return {
        'legs': legs,
        'runner': round(max(0.0, 1.0 - booked), 6),
        'stop_kind': 'fixed' if (frozen or not kind) else 'trailing',
        'trail': trail,
        # True when the stop follows an indicator line. No broker-side trailing
        # stop can reproduce that, and pretending otherwise puts a stop
        # somewhere the backtest never had one.
        'stop_anchored': (not frozen) and kind == 'prim',
        'breakeven_after_leg': bool(risk_block.get('breakeven_after_target')),
    }


def decide(strategies: list, symbols: list, date: str, *, tf: str = '1m',
           feed: str = 'yahoo', top_n: int = 2, target_r: float = 2.0,
           days: int = 2, workers: int = _WORKERS, fill: str = 'close') -> dict:
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
        return evaluate_symbol(strategies, sym, date, tf, feed, days=days, fill=fill)

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
    by_name = {s.get('name'): s for s in strategies}
    for p in picks:
        risk = abs(float(p['entry']) - float(p['stop']))
        p['risk'] = risk
        p['risk_pct'] = (risk / float(p['entry']) * 100.0) if p['entry'] else None
        plan = exit_plan(by_name.get(p.get('strategy')) or {},
                         p['side'], float(p['entry']), float(p['stop']), target_r)
        p['exit_plan'] = plan
        # The FIRST target stays on `target` under its old name, because that is
        # what the alert text and the single-bracket path already read. A
        # strategy with legs has more than one, and they are in exit_plan.
        p['target'] = plan['legs'][0]['price'] if plan['legs'] else None
        p['target_r'] = plan['legs'][0].get('r_multiple') if plan['legs'] else None

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
        # WHICH PRICE THE ENTRY IS. 'close' fills at the signal bar's close;
        # 'next_open' fills at the following bar's open, which is what a market
        # order actually gets. It changes the entry, and through it the risk,
        # the target and the ranking metric — so it is reported rather than
        # assumed. Measured on 2026-08-06: LSCC came out at 128.74 on 'close'
        # against the spec's 129.56, which is the 10:00 bar's own range.
        'fill': fill,
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
