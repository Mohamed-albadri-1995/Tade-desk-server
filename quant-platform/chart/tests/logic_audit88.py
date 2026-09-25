"""min_stop_pct: an entry whose stop is too close to pay for its costs is refused.

Asked 2026-09-24 after backtest #369: at 33 bps a side, a stop 0.4% from the
entry (MAIR) risks less than the round trip costs, so the trade loses ~1.6R on
a plain stop-out and hands most of a winner back (+1.27R before costs, -0.31R
after). The rule sits beside max_stop_pct in `_pair_trades`, measured from the
decision price, and `evaluate` reads it from the strategy's risk block — the
function chart/decide.py runs for every live decision — so a backtest and the
live desk refuse the same trades.

Checks, by running the engine:
  1. long and short: a stop closer than the minimum is dropped and counted as
     stop_too_close; one at or beyond it trades; no minimum changes nothing;
  2. through `evaluate` with the rule in the strategy's risk block, exactly as
     a backtest and a live decision call it.
Before the change every "dropped" check fails.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.strategy as S                                          # noqa: E402
import tools.compare_server as cs                                   # noqa: E402

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


def bars(n=6, px=100.0):
    idx = pd.date_range('2026-09-24 09:34', periods=n, freq='1min',
                        tz='America/New_York').tz_convert('UTC')
    c = np.full(n, px)
    return pd.DataFrame({'open': c, 'high': c + 0.05, 'low': c - 0.05,
                         'close': c, 'volume': np.full(n, 1000.0)}, index=idx)


def run(side, stop_pct, min_stop, fill='desk'):
    b = bars()
    n = len(b)
    ent = np.zeros(n, bool)
    ent[1] = True
    diag = {}
    tr, _, _, op = S._pair_trades(b, list(range(n)), ent, np.zeros(n, bool), side,
                                  {'sl': {'type': 'pct', 'value': stop_pct}}, None,
                                  fill=fill, diag=diag, min_stop_pct=min_stop)
    # Flat prices never reach the stop, so a taken trade is still OPEN at the
    # end: taken = closed + open.
    return tr + ([op] if op else []), diag


print('== 1. the engine: too close is refused, far enough trades ==')
for side in ('long', 'short'):
    tr, d = run(side, 0.4, 1.0)
    ok(f'{side}: stop 0.4% with a 1% minimum is refused', len(tr) == 0, tr)
    ok(f'{side}: ...and counted as stop_too_close', d.get('stop_too_close') == 1, d)
    tr, d = run(side, 1.5, 1.0)
    ok(f'{side}: stop 1.5% with a 1% minimum trades', len(tr) == 1, (tr, d))
    tr, d = run(side, 0.4, None)
    ok(f'{side}: no minimum set, the 0.4% stop trades as before', len(tr) == 1, d)
for fill in ('close', 'next_open'):
    tr, d = run('long', 0.4, 1.0, fill=fill)
    ok(f'{fill} fill: refused the same way', len(tr) == 0 and d.get('stop_too_close') == 1, d)

print('== 2. through evaluate(): the strategy\'s own risk block ==')
df = bars(8)
ts = [int(x.value // 10**9) for x in df.index]
cs.prepare_bars = lambda *a, **k: (df, ts, {'end': df.index[-1]})
STRAT = {
    'name': 'min-stop probe', 'side': 'long',
    'entry': {'logic': 'AND', 'rules': [
        {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
         'right': {'kind': 'const', 'value': 0}}]},
    'exit': {'logic': 'AND', 'rules': []},
    'risk': {'sl': {'type': 'pct', 'value': 0.4}, 'max_entries_per_day': 1},
}
def taken(r):
    return len(r.get('trades') or []) + (1 if r.get('open_trade') else 0)


base = S.evaluate(STRAT, 'X', '1m', 1, feed='yahoo', view='all', fill='desk')
ok('without the rule the probe trades', base.get('ok') and taken(base) >= 1,
   (base.get('error'), sorted(base)))
strict = dict(STRAT, risk=dict(STRAT['risk'], min_stop_pct=1.0))
got = S.evaluate(strict, 'X', '1m', 1, feed='yahoo', view='all', fill='desk')
ok('with min_stop_pct 1.0 in the risk block it does not', got.get('ok') and taken(got) == 0,
   taken(got))
loose = dict(STRAT, risk=dict(STRAT['risk'], min_stop_pct=0.3))
got = S.evaluate(loose, 'X', '1m', 1, feed='yahoo', view='all', fill='desk')
ok('a minimum below the stop distance changes nothing', taken(got) == taken(base))

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
