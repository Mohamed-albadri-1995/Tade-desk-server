"""The one-day backtest behind the desk's daily live-vs-backtest check.

Asked 2026-09-25: after the close, backtest today for every enabled setup with
the live settings and the live feed, and compare it with what live did.

The endpoint (POST /api/backtest/day) runs the REAL backtest in the request
and stores nothing. The universe is the setup's tools' R1 register — what a
normal backtest of the setup reads — PLUS the names the live desk evaluated
(`extra_symbols`), so a trade live took on a name the morning register did
not hold can still be compared. Those are marked `_extra` on the trade.

Checks, by calling the endpoint function:
  1. a register name and an extra name both trade; the extra is marked, the
     register one is not; a name on both is evaluated once;
  2. with no register for the day at all, the extras alone are evaluated;
  3. more than one day is refused.

And found writing it: the backtest sized a trade on its FILL (the next open)
while live sizes on the decision price, before any fill exists — 110 shares
against live's 99 on the same trade. Sized at the decision price now.
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.screener as sc                                          # noqa: E402
import chart.server as srv                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402

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


class OneGreen:
    """Flat, with one green bar at 09:40 ET — a close>open long enters once."""
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[-3000:]
        et = idx.tz_convert('America/New_York')
        c = np.where((et.hour == 9) & (et.minute == 40), 100.5, 100.0)
        o = np.full(len(idx), 100.0)
        return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + .01,
                             'low': np.minimum(o, c) - .01, 'close': c,
                             'volume': 1e4}, index=idx)


cs._LOADERS['green95'] = OneGreen()
DAY = '2024-01-09'
REG = {'T9:R1': {DAY: [{'ticker': 'AAA'}, {'ticker': 'CCC'}]}}
sc.available_dates = lambda reg: sorted((REG.get(reg) or {}).keys())
sc.register_rows = lambda reg, d, full=True: {'ok': True, 'rows': (REG.get(reg) or {}).get(d, [])}

P = lambda f: {'kind': 'price', 'field': f}                          # noqa: E731
STRAT = {'name': 'g95', 'side': 'long', 'tools': ['T9'],
         'entry': {'logic': 'AND', 'rules': [{'left': P('close'), 'op': 'gt', 'right': P('open')}]},
         'exit': {'logic': 'AND', 'rules': []},
         'risk': {'sl': {'type': 'pct', 'value': 5}}}
SPEC = {'strategy': STRAT, 'tf': '1m', 'days': 1, 'feed': 'green95', 'view': 'all',
        'fill': 'desk', 'start': DAY, 'end': DAY, 'scan_gate': False,
        'rules': {'rth_entries': True, 'eod_close': True, 'one_per_symbol_day': True},
        'account_equity': 100000, 'risk_usd': 500,
        'universe': {'kind': 'tools', 'register': 'R1', 'tools': ['T9'],
                     'extra_symbols': ['BBB', 'AAA']}}


def call(spec):
    return json.loads(srv.backtest_day(spec).body)


print('== 1. the register and the names live evaluated ==')
out = call(SPEC)
ok('answered', out.get('ok'), out.get('error'))
by = {t['symbol']: t for t in out.get('trades') or []}
ok('the register names trade', {'AAA', 'CCC'} <= set(by), sorted(by))
ok('the extra name trades too', 'BBB' in by, sorted(by))
ok('...marked as not on the register', (by.get('BBB', {}).get('ctx') or {}).get('_extra') is True)
ok('a register name is not marked', not (by.get('AAA', {}).get('ctx') or {}).get('_extra'))
ok('a name on both is evaluated once', sum(1 for t in out['trades'] if t['symbol'] == 'AAA') == 1)
ok('the trade is the 09:40 signal, entered 09:41 (desk fill)',
   pd.Timestamp(by['AAA']['entry_ts'], unit='s', tz='UTC').tz_convert('America/New_York')
   .strftime('%H:%M') == '09:41')
# SIZED AT THE DECISION PRICE, as live: $500 / (100.50 - 95.475) = 99. Sized
# at the fill (100.00, the next open) it was 110 — a count live never sends.
ok('sized at the decision price, as live: 99 shares, not 110',
   (by['AAA'].get('ctx') or {}).get('acct_shares') == 99.0,
   (by['AAA'].get('ctx') or {}).get('acct_shares'))

ok('...and names the bar it was decided on, 09:40',
   pd.Timestamp((by['AAA'].get('ctx') or {}).get('signal_ts') or 0, unit='s', tz='UTC')
   .tz_convert('America/New_York').strftime('%H:%M') == '09:40')
ok('each trade carries the exit plan live would have built',
   ((by['AAA'].get('plan') or {}).get('legs') or [{}])[0].get('price') is not None,
   by['AAA'].get('plan'))

print('== 2. no register that day: the extras alone ==')
REG.clear()
out = call(SPEC)
ok('answered', out.get('ok'), out.get('error'))
ok('only the extras', sorted(t['symbol'] for t in out['trades']) == ['AAA', 'BBB'],
   [t['symbol'] for t in out.get('trades') or []])

print('== 3. one day only ==')
out = call(dict(SPEC, end='2024-01-10'))
ok('two days refused', out.get('ok') is False and 'one day' in out.get('error', ''), out)

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
