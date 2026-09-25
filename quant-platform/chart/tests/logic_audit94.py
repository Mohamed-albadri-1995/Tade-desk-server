"""A strategy's single target (risk.tp) is the order's target.

Found 2026-09-25, auditing the order legs. The engine takes profit at
risk.tp when a strategy has no targets list — pct, points, ATR or an anchored
line (strategy.py _risk_dist / _anchor_levels). The live exit plan
(chart/exit_protocol.py) read only the targets list, so such a strategy was
sent with the screener's default 2R instead of its own target — or, with an
exit rule too, refused for auto-trading as "exits on a rule".

No live setup has this shape today (OR + VWAP and Test use a targets list);
the check is that the next one cannot.

Checks, by running both sides:
  1. the exit plan's target is the price the ENGINE books its take-profit at,
     for a % target and a points target, with and without an exit rule;
  2. an ATR target is not priced from here: refused for auto-trading, said why;
  3. a strategy with no target at all is unchanged (2R, or a rule).
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402
from chart.decide import exit_plan                                   # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}   {extra}')


P = lambda f: {'kind': 'price', 'field': f}                          # noqa: E731
NEVER = [{'left': P('close'), 'op': 'lt', 'right': {'kind': 'const', 'value': 0}}]


def strategy(tp, rules):
    return {'name': 't94', 'side': 'long',
            'entry': {'logic': 'AND', 'rules': [{'left': P('close'), 'op': 'gt', 'right': P('open')}]},
            'exit': {'logic': 'AND', 'rules': rules},
            'risk': {'sl': {'type': 'pct', 'value': 1}, 'tp': tp, 'max_entries_per_day': 1}}


def engine_tp(st):
    """Flat 100, one green bar that closes at 100.00, then a bar reaching 110.
    The engine's take-profit price, under the desk's live fill."""
    idx = pd.date_range('2026-09-24 09:40', periods=6, freq='1min',
                        tz='America/New_York').tz_convert('UTC')
    o = np.array([100, 99.9, 100, 100, 100, 100.0])
    c = np.array([100, 100.0, 100, 100, 100, 100.0])
    h = np.array([100.01, 100.01, 110, 100.01, 100.01, 100.01])
    df = pd.DataFrame({'open': o, 'high': h, 'low': np.minimum(o, c) - .01, 'close': c,
                       'volume': 1e4}, index=idx)
    ts = [int(x.value // 10**9) for x in df.index]
    real = cs.prepare_bars
    cs.prepare_bars = lambda *a, **k: (df, ts, {'end': df.index[-1]})
    try:
        r = S.evaluate(st, 'X', '1m', 1, feed='yahoo', view='all', fill='live')
    finally:
        cs.prepare_bars = real
    tr = [t for t in r.get('trades') or [] if t.get('reason') == 'TP']
    return (tr[0]['entry'], tr[0]['exit']) if tr else (None, None)


print('== 1. the order\'s target is the engine\'s take-profit ==')
for tp in ({'type': 'pct', 'value': 3}, {'type': 'points', 'value': 2.5}):
    for rules, label in (([], 'no exit rule'), (NEVER, 'with an exit rule')):
        st = strategy(tp, rules)
        entry, took = engine_tp(st)
        plan = exit_plan(st, 'long', entry or 100.0, (entry or 100.0) * 0.99, 2.0)
        legs = plan['legs']
        ok(f'{tp["type"]} target, {label}: the engine took profit', took is not None, took)
        ok(f'{tp["type"]} target, {label}: one leg at the engine\'s price {took}',
           len(legs) == 1 and legs[0]['price'] is not None and took is not None
           and abs(legs[0]['price'] - took) < 1e-6, legs)
        ok(f'{tp["type"]} target, {label}: it may be auto-traded', plan['order_ok'],
           plan['order_errors'])

print('== 2. an ATR target is not priced here, and says so ==')
plan = exit_plan(strategy({'type': 'atr', 'value': 2}, []), 'long', 100.0, 99.0, 2.0)
ok('not auto-traded', plan['order_ok'] is False, plan['order_errors'])
ok('...because of the ATR target', any('ATR' in e for e in plan['order_errors']),
   plan['order_errors'])

print('== 3. no target at all: as before ==')
plan = exit_plan(strategy({'type': '', 'value': None}, []), 'long', 100.0, 99.0, 2.0)
ok('no rule: the 2R convention', plan['legs'][0]['price'] == 102.0, plan['legs'])
plan = exit_plan(strategy({'type': '', 'value': None}, NEVER), 'long', 100.0, 99.0, 2.0)
ok('a rule: exits on it, not auto-traded', plan['order_ok'] is False
   and plan['legs'][0]['price'] is None, plan['legs'])

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
