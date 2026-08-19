"""Managing a position that is already open — chart/manage.py.

A broker holds a resting stop and a resting limit. Everything else a strategy
does after the position opens, somebody has to watch for, and two of the three
live strategies need it:

  OR + VWAP 09:35   exits on a RULE (close crossing back through VWAP), and in
                    the backtest that rule closes the ENTIRE remaining position
                    — the 50% runner included. Nothing was evaluating it live,
                    so the runner rode its stop to the bell and the tested exit
                    was never used.

  Test              has a stop that MOVES and RATCHETS: up with the lower VWAP
                    band, never down.

manage() answers the two questions those need — "close it now?" and "where is
the stop now?" — from the SAME functions the simulation uses. This audit is
about the answers being the ones the backtest would give.

PART A — the exit rule: seen only from the entry bar, deferred by min_hold.
PART B — the ratchet: a stop tightens and never loosens, either side.
PART C — a frozen stop is left alone: the broker already holds it.
PART D — the entry bar is found by TIME, because the frame moves every minute.
PART E — breach is judged on the last CLOSED bar, and reported honestly.
"""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.manage as M
import tools.compare_server as cs

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")


def frame(cl, hi=None, lo=None, vol=None, start='2024-01-09 10:00'):
    cl = np.array(cl, float); n = len(cl)
    hi = np.array(hi, float) if hi is not None else cl + 0.05
    lo = np.array(lo, float) if lo is not None else cl - 0.05
    vol = np.array(vol, float) if vol is not None else np.full(n, 1e5)
    idx = pd.DatetimeIndex(
        [pd.Timestamp(start, tz='America/New_York') + pd.Timedelta(minutes=i)
         for i in range(n)]).tz_convert('UTC')
    return pd.DataFrame({'open': np.r_[cl[0], cl[:-1]], 'high': hi,
                         'low': lo, 'close': cl, 'volume': vol}, index=idx)


def use(df):
    """Serve this frame to manage() instead of a feed."""
    end = df.index[-1] if len(df.index) else pd.Timestamp('2024-01-09', tz='UTC')
    cs.prepare_bars = lambda *a, **k: (df, list(df.index), {'end': end})


# The stop anchor used throughout: a plain SMA line, so the level is arithmetic
# anyone can check by hand rather than a VWAP band nobody can.
SMA = {'type': 'prim', 'anchor': {'kind': 'primitive', 'key': 'ma.sma',
                                  'params': {'length': 3}, 'source': 'close'},
       'value': 0.0}

# "close below the 3-bar SMA" — a stand-in for the VWAP cross, same shape.
RULE = {'logic': 'AND', 'rules': [
    {'left': {'kind': 'price', 'field': 'close'}, 'op': 'cross_below',
     'right': {'kind': 'primitive', 'key': 'ma.sma', 'params': {'length': 3},
               'source': 'close'}}]}


print("=" * 64)
print("PART A — the exit rule")
print("=" * 64)

# Up for five bars, then one bar that closes back under the 3-SMA at b6.
cl = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 10.2, 10.1]
use(frame(cl))
st = {'name': 'ruler', 'side': 'long', 'exit': RULE,
      'risk': {'sl': dict(SMA, freeze=True)}}

r = M.manage(st, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
             stop_at_entry=10.0)
ok("the rule is reported as present", r['ok'] and r['has_exit_rule'] is True, r)

# THE CROSS IS AN EDGE, and this is the case that nearly got missed.
#
# `cross_below` is true on the ONE bar it crosses and false on every bar after,
# while price stays below. b6 crosses; b7 is still below and is NOT a cross. A
# manager reading only the newest bar sees nothing at b7 — so a slow fetch, a
# restart or a skipped minute would lose the exit permanently, and the exit is
# what the tested win rate was measured with.
use(frame(cl[:7]))                      # judged ON the cross bar
onbar = M.manage(st, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                 stop_at_entry=10.0)
ok("it fires on the bar that crosses back under", onbar['exit_now'] is True, onbar)
ok("...reported as this bar", onbar['exit_bars_ago'] == 0, onbar)

use(frame(cl))                          # judged a bar LATE
late = M.manage(st, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                stop_at_entry=10.0)
ok("A LATE MANAGER STILL SEES IT", late['exit_now'] is True, late)
ok("...and says how late it was", late['exit_bars_ago'] == 1, late)
ok("...pointing at the bar that actually crossed",
   late['exit_bar'] == onbar['exit_bar'] == 6, (late['exit_bar'], onbar['exit_bar']))

# The SAME frame, judged one bar earlier: not yet.
use(frame(cl[:6]))
r2 = M.manage(st, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
              stop_at_entry=10.0)
