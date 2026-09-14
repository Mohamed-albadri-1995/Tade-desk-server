"""A scaled-out trade is not one entry and one exit, and the journal said it was.

WHAT WAS ASKED. "Strategy 09:35 also has a problem in backtesting — 1 leg, and
it exits the complete position in 1 leg, and it gives good results, but the live
is different."

WHAT IS TRUE, MEASURED THROUGH evaluate() ON THE REAL STRATEGY RECORD. The
simulator does NOT exit the whole position at the target. It banks the declared
half at 2R and rides the rest to the exit rule, and its `ret` is the blend of
the two. That part is right, and this audit pins it so it stays right.

WHAT WAS WRONG IS THE ROW. A journal row has one `exit $` column, and a
scale-out has no single exit — so the column showed the LAST part's price, the
runner's. On a winner the runner usually leaves at the best price of the trade,
so the row read better than the trade was:

    short 17.66, half banked 17.30 (T1), runner out 17.16
      read as one entry and one exit   +0.50 a share
      what the trade actually made     +0.43 a share      — 16% overstated

and `scale_out_legs: 1` reads as "one leg, one exit" when it means one BANKED
leg plus a runner that left somewhere else. Which is precisely the question of
whether the live trade did the same thing: live sends the leg as a resting limit
the broker holds, and the runner has no target at all — it needs the manager to
notice the exit rule, and on 2026-09-08 the manager stopped after 36 passes.

So the row now carries `avg_exit_price` — the one price that, over the whole
position, reproduces what the trade really made — and `exit_shape`, which says
"50% @ T1 + 50% runner (exit)" instead of "1".
"""
import pathlib
import sys

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs                                    # noqa: E402
import chart.strategy as S                                           # noqa: E402
from chart import store                                              # noqa: E402
from chart.report import JOURNAL_COLUMNS, _avg_exit, _exit_shape     # noqa: E402

PASS = 0
FAIL = 0


def ok(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {label}')
    else:
        FAIL += 1
        print(f'  FAIL {label} {detail}')


ET = 'America/New_York'
PREV, DAY = '2026-09-04', '2026-09-08'


def session(day, closes):
    idx = pd.DatetimeIndex(
        [pd.Timestamp(f'{day} 09:30', tz=ET) + pd.Timedelta(minutes=i)
         for i in range(len(closes))]).tz_convert('UTC')
    return pd.DataFrame({'open': [c + 0.01 for c in closes],
                         'high': [c + 0.06 for c in closes],
                         'low': [c - 0.06 for c in closes],
                         'close': closes,
                         'volume': [1e5] * len(closes)}, index=idx)


# ── the trade, through the real strategy record ───────────────────────────────
#
# TWO SESSIONS, because rule 4 of this strategy is
# (OR_mid - close) >= 0.5 * ATR14. Without a warm-up day ATR14 is NaN at 09:34
# and the strategy cannot fire on its own decision bar at all — a stub of one
# session silently tests nothing.
warm = [18.0 + (0.08 if i % 2 else -0.08) for i in range(390)]
day = [18.10, 18.02, 17.90, 17.80, 17.70]
day += [17.70 - 0.05 * i for i in range(1, 30)]          # down through 2R
day += [day[-1] + 0.09 * i for i in range(1, 60)]        # back over VWAP
day += [day[-1]] * (390 - len(day))
FRAMES = pd.concat([session(PREV, warm), session(DAY, day[:390])])


class Stub:
    def load(self, sym, tf, a, b):
        return FRAMES[(FRAMES.index >= a) & (FRAMES.index < b)]


cs._LOADERS['stub'] = Stub()

strat = next((x for x in store.list_strategies()
              if str(x.get('name') or '').startswith('OR + VWAP 09:35')
              and x.get('side') == 'short'), None)
ok('the 09:35 short strategy is in the platform', strat is not None)

if strat is None:
    print(f'\n{PASS} passed, {FAIL} failed')
    sys.exit(1)

ok('it declares a half at 2R, not a whole position',
   [(t.get('fraction'), t.get('r_multiple')) for t in strat['risk'].get('targets') or []]
   == [(0.5, 2.0)],
   str(strat['risk'].get('targets')))
ok('and its exit rule is scoped to the RUNNER',
   (strat.get('exit') or {}).get('scope') == 'runner',
   str((strat.get('exit') or {}).get('scope')))

res = S.evaluate(strat, 'PL', '1m', 1, feed='stub', view='all', asof=DAY, fill='desk')
trades = res.get('trades') or []
ok('the crafted day produces exactly one trade', len(trades) == 1,
   f"{len(trades)} trades, drops={res.get('entry_drops')}")

if not trades:
    print(f'\n{PASS} passed, {FAIL} failed')
    sys.exit(1)

t = dict(trades[0], side=strat['side'])
legs = t.get('legs') or []

# ── the simulator banks the leg; it does not close the position at the target ──
ok('it banks ONE leg and keeps a runner', len(legs) == 1, str(legs))
ok('the banked leg is the declared half at the 2R target',
   abs(float(legs[0]['fraction']) - 0.5) < 1e-9 and legs[0]['reason'] == 'T1',
   str(legs[0]))
ok('the runner leaves separately, at a different price',
   abs(float(legs[0]['price']) - float(t['exit'])) > 1e-9,
   f"leg {legs[0]['price']} vs exit {t['exit']}")

sgn = -1.0
real = 0.5 * sgn * (float(legs[0]['price']) - t['entry']) \
    + 0.5 * sgn * (float(t['exit']) - t['entry'])
whole = sgn * (float(t['exit']) - t['entry'])

# THE MONEY IS RIGHT. `ret` is the blend, not the whole position at the exit.
ok("the simulator's own return is the BLEND of leg and runner",
   abs(t['ret'] * t['entry'] - real) < 1e-6,
   f"ret={t['ret'] * t['entry']:.4f} blended={real:.4f} whole={whole:.4f}")

# ── and the row no longer reads as one exit ───────────────────────────────────
ok('reading the row as one entry and one exit OVERSTATES the trade',
   whole > real, f'whole {whole:.4f} vs real {real:.4f}')

avg = _avg_exit(t)
ok('avg_exit_price reproduces what the trade really made',
   abs(sgn * (avg - t['entry']) - real) < 1e-4,
   f'avg_exit {avg} implies {sgn * (avg - t["entry"]):.4f}, real {real:.4f}')
ok('...and it is NOT the runner\'s price',
   abs(avg - float(t['exit'])) > 1e-9, f'avg {avg} exit {t["exit"]}')

shape = _exit_shape(t)
ok('exit_shape names both parts', shape is not None
   and '50%' in shape and 'runner' in shape, str(shape))

# ── a trade that left in one piece is unchanged ───────────────────────────────
#
# The new column must not invent a second number for the ordinary case, or every
# row grows a discrepancy that means nothing.
plain = {'side': 'long', 'entry': 10.0, 'exit': 11.0, 'reason': 'TP', 'legs': []}
ok('a single-exit trade averages to its own exit price', _avg_exit(plain) == 11.0)
ok('...and has no shape to report', _exit_shape(plain) is None)
ok('an open trade reports no average rather than a zero',
   _avg_exit({'side': 'long', 'entry': 10.0, 'exit': None, 'legs': []}) is None)

# ── the columns are actually in the journal ───────────────────────────────────
cols = [c for c, _ in JOURNAL_COLUMNS]
ok('avg_exit_price is a journal column', 'avg_exit_price' in cols)
ok('exit_shape is a journal column', 'exit_shape' in cols)
ok('and exit_price is still there, beside it', 'exit_price' in cols)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
