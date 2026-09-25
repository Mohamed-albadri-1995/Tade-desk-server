"""The manager judges the bar that has just closed, on the decision's bars.

Found 2026-09-25, auditing the manager. The desk asks qp to manage a position
every minute WITHOUT a date. prepare_bars read "no date" as "not a live day":

  - the window ended at now floored to FIVE minutes, not to the minute;
  - it came from the disk cache, written by the first call in those five
    minutes, when the last bar in it was still forming.

At 10:44 the manager was judging (half of) the 10:40 bar. A rule exit or a
trailing stop the backtest booked at 10:41 was acted on up to four bars late.

And two smaller differences from the decision it manages: exactly two days of
bars (the decision widens the window for an indicator that needs more warm-up)
and view 'regular' (the decision and the backtest read 'all').

Checks, by running manage() against a loader that behaves like Yahoo — bars up
to and INCLUDING the one still forming at `end`:
  1. with no date, the bar judged is the last CLOSED minute, and it is fetched
     live rather than from the cache;
  2. the window is widened exactly as the decision's is;
  3. view 'all' by default, as the decision.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.manage as M                                             # noqa: E402
import chart.strategy as S                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402
from chart import data_manager as dm                                 # noqa: E402

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


class YahooLike:
    """Every minute from start to end INCLUSIVE — the bar stamped `end` is the
    one still forming, as Yahoo returns it. Records what it was asked."""
    def __init__(self):
        self.asked = []

    def load(self, symbol, tf, start, end, live=False):
        self.asked.append({'start': start, 'end': end, 'live': live})
        idx = pd.date_range(pd.Timestamp(start).ceil('min'), end, freq='1min')
        n = len(idx)
        c = 100.0 + np.sin(np.arange(n) / 7.0)
        return pd.DataFrame({'open': c, 'high': c + .05, 'low': c - .05, 'close': c,
                             'volume': np.full(n, 1e4)}, index=idx)


FEED = YahooLike()
cs._LOADERS['yahoo92'] = FEED
P = lambda f: {'kind': 'price', 'field': f}                          # noqa: E731
STRAT = {'name': 'm92', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': []},
         'exit': {'logic': 'AND', 'rules': [{'left': P('close'), 'op': 'lt',
                                             'right': {'kind': 'const', 'value': 0}}]},
         'risk': {'sl': {'type': 'pct', 'value': 5}}}


def run(**kw):
    before = pd.Timestamp.now(tz='UTC').floor('min')
    entry_iso = str((before - pd.Timedelta(minutes=20)).tz_convert('America/New_York'))
    a = M.manage(STRAT, 'X', 'long', 100.0, entry_iso, feed='yahoo92', **kw)
    after = pd.Timestamp.now(tz='UTC').floor('min')
    return a, before, after


print('== 1. no date: the last CLOSED minute, fetched live ==')
cs._forget_live_memo()
FEED.asked.clear()
a, before, after = run()
ok('answered', a.get('ok'), a.get('error'))
judged = pd.Timestamp(a['bar']['time']).tz_convert('UTC') if a.get('ok') else None
closed = {before - pd.Timedelta(minutes=1), after - pd.Timedelta(minutes=1)}
ok('the bar judged is the minute that has just closed', judged in closed,
   (str(judged), [str(x) for x in closed]))
ok('not the one still forming', judged is not None and judged < before, str(judged))
ok('the window asked for ends at this minute, not a five-minute mark',
   bool(FEED.asked) and FEED.asked[-1]['end'] in {before, after},
   FEED.asked and str(FEED.asked[-1]['end']))
ok('fetched live, not from the cache', bool(FEED.asked) and FEED.asked[-1]['live'] is True,
   FEED.asked and FEED.asked[-1]['live'])

print('== 2. the warm-up the decision would use ==')
heavy = dict(STRAT, exit={'logic': 'AND', 'rules': [
    {'left': P('close'), 'op': 'lt',
     'right': {'kind': 'primitive', 'key': 'ma.sma', 'source': 'close',
               'params': {'length': 3000}}}]})
want_days = dm.required_days(S.referenced_overlays(heavy), '1m', 2)
ok('the probe needs more than two days', want_days > 2, want_days)
cs._forget_live_memo()
FEED.asked.clear()
M.manage(heavy, 'X', 'long', 100.0, None, feed='yahoo92')
span = (FEED.asked[-1]['end'] - FEED.asked[-1]['start']).days if FEED.asked else None
ok('the manager asks for the same window', span == want_days, (span, want_days))

print('== 3. the decision\'s view ==')
import inspect                                                       # noqa: E402
ok('view defaults to all', inspect.signature(M.manage).parameters['view'].default == 'all')

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
