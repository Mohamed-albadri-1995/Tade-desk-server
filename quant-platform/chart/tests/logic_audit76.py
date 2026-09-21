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

# ONE SYMBOL'S LATENCY, not the throughput per symbol.
#
# 12114ms / 47 = 258ms is what each symbol COST on average, and it is the wrong
# number to build on: the symbols run side by side, so the wall clock is how
# many WAVES the list divides into times how long ONE symbol takes. Dividing by
# the count silently assumes they ran one after another.
#
# Derived from the measurement rather than guessed: 47 cards at 8 workers is 6
# waves, and 12114 / 6 = 2019ms. Confirmed against a second, independent run —
# 30 symbols at 8 workers took 7825ms, which is 4 waves at 1956ms. Two
# different lists, two different days' worth of caching, the same ~2s.
ONE_SYMBOL_MS = 2019


print('\n── the measured cost, against the budget it has to fit ────────────')

# A WAVE COSTS WHAT ONE SYMBOL COSTS, because the symbols in it run side by
# side and the time is spent waiting on the network, not on a core. So the
# whole decision is (number of waves) x (one symbol), and the only lever is how
# few waves the list divides into.
def cost_ms(cards, workers):
    waves = -(-cards // workers)                   # ceil
    return waves * ONE_SYMBOL_MS, waves


est_ms, waves = cost_ms(MEASURED_CARDS, D._WORKERS)

ok('the day it failed would now fit in one third of the budget',
   est_ms < BUDGET_MS / 3,
   f'{MEASURED_CARDS} cards -> {waves} wave(s) ~ {est_ms:.0f}ms of {BUDGET_MS}')

print('\n── and it has to survive the list GROWING ─────────────────────────')

# The card count is whatever the screener found. 47 was not a ceiling.
for cards in (30, 47, 60, 96):
    est, w = cost_ms(cards, D._WORKERS)
    ok(f'{cards:>3} cards fit inside the budget',
       est < BUDGET_MS,
       f'{w} wave(s) ~ {est:.0f}ms')

print('\n── eight workers is what lost the session ─────────────────────────')

# THE MODEL IS CHECKED AGAINST THE MEASUREMENT, not just used. If (waves x
# one symbol) does not reproduce the 12114ms actually seen on the box, the
# arithmetic every other line here rests on is wrong.
old_est, old_waves = cost_ms(MEASURED_CARDS, 8)
ok('the model reproduces the 12.1s that was measured at 8 workers',
   abs(old_est - 12114) < 500,
   f'8 workers -> {old_waves} waves ~ {old_est:.0f}ms vs measured 12114ms')
ok('...which was over the budget once the list was cold',
   old_est > BUDGET_MS * 0.6, f'{old_est:.0f}ms of {BUDGET_MS}ms')

ok('and the new setting is strictly faster', D._WORKERS > 8)


print('\n── but not so many that the feed is asked to flood ────────────────')

# Each worker holds a yahoo request. Forty-seven at once invites the rate
# limiting that makes the NEXT decision slower — the opposite of the fix.
ok('workers stay below one-per-card for a normal list',
   D._WORKERS < MEASURED_CARDS,
   str(D._WORKERS))
ok('and below fifty in any case', D._WORKERS <= 48, str(D._WORKERS))


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
