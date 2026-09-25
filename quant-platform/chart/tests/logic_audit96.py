"""A strategy that reads a premarket level needs a feed that has premarket.

Asked 2026-09-25, after the desk's Yahoo setups were set to the regular session
(the bars live really has): "what if I add a strategy that uses premarket
levels?" On `yahoo` — fetched without premarket — levels.pm_high is empty
before and after 09:30, so such a strategy never fires: not live, not in a
backtest of the bars live has. Nothing would say why.

`yahoo_ext` is the same source asked for more hours (includePrePost=true). Not
a splice of a second source onto Yahoo — that was tried and gave awful
results. The desk moves a setup onto it by itself when its strategy reads a
premarket level (src/setups/feeds.js).

Checks, by running the real loaders against a stubbed Yahoo:
  1. yahoo_ext asks Yahoo for the extended session, and passes `live` on;
  2. it is a feed qp knows everywhere a feed is looked up;
  3. a "close above the premarket high" strategy trades on yahoo_ext and
     never on yahoo — the difference this feed exists for.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.data_manager as dm                                      # noqa: E402
import chart.strategy as S                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402
from tools.data import yahoo, yahoo_ext                              # noqa: E402

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


ET = 'America/New_York'
DAY = '2024-01-09'
ASKED = []


def fake_yahoo(symbol, timeframe, start, end, feed='yahoo', prepost=False, live=False):
    """Yesterday and today's regular session at 100; with prepost, today's
    premarket too, peaking at 101.00. At 09:40 the close is 101.50."""
    ASKED.append({'prepost': prepost, 'live': live})
    idx, c, h = [], [], []
    for d in ('2024-01-08', DAY):
        first = 4 * 60 if (prepost and d == DAY) else 9 * 60 + 30
        for m in range(first, 16 * 60):
            idx.append(pd.Timestamp(d, tz=ET) + pd.Timedelta(minutes=m))
            px = 101.5 if (d == DAY and m == 9 * 60 + 40) else 100.0
            hi = 101.0 if (d == DAY and m == 8 * 60) else px
            c.append(px)
            h.append(max(px, hi))
    c = np.array(c)
    df = pd.DataFrame({'open': c, 'high': np.array(h) + .01, 'low': c - .01, 'close': c,
                       'volume': 1e4}, index=pd.DatetimeIndex(idx).tz_convert('UTC'))
    return df[(df.index >= start) & (df.index <= end)]


real = yahoo.load
yahoo.load = fake_yahoo
try:
    print('== 1. the same source, more hours ==')
    ASKED.clear()
    yahoo_ext.load('X', '1m', pd.Timestamp('2024-01-08', tz='UTC'), pd.Timestamp('2024-01-10', tz='UTC'))
    ok('asks Yahoo for the extended session', ASKED and ASKED[-1]['prepost'] is True, ASKED)
    yahoo_ext.load('X', '1m', pd.Timestamp('2024-01-08', tz='UTC'),
                   pd.Timestamp('2024-01-10', tz='UTC'), live=True)
    ok('passes a live fetch on as live (no cache)', ASKED[-1]['live'] is True, ASKED)

    print('== 2. a feed qp knows ==')
    ok('prepare_bars', 'yahoo_ext' in cs._LOADERS)
    ok('the chart', 'yahoo_ext' in dm.LOADERS and dm.feed_ok('yahoo_ext'))
    ok('a default that can be chosen', 'yahoo_ext' in cs._VALID_FEEDS)

    print('== 3. close above the premarket high ==')
    PM = {'kind': 'primitive', 'key': 'levels.pm_high', 'source': 'close', 'params': {}}
    STRAT = {'name': 'pm96', 'side': 'long',
             'entry': {'logic': 'AND', 'rules': [{'left': {'kind': 'price', 'field': 'close'},
                                                  'op': 'gt', 'right': PM}]},
             'exit': {'logic': 'AND', 'rules': []},
             'risk': {'sl': {'type': 'pct', 'value': 5}, 'window_start': 930, 'window_end': 1130}}

    def entries(feed):
        r = S.evaluate(STRAT, 'X', '1m', 1, feed=feed, view='all', asof=DAY, fill='desk',
                       rules={'rth_entries': True, 'eod_close': True})
        assert r.get('ok'), r.get('error')
        rows = [t['entry_ts'] for t in r.get('trades') or []]
        if r.get('open_trade'):
            rows.append(r['open_trade']['time'])
        return [pd.Timestamp(x, unit='s', tz='UTC').tz_convert(ET).strftime('%H:%M') for x in rows]

    ok('on yahoo_ext it trades the 09:40 break (entered 09:41)', entries('yahoo_ext') == ['09:41'],
       entries('yahoo_ext'))
    ok('on yahoo — no premarket — it never fires', entries('yahoo') == [], entries('yahoo'))
finally:
    yahoo.load = real

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
