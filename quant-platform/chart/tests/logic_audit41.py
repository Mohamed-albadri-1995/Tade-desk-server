"""Audit part 41 — the print sheet is bounded, and refuses rather than queues.

THE CRASH THIS EXISTS TO PREVENT.

Two or three R1 print sheets started together took the server down, and adding
memory from 10 GB to 20 GB did not change it. That is the signature of an
UNBOUNDED job rather than a large one: more memory does not bound it, it only
moves the point where it falls over.

Three things were unbounded at once, and all three are per-request:

  THE FETCH — compute_data() materialises up to _MAX_DAYS[tf] days of bars to
  draw a two-day window. On 1-minute bars in full extended hours that is about
  57,600 rows per ticker to display roughly 1,900 of them, plus every overlay
  series computed across the whole span.

  THE SHEET — every chart is held until the last one is built, then
  json.dumps() makes the whole payload one string, the f-string template copies
  it into a larger one, and HTMLResponse encodes that to UTF-8. Three copies
  live at the same moment before a byte is sent.

  THE COUNT — nothing limited how many tickers a sheet could contain.

The backtest has taken a lock since it was written. Printing took nothing.

PART A — one at a time, and the second is REFUSED, not queued.
PART B — refusing returns a readable page, not an error status.
PART C — the lock is released even when the build raises.
PART D — both print endpoints share the one lock.
PART E — the chart count is capped, and truncation is announced.
PART F — each ticker's bar frame is dropped as soon as it is filtered.
"""
import pathlib
import re
import sys
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

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


SRC = (pathlib.Path(__file__).resolve().parents[1] / 'server.py').read_text()


print('== A. one at a time, and the second is refused ==')
import chart.server as S                                        # noqa: E402

ok('the print lock exists and is a real lock',
   isinstance(getattr(S, '_PRINT_LOCK', None), type(threading.Lock())),
   type(getattr(S, '_PRINT_LOCK', None)))

# NON-BLOCKING is the whole point. Blocking would hold a threadpool worker for
# the minutes a rate-limited Polygon fetch can take — the second request would
# wait, holding memory of its own, and both would still be alive when the box
# ran out. Refusing costs one page render.
ok('the lock is acquired NON-blocking',
   'acquire(blocking=False)' in SRC,
   'a blocking acquire would queue requests instead of refusing them')
# ONCE PER SHEET-BUILDING ENDPOINT, counted rather than hardcoded.
#
# It was pinned at exactly two, which was right when there were two sheets and
# became a failing test the day a third arrived — reporting a fault in the
# lock when the lock was fine. Worse, the number it should have been checking
# is not "two": it is "every endpoint that fetches weeks of bars takes it, and
# none of them forgets". A count against the endpoints themselves says that;
# a literal says only that nobody has added a sheet.
_takers = SRC.count('_PRINT_LOCK.acquire(blocking=False)')
# The endpoints that build one. Each calls a _build_*sheets() and each is the
# expensive fetch this lock exists to keep from running three at a time.
_sheets = len([m for m in ('def r1_print(', 'def pairs_print(', 'def r1_swing(')
               if m in SRC])
ok('every sheet-building endpoint takes it — none forgets',
   _takers == _sheets, (_takers, _sheets))
ok('...and every one of them releases it',
   SRC.count('_PRINT_LOCK.release()') == _takers,
   (SRC.count('_PRINT_LOCK.release()'), _takers))

# Held, the second attempt must fail immediately rather than wait.
S._PRINT_LOCK.acquire()
try:
    got = S._PRINT_LOCK.acquire(blocking=False)
    ok('a second acquire fails while the first holds it', got is False, got)
    if got:
        S._PRINT_LOCK.release()
finally:
    S._PRINT_LOCK.release()
ok('and the lock is free again afterwards',
   S._PRINT_LOCK.acquire(blocking=False) is True)
S._PRINT_LOCK.release()


print()
print('== B. refusing returns a PAGE, not an error status ==')
# This URL is opened in a browser tab. A 503 renders as the browser's own
# failure screen with none of the explanation on it, so the user learns
# nothing except that something broke — which is what they already knew.
busy = S._print_busy()
body = busy.body.decode()
ok('the busy response is 200, so the browser shows the text',
   busy.status_code == 200, busy.status_code)
ok('it says another sheet is building', 'still building' in body, body[:80])
ok('it says why only one runs at a time',
   'one runs at a time' in body and 'three at once' in body, body[:200])
ok('and it says what to do next', 'reload' in body.lower())


print()
print('== C. the lock is released even when the build raises ==')
# A sheet that failed while holding the lock would lock printing out until the
# process restarted — one bad register day disabling the feature for the day.
r1 = SRC[SRC.index('def r1_print('):]
r1 = r1[:r1.index('\ndef ', 1)] if '\ndef ' in r1[1:] else r1
ok('r1_print releases in a finally block',
   re.search(r'try:\s*\n.*?_build_sheets.*?\n\s*finally:\s*\n(?:\s*#.*\n)*\s*_PRINT_LOCK\.release\(\)',
             r1, re.S) is not None)

pp = SRC[SRC.index('def pairs_print('):]
pp = pp[:pp.index('\n@app.', 1)] if '\n@app.' in pp else pp
ok('pairs_print releases in a finally block',
   re.search(r'try:\s*\n.*?_build_pair_sheets.*?\n\s*finally:\s*\n\s*_PRINT_LOCK\.release\(\)',
             pp, re.S) is not None)


print()
print('== D. BOTH endpoints are guarded ==')
# Guarding one and not the other moves the crash rather than fixing it: the
# unguarded route is still three concurrent unbounded jobs.
ok('r1_print takes the lock', '_PRINT_LOCK.acquire' in r1)
ok('pairs_print takes the lock', '_PRINT_LOCK.acquire' in pp)
ok('they share ONE lock, not one each',
   SRC.count('_PRINT_LOCK = _threading.Lock()') == 1)


print()
print('== E. the chart count is capped, and says so ==')
cap = getattr(S, '_PRINT_MAX_CHARTS', None)
ok('a cap exists', isinstance(cap, int) and cap > 0, cap)
ok('and it is high enough for a real register day', cap >= 100, cap)

cf = SRC[SRC.index('def _charts_for_day('):]
cf = cf[:cf.index('\n\n\n')]
ok('the loop stops at the cap', '_PRINT_MAX_CHARTS' in cf)
# THE POINT: a sheet that silently stopped would read as "only this many names
# qualified" — a claim about the market rather than about the sheet.
ok('truncation is recorded as an error the page shows',
   'NOT drawn' in cf and 'errors.append' in cf)
ok('and it names how many were left out', 'len(tickers) - len(charts)' in cf)


print()
print('== F. each ticker frame is dropped once filtered ==')
# The peak becomes ONE ticker's history rather than the whole sheet's. Without
# it, forty tickers' worth of 60-day 1-minute frames can be live at once.
ok('data is released in a finally, per ticker',
   re.search(r'finally:\s*\n(?:\s*#.*\n)*\s*data = None', cf) is not None,
   'the frame must be dropped whether the ticker succeeded or failed')


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