ok("and not before it", r2['exit_now'] is False, r2)

# A rule true BEFORE the position opened is history, not an exit.
use(frame(cl))
r3 = M.manage(st, 'X', 'long', entry=10.2, entry_iso='2024-01-09 10:07',
              stop_at_entry=10.0)
ok("a cross before the entry bar is not an exit",
   r3['exit_now'] is False and r3['entry_bar'] == 7, r3)

# min_hold defers the RULE — the same deferral the simulation applies.
use(frame(cl))
held = {'name': 'ruler', 'side': 'long', 'exit': RULE,
        'risk': {'sl': dict(SMA, freeze=True), 'min_hold_bars': 10}}
r4 = M.manage(held, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
              stop_at_entry=10.0)
ok("min_hold defers it", r4['exit_now'] is False, r4)

# A strategy with no rules says so and never claims an exit.
use(frame(cl))
norule = {'name': 'plain', 'side': 'long', 'risk': {'sl': dict(SMA, freeze=True)}}
r5 = M.manage(norule, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
              stop_at_entry=10.0)
ok("no rules → has_exit_rule false, exit_now false",
   r5['has_exit_rule'] is False and r5['exit_now'] is False, r5)


print("=" * 64)
print("PART B — the ratchet")
print("=" * 64)

# A long that grinds up then pulls back. The 3-SMA rises to ~10.6 and then
# FALLS; the stop must keep the high-water mark.
cl = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 10.4, 10.0]
use(frame(cl))
trail = {'name': 'trailer', 'side': 'long', 'risk': {'sl': SMA}}

# Judged at the top: SMA(3) over 10.6/10.8/11.0 = 10.8.
use(frame(cl[:6]))
top = M.manage(trail, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
               stop_at_entry=10.0)
ok("the stop trails UP with the line", abs(top['stop_now'] - 10.8) < 1e-6, top)
ok("...and says it moved", top['stop_moved'] is True, top)
ok("...and is reported as anchored", top['stop_kind'] == 'anchored', top)

# Judged after the pullback: the raw SMA has fallen, the stop has NOT.
use(frame(cl))
after = M.manage(trail, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                 stop_at_entry=10.0)
ok("IT NEVER LOOSENS — the pullback does not lower it",
   abs(after['stop_now'] - 10.8) < 1e-6, after)
ok("and a close under it is a breach", after['breached'] is True, after)

# The mirror, for a short: the stop tightens DOWN and never rises.
cls = [11.0, 10.8, 10.6, 10.4, 10.2, 10.0, 10.6, 11.0]
use(frame(cls[:6]))
sh = {'name': 'trailer', 'side': 'short', 'risk': {'sl': SMA}}
low = M.manage(sh, 'X', 'short', entry=10.4, entry_iso='2024-01-09 10:03',
               stop_at_entry=11.5)
ok("a short's stop trails DOWN", abs(low['stop_now'] - 10.2) < 1e-6, low)
use(frame(cls))
back = M.manage(sh, 'X', 'short', entry=10.4, entry_iso='2024-01-09 10:03',
                stop_at_entry=11.5)
ok("...and never rises again", abs(back['stop_now'] - 10.2) < 1e-6, back)

# THE RATCHET STARTS AT ENTRY, and is SEEDED FROM THE ANCHOR THERE — not from
# whatever number the broker was told. _pair_trades does exactly that
# (`sl_eff = e_sl; sl_at_entry = sl_eff`), and seeding from the caller instead
# would let the manager and the simulation drift apart, which is the entire
# class of bug this module exists to avoid.
#
# Written the other way round first, and it looked right: pass the broker's
# 8.50, ratchet up from there. It is wrong, and this frame shows why — after a
# crash the 3-SMA at the entry bar is still 11.00, well ABOVE the 9.00 fill, so
# the two readings differ by two dollars on bar one.
cl2 = [12.0, 12.0, 12.0, 9.0, 9.2, 9.4]
use(frame(cl2))
early = M.manage(trail, 'X', 'long', entry=9.0, entry_iso='2024-01-09 10:03',
                 stop_at_entry=8.5)
ok("the ratchet is seeded from the anchor at entry, not from the caller",
   abs(early['stop_now'] - 11.0) < 1e-6, early)

# ...and a stop that lands on the WRONG SIDE of the fill is REPORTED, never
# silently acted on. Closing a position opened one bar ago, on a level that is
# obviously stale, is exactly the automatic action that should not happen
# without somebody having seen it.
ok("a stop above a long's entry is flagged rather than resolved",
   early['stop_wrong_side'] is True, early)
