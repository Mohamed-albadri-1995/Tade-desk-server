"""The backtest applies the live desk's own limits: one entry per stock per
day, and the setup's trades per day.

Found 2026-09-24, auditing the live decision against backtests #367/#368:

  src/setups/runner.js latches every name a setup has alerted today, and the
  order guard refuses a second entry — live NEVER enters a stock twice in a
  day. The backtest re-entered it after a stop-out (WDAY, 2026-09-10, 09:48
  and 10:26).

  maxTradesPerDay stops the setup after N trades a day. The backtest had no
  whole-day limit — #367 took seven on 2026-09-11 — because the desk handed
  the number over as `max_entries_per_day`, which the engine applies PER
  STOCK: a different rule under the same number.

These run the REAL backtest (backtest.run) on a sawtooth feed where a simple
rule fires on every other minute in three stocks, and count what survives.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs                                   # noqa: E402
import chart.backtest as bt                                         # noqa: E402

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


class SawLoader:
    """Green on even minutes, red on odd, inside 09:30-13:00 ET: a
    close>open long enters on every green bar and leaves on the next red."""
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:6000]
        n = len(idx)
        et = idx.tz_convert(cs._ET)
        o = np.full(n, 100.0)
        c = np.full(n, 100.0)
        for i in range(n):
            if 570 <= et[i].hour * 60 + et[i].minute <= 780:
                if i % 2 == 0:
                    o[i], c[i] = 99.95, 100.05
                else:
                    o[i], c[i] = 100.05, 99.95
        return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.02,
                             'low': np.minimum(o, c) - 0.02, 'close': c,
                             'volume': 1000.0}, index=idx)


cs._LOADERS['saw89'] = SawLoader()
P = lambda f: {'kind': 'price', 'field': f}                        # noqa: E731
STRAT = {'name': 'saw', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': [{'left': P('close'), 'op': 'gt', 'right': P('open')}]},
         'exit': {'logic': 'AND', 'rules': [{'left': P('close'), 'op': 'lt', 'right': P('open')}]},
         'risk': {}}
SPEC = {'strategy': STRAT, 'tf': '1m', 'days': 1, 'feed': 'saw89', 'view': 'all',
        'fill': 'close', 'start': '2024-01-09', 'end': '2024-01-10',
        'universe': {'kind': 'symbols', 'symbols': ['AAA', 'BBB', 'CCC']}}


def counts(out):
    per_day, per_sym_day = {}, {}
    for t in out['trades']:
        per_day[t['date']] = per_day.get(t['date'], 0) + 1
        k = (t['date'], t['symbol'])
        per_sym_day[k] = per_sym_day.get(k, 0) + 1
    return per_day, per_sym_day


print('== 0. without the desk limits the sawtooth re-enters every stock ==')
base = bt.run(SPEC)
d, sd = counts(base)
ok('several entries per stock per day', max(sd.values()) > 3, sd)

print('== 1. one entry per stock per day — the runner\'s latch ==')
out = bt.run({**SPEC, 'rules': {'one_per_symbol_day': True}})
d, sd = counts(out)
ok('each stock once a day', set(sd.values()) == {1}, sd)
ok('...so three a day for three stocks', set(d.values()) == {3}, d)
ok('the ones kept are each stock\'s FIRST entry of the day',
   all(t['entry_ts'] == min(x['entry_ts'] for x in base['trades']
                            if x['symbol'] == t['symbol'] and x['date'] == t['date'])
       for t in out['trades']))
cov = (out['summary'].get('coverage') or {}).get('desk_caps') or {}
ok('the dropped re-entries are counted', cov.get('dropped_same_stock', 0) > 0, cov)

print('== 2. the setup\'s trades per day ==')
out = bt.run({**SPEC, 'rules': {'one_per_symbol_day': True, 'max_trades_per_day': 2}})
d, sd = counts(out)
ok('two a day, never more', set(d.values()) == {2}, d)
ok('taken in time order — ties by ticker', {t['symbol'] for t in out['trades']} == {'AAA', 'BBB'},
   sorted({t['symbol'] for t in out['trades']}))
cov = (out['summary'].get('coverage') or {}).get('desk_caps') or {}
ok('the capped ones are counted', cov.get('dropped_day_cap', 0) > 0, cov)

print('== 3. the day limit alone, without the latch ==')
out = bt.run({**SPEC, 'rules': {'max_trades_per_day': 4}})
d, sd = counts(out)
ok('four a day', set(d.values()) == {4}, d)

print('== 4. nothing asked, nothing changed ==')
again = bt.run({**SPEC, 'rules': {}})
ok('same trades as the run with no rules', len(again['trades']) == len(base['trades']))

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
