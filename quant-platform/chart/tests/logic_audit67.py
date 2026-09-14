"""One decision fetches each symbol once, not once per strategy.

THE COST, measured on the live desk. `OR + VWAP 09:35` is TWO books — long and
short — over one card list, and every strategy calls prepare_bars for itself:

    2026-09-08  OR + VWAP 09:35  09:34  19375ms
    2026-09-09  OR + VWAP 09:35  09:34  24441ms
    2026-09-08  Test             09:29   1744ms   (one book, nine names)

Twenty-three names became forty-six Yahoo requests through eight workers, on a
setup whose order has to reach the tape inside the 09:35 minute. It did not: PL
was decided at 17.75 on the 09:34 close and filled at 17.5172, 1.26R later.

WHY THE CACHE DID NOT HELP. decide.py says both strategies for a symbol run in
one worker "so the second hits the parquet cache the first just filled". On the
live path there is no cache to hit — and correctly so. A live window ends at
`now`, the loaders key their parquet on the window, and reusing one across
minutes is exactly what served a 14:14 bar at 15:44 on 2026-09-04. `live=True`
skips the parquet on the way in and out.

So the fix is not to re-enable that cache. It is to notice that the two calls
are the SAME QUESTION: `end` is floored to the minute, so both strategies ask
for a window with identical bounds, in the same second, for the same symbol.
One minute's frames are held in memory and dropped the moment the minute
changes.

WHAT THIS AUDIT REFUSES TO LET SLIDE: a replay must not be memoed (parquet
already covers it, and an audit's stub can legitimately answer differently
between calls), a stale minute must not survive, and the loader must not run
inside the lock — holding it across an HTTP call would serialise eight workers
into one, which is the opposite of the point.
"""
import pathlib
import sys
import threading
import time

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs                                    # noqa: E402

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


TODAY = pd.Timestamp.now(tz='America/New_York').strftime('%Y-%m-%d')


class Counting:
    """A loader that says how often it was really asked."""

    def __init__(self, delay=0.0):
        self.n = 0
        self.delay = delay
        self.lock = threading.Lock()

    def load(self, sym, tf, a, b, live=False):
        with self.lock:
            self.n += 1
        if self.delay:
            time.sleep(self.delay)
        idx = pd.DatetimeIndex(
            [pd.Timestamp.now(tz='UTC').floor('min') - pd.Timedelta(minutes=i)
             for i in range(5)][::-1])
        return pd.DataFrame({'open': [1.0] * 5, 'high': [1.0] * 5, 'low': [1.0] * 5,
                             'close': [1.0] * 5, 'volume': [1.0] * 5}, index=idx)


def fresh(delay=0.0):
    ldr = Counting(delay)
    cs._LOADERS['audit67'] = ldr
    cs._forget_live_memo()
    return ldr


def live(sym='PL'):
    # prepare_bars returns (bars, ts, ctx); the frame is what this is about.
    return cs.prepare_bars(sym, '1m', 1, feed='audit67', view='all', asof=TODAY)[0]


# ── the saving ───────────────────────────────────────────────────────────────
ldr = fresh()
live(); live()
ok('two strategies on one symbol fetch it ONCE', ldr.n == 1, str(ldr.n))

ldr = fresh()
for s in ('A', 'B', 'C'):
    live(s); live(s)
ok('three symbols, two books each, is three fetches not six',
   ldr.n == 3, str(ldr.n))

# ── and it is the same data, not a near-enough one ───────────────────────────
ldr = fresh()
a = live()
b = live()
ok('the second caller gets identical bars', a.equals(b))
#
# A COPY EACH WAY. A caller that mutates its frame must not poison the next
# one — they are different objects holding the same numbers.
ok('...but its own copy of them', a is not b)
a.iloc[0, 0] = 999.0
ok('mutating one does not reach the other', b.iloc[0, 0] != 999.0, str(b.iloc[0, 0]))

# ── a replay is left exactly as it was ───────────────────────────────────────
#
# Parquet already covers a finished day, and an audit's stub is entitled to
# answer differently between two calls. Memoing here would make a replay depend
# on what some other test asked a minute ago.
ldr = fresh()
cs.prepare_bars('PL', '1m', 1, feed='audit67', view='all', asof='2026-09-08')
cs.prepare_bars('PL', '1m', 1, feed='audit67', view='all', asof='2026-09-08')
ok('a replay is NOT memoed', ldr.n == 2, str(ldr.n))

# ── the minute is the whole of the key ───────────────────────────────────────
ldr = fresh()
live()
with cs._LIVE_MEMO_LOCK:
    keys = list(cs._LIVE_MEMO)
ok('one live fetch leaves one entry', len(keys) == 1, str(len(keys)))
ok('and the window end is part of its key',
   bool(keys) and ':' in str(keys[0][-1]), str(keys[0] if keys else None))
#
# A FRAME FROM AN EARLIER MINUTE IS DROPPED, not merely unused. Left behind it
# would grow all session, and a stale window is the exact failure `live=True`
# exists to prevent.
with cs._LIVE_MEMO_LOCK:
    cs._LIVE_MEMO[('OLD', '1m', 1, 'audit67', 'all', 'an-earlier-minute')] = \
        pd.DataFrame()
live('ZZ')
with cs._LIVE_MEMO_LOCK:
    left = [k for k in cs._LIVE_MEMO if k[0] == 'OLD']
ok('an entry from another minute is evicted', left == [], str(left))

# ── and the workers stay parallel ────────────────────────────────────────────
#
# The loader must run OUTSIDE the lock. If it did not, eight workers would
# queue behind one HTTP call and the fix would cost more than it saved.
ldr = fresh(delay=0.20)
started = time.time()
threads = [threading.Thread(target=live, args=(f'S{i}',)) for i in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()
elapsed = time.time() - started
ok('six different symbols fetch concurrently, not one behind another',
   elapsed < 0.20 * 3, f'{elapsed:.2f}s for 6 x 0.20s')
ok('...and each was fetched', ldr.n == 6, str(ldr.n))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
