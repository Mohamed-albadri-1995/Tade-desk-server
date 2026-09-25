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
     a missing pick — each is reported, by stock;
  4. after the entry: the legs live would send are the backtest's legs, and
     the live manager replayed every minute banks each target leg and closes
     each trade on the backtest's bar for the backtest's reason;
  5. a close two minutes late, a leg a minute late, a different scale-out —
     each is reported.
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

print('== 4. after the entry: the scale-out plan and the exits ==')
# Asked 2026-09-25: "taking the same trades is important, but scaling out and
# exiting by the same rules is also very important to confirm". The replay's
# picks carry the legs live would send; the manager is replayed every minute
# on the same bars for every trade.
legs_n, exits_n, reasons = 0, 0, set()
for strats, seed, over in ((ORV, 3, {'rank_per_day': {'metric': 'vwap_extension', 'top_n': 3}}),
                           (ORV, 9, {'rank_per_day': {'metric': 'vwap_extension', 'top_n': 3}}),
                           ([TEST], 4, {}), ([TEST], 8, {})):
    out = run(strats, seed, **over)
    r = out.get('replay') or {}
    ex = r.get('exits') or {}
    ok(f'{strats[0]["name"]} seed {seed}: the same scale-out plan on every trade',
       r.get('identical') is True, r.get('mismatches'))
    ok(f'{strats[0]["name"]} seed {seed}: the manager banks the legs and closes on the '
       f'backtest\'s bar, for its reason', ex.get('identical') is True, ex.get('mismatches'))
    legs_n += ex.get('legs_compared') or 0
    exits_n += ex.get('compared') or 0
    reasons |= {t['reason'] for t in out['trades']}
ok('exits were compared', exits_n >= 4, exits_n)
ok('scale-out legs were compared', legs_n >= 1, legs_n)
ok('stops and rule or trailing exits were among them',
   {'SL', 'exit'} <= reasons or {'SL', 'trail'} <= reasons, reasons)

print('== 5. the exit check sees a difference ==')
out = run(ORV, 3, rank_per_day={'metric': 'vwap_extension', 'top_n': 3})
trades = [dict(t) for t in out['trades'] if t['reason'] not in ('open', 'eod')]
ok('there is a closed trade to change', trades, [t['reason'] for t in out['trades']])
late = dict(trades[0], exit_ts=int(trades[0]['exit_ts']) + 120)
ex = rp.replay_exits([late], ORV, DAY, tf='1m', feed='replay97', view='all')
ok('a close two minutes later than the manager\'s is reported', not ex['identical'], ex)
withleg = None
for seed in (3, 5, 9, 11, 13, 17):
    o = run(ORV, seed, rank_per_day={'metric': 'vwap_extension', 'top_n': 3})
    withleg = next((t for t in o['trades'] if t.get('legs') and t['reason'] not in ('open',)), None)
    if withleg:
        break
ok('a trade that banked a target leg was found', withleg is not None)
if withleg:
    ex = rp.replay_exits([withleg], ORV, DAY, tf='1m', feed='replay97', view='all')
    ok('...and its leg is banked on the same bar by the manager', ex['identical'], ex)
    moved = dict(withleg, legs=[dict(withleg['legs'][0], exit_ts=int(withleg['legs'][0]['exit_ts']) + 60)])
    ex = rp.replay_exits([moved], ORV, DAY, tf='1m', feed='replay97', view='all')
    ok('a target leg banked a minute later is reported', not ex['identical']
       and 'target legs banked' in (ex['mismatches'][0]['why'] or ''), ex)
plans = [dict(p) for p in out['replay']['picks']]
plans[0] = dict(plans[0], plan=dict(plans[0]['plan'], runner=0.25))
c = rp.compare(plans, out['trades'])
ok('a different scale-out is reported', not c['identical'] and 'scale-out' in c['mismatches'][0]['why'],
   c['mismatches'])

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
