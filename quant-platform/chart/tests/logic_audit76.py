"""The decision has to fit in the minute it decides for.

2026-09-21. `OR + VWAP 09:35` failed EVERY attempt — 09:25, 09:34, 09:39,
09:43 — each one "timeout of 18000ms exceeded". A clock setup decides on one
bar, so there is no later attempt: the strategy did not trade at all. It had
been called an intermittent fault for weeks.

NOTHING WAS BROKEN. Measured on the box, in this order, each one ruling out a
theory that looked obvious until the number came back:

    qp at rest              0% CPU, /api/health in 3ms    (not overloaded)
    yahoo, one symbol       26ms                          (not the feed)
    alerts -> qp            14ms                          (not the path)
    manage, one symbol      18ms                          (not per-call cost)
    decide, 2 warm symbols  394ms
    decide, 47 real cards   12114ms                       <-- the answer

Every "36 second" reading before that was the CLIENT's own budget — two
attempts of 18s — being measured instead of the work. The work had never been
timed at all.

47 symbols at ~0.26s each is 12.2s, and eight workers makes that six waves.
Mid-session, with the scanner having already fetched every name, it fits inside
18s. At 09:34 the list is cold and it does not.

THE CARD COUNT IS NOT A CONSTANT. It is whatever the screener found that
morning — 30 on 2026-09-17, when this last worked; 47 on the day it failed.
Nothing caps it, so the margin has to survive the list growing.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.decide as D                                            # noqa: E402

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


# The two numbers this is all about, from the desk that calls it.
BUDGET_MS = 18000          # DECIDE_TIMEOUT_MS in src/setups/qpClient.js
MEASURED_CARDS = 47

# WHAT WAS MEASURED, not a model of it.
#
# A waves model was built here first — (cards / workers) x (one symbol) — and
# it predicted that tripling the workers would cut 12.1s to 4s. The box said
# otherwise, three runs each, and the model was discarded:
#
#     8 workers, 47 cards     12114ms
#     24 workers, 47 cards    14422, 15941, 14293ms
#
# MORE THREADS WAS SLOWER. %CPU during a decision is 106.7 — one core, pinned —
# so the cost is the maths and the GIL, not the network the module comment
# claims. Threads cannot beat one core on that, and past a handful they only
# add context switching.
#
# So this file no longer predicts. It holds the numbers that were observed and
# fails if the setting drifts away from the best one measured.
MEASURED = {8: 12114, 24: 14422}
BEST_WORKERS = 8


print('\n── the measured cost, against the budget it has to fit ────────────')

ok('the worker count is the best one measured',
   D._WORKERS == BEST_WORKERS,
   f'{D._WORKERS} — measured: ' + ', '.join(
       f'{w}->{ms}ms' for w, ms in sorted(MEASURED.items())))

ok('and raising it was tried and was WORSE',
   MEASURED[24] > MEASURED[8],
   'threads cannot beat one core on CPU-bound work')

print('\n── the cost is still over budget once the list is cold ────────────')

# THIS IS NOT FIXED, and the test says so rather than pretending. 12.1s of an
# 18s budget is a 1.5x margin, measured warm, mid-session, with nothing else
# deciding. At 09:34 the list is cold, yahoo is at its busiest, and Test is
# deciding in the same minute on the same one core.
ok('47 cards still costs most of the budget',
   MEASURED[8] > BUDGET_MS * 0.6,
   f'{MEASURED[8]}ms of {BUDGET_MS}ms — a 1.5x margin on a deadline that '
   f'costs a whole session when missed')

print('\n── and it is CPU, so threads are not the lever ───────────────────')

# %CPU 106.7 during a decision: one core, pinned. numpy and pandas release the
# GIL for parts of their work, which is why it is a little over 100 rather than
# a lot — but it is nowhere near the 800% that eight genuinely parallel workers
# would show. Anything that spends its time in Python cannot be made faster by
# adding threads to it.
ok('the pool stays small, because the work is not I/O',
   D._WORKERS <= 8,
   f'{D._WORKERS} — raising it was measured at {MEASURED[24]}ms vs '
   f'{MEASURED[8]}ms')


print('\n── the pool never opens more threads than there is work ───────────')

# decide() sizes the pool with min(workers, len(symbols)); a two-symbol
# decision must not open twenty-four threads to do it.
import inspect                                                      # noqa: E402
src = inspect.getsource(D.decide)
ok('the pool is sized by the smaller of the two',
   'min(workers, len(symbols))' in src)
ok('and never zero', 'max(1,' in src)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
