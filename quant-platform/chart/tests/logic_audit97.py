"""The daily check's logic proof: the live decision on the final bars IS the backtest.

Asked 2026-09-25: "confirm that everything is identical to the backtest, and
the only reason for a mismatch is data latency."

POST /api/backtest/day with `replay_live` replays chart/decide.decide minute by
minute (fill='live') on the SAME final bars the backtest reads, with the
runner's gates — ranking, one-bar stale tolerance, the once-per-stock latch,
the day's cap — and compares its picks with the backtest's trades at the
decision: stock, decision bar, side, stop. Identical means the logic is the
same on that day's data; everything else the check shows is data or execution.

Checks, through the endpoint, on seeded random days with eight stocks:
  1. OR + VWAP 09:35 with a top-3 ranking and a 3-a-day cap: identical;
  2. Test (a two-hour window, re-entries latched, a 3-a-day cap): identical;
  3. the comparison sees a difference: a pick moved one bar, a stop moved,
     a missing pick — each is reported, by stock.
"""
import json
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.replay as rp                                            # noqa: E402
import chart.server as srv                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402
from chart.tests._replay_days import DAY, ORV, TEST, day_frame       # noqa: E402

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


SYMS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']


class Days:
    """A seeded random day per stock, served like any feed."""
    def __init__(self, seed):
        rng = np.random.default_rng(seed)
        self.frames = {s: day_frame(rng) for s in SYMS}

    def load(self, symbol, tf, start, end):
        df = self.frames[symbol]
        return df[(df.index >= start) & (df.index <= end)]


def run(strategies, seed, **over):
    cs._LOADERS['replay97'] = Days(seed)
    spec = {'strategies': strategies, 'tf': '1m', 'days': 2, 'feed': 'replay97',
            'view': 'all', 'fill': 'desk', 'start': DAY, 'end': DAY,
            'universe': {'kind': 'symbols', 'symbols': SYMS},
            'account_equity': 100000, 'risk_usd': 500, 'replay_live': True,
            'rules': {'rth_entries': True, 'eod_close': True,
                      'one_per_symbol_day': True, 'max_trades_per_day': 3}}
    spec.update(over)
    return json.loads(srv.backtest_day(spec).body)


print('== 1. OR + VWAP 09:35, top 3 by extension, 3 a day ==')
n_cmp = 0
for seed in (3, 5, 9):
    out = run(ORV, seed, rank_per_day={'metric': 'vwap_extension', 'top_n': 3})
    r = out.get('replay') or {}
    ok(f'seed {seed}: answered', out.get('ok') and not r.get('error'), (out.get('error'), r.get('error')))
    ok(f'seed {seed}: the live decision on the final bars takes the backtest\'s trades',
       r.get('identical') is True, r.get('mismatches'))
    n_cmp += r.get('compared') or 0
ok('trades were compared', n_cmp >= 3, n_cmp)

print('== 2. Test, 09:30-11:30, 3 a day ==')
n_cmp = 0
for seed in (4, 8):
    out = run([TEST], seed)
    r = out.get('replay') or {}
    ok(f'seed {seed}: identical', out.get('ok') and r.get('identical') is True,
       (out.get('error'), r.get('error'), r.get('mismatches')))
    n_cmp += r.get('compared') or 0
ok('trades were compared', n_cmp >= 2, n_cmp)

print('== 3. the comparison sees a difference ==')
out = run(ORV, 3, rank_per_day={'metric': 'vwap_extension', 'top_n': 3})
picks = out['replay']['picks']
ok('there are picks to change', len(picks) >= 2, picks)
moved = [dict(p) for p in picks]
h, m = moved[0]['bar'].split(':')
moved[0]['bar'] = f'{h}:{int(m) + 1:02d}'
moved[1]['stop'] = float(moved[1]['stop']) + 0.05
c = rp.compare(moved, out['trades'])
ok('a pick a bar later and a stop 5 cents off are both reported',
   not c['identical'] and len(c['mismatches']) == 2, c['mismatches'])
c = rp.compare(picks[1:], out['trades'])
ok('a pick live would not have made is reported',
   not c['identical'] and 'backtest took it' in c['mismatches'][0]['why'], c['mismatches'])

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
