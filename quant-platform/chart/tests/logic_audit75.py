"""A trailing stop that reached profit was reported as a broken one.

2026-09-17. P, long from 102.20, stop at entry 101.45, managed by a VWAP-band
trail. From 11:50 the manager said, once a minute, for the rest of the session:

    stop 102.57 -> 102.64   stopMoved true   wrongSide TRUE
    breached TRUE           exitNow FALSE

and the desk answered each one with

    "the trailing stop computed to 102.64, which is on the WRONG SIDE of the
     102.2 entry. NOT closing it — look at this one."

Eight alerts, four errors, and a position the backtest would have closed still
open at the bell.

THE GUARD IS RIGHT AND IT WAS ASKING THE WRONG BAR. Its own note says what it
is for:

    "It can only happen when the anchor at the entry bar was already past the
     fill — a stale line, a gap, a strategy whose stop is not really below its
     entries."

That is a fact about the ENTRY BAR. The test read `stop_now` — the RATCHETED
level, which by construction moves toward price for the whole life of the
trade. A long whose trail climbs past its entry has a stop in profit, which is
the entire purpose of a trail; it is the healthiest thing a stop can do, and it
was being reported as obviously wrong.

P's VWAP rose through the entry while price fell below it. The trail did its
job, the stop was breached, and the one mechanism that could act on it refused.

A NUMBER THAT IS ARITHMETICALLY CORRECT ABOUT THE WRONG THING — and the cost is
the divergence this platform exists to prevent: the simulation closes the trade
and the account does not.

The ratchet is seeded from the ANCHOR at the entry bar rather than from what the
broker was told, deliberately, so the two can be seen to disagree. So the anchor
at the entry bar is what the guard now reads, with `stop_at_entry` only as a
fallback for a trade whose anchor had not formed yet.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.manage as M                                            # noqa: E402
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
        print(f'  FAIL {name} {extra}')


def frame(cl, start='2024-01-09 10:00'):
    cl = np.array(cl, float)
    idx = pd.DatetimeIndex(
        [pd.Timestamp(start, tz='America/New_York') + pd.Timedelta(minutes=i)
         for i in range(len(cl))]).tz_convert('UTC')
    return pd.DataFrame({'open': np.r_[cl[0], cl[:-1]], 'high': cl + 0.05,
                         'low': cl - 0.05, 'close': cl,
                         'volume': np.full(len(cl), 1e5)}, index=idx)


def use(df):
    end = df.index[-1]
    cs.prepare_bars = lambda *a, **k: (df, list(df.index), {'end': end})


# A 3-bar SMA as the trailing anchor — arithmetic anyone can check by hand,
# rather than a VWAP band nobody can.
SMA = {'type': 'prim', 'anchor': {'kind': 'primitive', 'key': 'ma.sma',
                                  'params': {'length': 3}, 'source': 'close'},
       'value': 0.0}
TRAIL = {'name': 'trailer', 'side': 'long', 'risk': {'sl': dict(SMA)}}
TRAIL_S = {'name': 'trailer', 'side': 'short', 'risk': {'sl': dict(SMA)}}


print('\n── P, as it actually happened ─────────────────────────────────────')

# Rise, enter near the top, then fall back through the anchor — the shape of
# P's morning: the SMA climbs through the entry while price drops below it.
CL = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4, 10.9, 10.6]
use(frame(CL))
r = M.manage(TRAIL, 'P', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
             stop_at_entry=10.0)

ok('the trail climbed past the entry', r['stop_now'] > 10.6,
   str(r['stop_now']))
ok('it says the stop moved', r['stop_moved'] is True)
ok('and the stop is breached — price is below it',
   r['breached'] is True, f"close vs stop {r['bar']['close']} / {r['stop_now']}")

# THE ONE THAT WAS WRONG. This reported True, and the desk refused to close.
ok('a trail that reached profit is NOT reported as wrong-side',
   r['stop_wrong_side'] is False,
   f"stop_now {r['stop_now']} vs entry 10.6, stop at entry 10.0")

# AND THE CONSEQUENCE, which is the whole point: with wrong_side false the
# desk's manager stops short-circuiting and closes on the breach.
ok('so a breached trail is actionable',
   r['breached'] and not r['stop_wrong_side'])
ok('and the position is reported as managed', r['managed'] is True)


print('\n── the hazard it exists for is still caught ───────────────────────')

# A stop that was ALREADY past the fill when the trade opened: entered at 10.1
# on a bar whose 3-SMA is 10.2. Nothing has trailed anywhere; the level was
# wrong from the first second.
use(frame(CL))
bad = M.manage(TRAIL, 'P', 'long', entry=10.1, entry_iso='2024-01-09 10:05',
               stop_at_entry=10.1)
ok('an anchor already past the fill at entry IS wrong-side',
   bad['stop_wrong_side'] is True,
   f"entry 10.1, stop_now {bad['stop_now']}")

# A SHORT, the mirror. The anchor at entry is BELOW the fill, which for a short
# is the same fault.
DOWN = [12.0, 11.8, 11.6, 11.4, 11.2, 11.0, 10.8, 10.6, 11.1, 11.4]
use(frame(DOWN))
short_bad = M.manage(TRAIL_S, 'P', 'short', entry=11.5,
                     entry_iso='2024-01-09 10:05', stop_at_entry=11.5)
ok('a short whose anchor is below the fill at entry is wrong-side',
   short_bad['stop_wrong_side'] is True,
   f"entry 11.5, stop_now {short_bad['stop_now']}")

use(frame(DOWN))
short_ok = M.manage(TRAIL_S, 'P', 'short', entry=11.4,
                    entry_iso='2024-01-09 10:02', stop_at_entry=12.5)
ok('and a short whose trail has fallen into profit is not',
   short_ok['stop_wrong_side'] is False,
   f"entry 11.4, stop_now {short_ok['stop_now']}")


print('\n── the two runs must not look alike ───────────────────────────────')

# THE PROPERTY IN ONE LINE. Under the old test both of these said True, so the
# desk treated a healthy trail and a broken level identically — and the
# healthy one is the common case, which is how it went unnoticed.
ok('a trail in profit and a level wrong at entry are told apart',
   r['stop_wrong_side'] != bad['stop_wrong_side'])


print('\n── a frozen stop is unchanged by any of this ──────────────────────')

# Nothing trails, so the anchor at the entry bar never forms and the broker's
# own level is the only evidence there is. It must still be judged.
FROZEN = {'name': 'frozen', 'side': 'long', 'risk': {'sl': dict(SMA, freeze=True)}}
use(frame(CL))
fz = M.manage(FROZEN, 'P', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
              stop_at_entry=10.0)
ok('a frozen stop below the entry is fine', fz['stop_wrong_side'] is False,
   str(fz['stop_now']))

use(frame(CL))
fz_bad = M.manage(FROZEN, 'P', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                  stop_at_entry=10.9)
ok('a frozen stop ABOVE the entry is still caught',
   fz_bad['stop_wrong_side'] is True, str(fz_bad['stop_now']))
ok('and a frozen stop is not "managed" — the broker holds it',
   fz['managed'] is False)


print('\n── nothing to judge is not a verdict ──────────────────────────────')

# AN ERROR IS NEVER A ZERO. With no stop anywhere there is no level to be on
# the wrong side OF, and answering True would stop the desk acting on a
# position for a reason that does not exist.
NOSTOP = {'name': 'bare', 'side': 'long', 'risk': {}}
use(frame(CL))
none = M.manage(NOSTOP, 'P', 'long', entry=10.6, entry_iso='2024-01-09 10:03')
ok('no stop at all reports no wrong side', none['stop_wrong_side'] is False)
ok('and no stop level', none['stop_now'] is None)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