use(frame([10.0, 10.2, 10.4, 10.6, 10.8, 11.0]))
sane = M.manage(trail, 'X', 'long', entry=11.5, entry_iso='2024-01-09 10:03',
                stop_at_entry=10.0)
ok("a normal stop is not flagged", sane['stop_wrong_side'] is False, sane)


print("=" * 64)
print("PART C — a frozen stop is left alone")
print("=" * 64)

use(frame([10.0, 10.2, 10.4, 10.6, 10.8, 11.0]))
frozen = {'name': 'fixed', 'side': 'long', 'risk': {'sl': dict(SMA, freeze=True)}}
f = M.manage(frozen, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
             stop_at_entry=10.0)
ok("a frozen stop reports the level the broker already holds",
   abs(f['stop_now'] - 10.0) < 1e-9, f)
ok("...and does not claim to have moved", f['stop_moved'] is False, f)
ok("...and is reported as fixed", f['stop_kind'] == 'fixed', f)
# The whole point: nothing to manage, so nothing should be sent.
ok("...and is NOT flagged as needing management", f['managed'] is False, f)

# The one that IS: an anchored stop, or any exit rule.
use(frame([10.0, 10.2, 10.4, 10.6, 10.8, 11.0]))
m1 = M.manage(trail, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
              stop_at_entry=10.0)
ok("an anchored stop IS flagged", m1['managed'] is True, m1)
ok("...with the honest note about the fill", bool(m1['note']), m1)


print("=" * 64)
print("PART D — the entry bar is found by TIME")
print("=" * 64)

# The frame the manager fetches at 10:41 is not the frame the decision was made
# from. An INDEX would point at a different bar every minute; a timestamp points
# at the same one.
cl = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4]
use(frame(cl))
a = M.manage(trail, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
             stop_at_entry=10.0)
# Same entry time, a frame that starts EARLIER — the same wall-clock bar.
use(frame([9.5, 9.7] + cl, start='2024-01-09 09:58'))
b = M.manage(trail, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
             stop_at_entry=10.0)
ok("a longer frame still finds 10:03",
   a['entry_bar'] == 3 and b['entry_bar'] == 5, (a['entry_bar'], b['entry_bar']))
ok("...and bars_held is measured from it, not from the frame",
   a['bars_held'] == b['bars_held'], (a['bars_held'], b['bars_held']))

# A naive timestamp is read as New York, not as UTC — an hours-off entry bar
# would silently disarm min_hold and mis-start the ratchet.
use(frame(cl))
naive = M.manage(trail, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                 stop_at_entry=10.0)
aware = M.manage(trail, 'X', 'long', entry=10.6,
                 entry_iso='2024-01-09 10:03:00-05:00', stop_at_entry=10.0)
ok("naive times are New York times", naive['entry_bar'] == aware['entry_bar'],
   (naive['entry_bar'], aware['entry_bar']))


print("=" * 64)
print("PART E — what it refuses to do")
print("=" * 64)

use(pd.DataFrame({'open': [], 'high': [], 'low': [], 'close': [], 'volume': []},
                 index=pd.DatetimeIndex([], tz='UTC')))
empty = M.manage(trail, 'X', 'long', entry=10.0, stop_at_entry=9.0)
ok("no bars is an error, not a guess", empty['ok'] is False, empty)

# `drop_last` ignores a possibly-forming bar. Judged without it the cross has
# happened; judged with it, it has not yet.
cl = [10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 10.2]
use(frame(cl))
withlast = M.manage(st, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                    stop_at_entry=10.0)
nolast = M.manage(st, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
                  stop_at_entry=10.0, drop_last=True)
ok("drop_last steps back one bar",
   withlast['exit_now'] is True and nolast['exit_now'] is False,
   (withlast['exit_now'], nolast['exit_now']))

# A broken rule is reported, never swallowed into "no exit" — which would read
# as "hold" and leave a position running on a lie.
use(frame(cl))
bad = {'name': 'bad', 'side': 'long', 'risk': {'sl': dict(SMA, freeze=True)},
       'exit': {'logic': 'AND', 'rules': [{'left': {'kind': 'price', 'field': 'close'},
                                           'op': 'no_such_operator',
                                           'right': {'kind': 'const', 'value': 1}}]}}
br = M.manage(bad, 'X', 'long', entry=10.6, entry_iso='2024-01-09 10:03',
              stop_at_entry=10.0)
ok("an unevaluable rule is an ERROR, not a quiet 'hold'",
   br['ok'] is False and 'exit rule' in br['error'], br)


print()
print(f"        {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
