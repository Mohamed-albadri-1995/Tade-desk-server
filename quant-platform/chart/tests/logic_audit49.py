"""Audit part 49 — the bar cache has a ceiling, and something enforces it.

WHY THIS EXISTS.

Three loaders — alpaca, polygon, yahoo — wrote parquet frames into
~/.qp-cache and NOTHING EVER DELETED ONE. The directory only grew, for the
life of the box, and when it filled the disk the platform stopped working:
not gracefully, and not in a way that pointed at the cache.

Reported from the desk, in these words: "some time after many prints the
memory fill and the tool broke".

A print sheet is what gets there fastest and the arithmetic is not close. One
sheet is up to 150 charts, so a register day is 150 files and twenty register
days is three thousand — each a frame of 1-minute bars over a multi-day
window, hundreds of kilobytes to a megabyte apiece. A few afternoons of
printing is gigabytes, and none of it was ever reclaimed.

PART A — the cache is one place, so a limit cannot miss two thirds of it.
PART B — it trims itself, oldest first, and it trims where it GROWS.
PART C — THE REAL LIMIT IS THE DISK. A cap somebody picked is not a
         protection; the box running out of space is what takes the nine
         screeners, the journal and the alert history down with it.
PART D — it can be deleted on purpose, which is safe by construction.
PART E — it can never be the cause of a failure.
"""
import os
import pathlib
import shutil
import sys
import tempfile
import time

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


# Its own directory: an audit that swept the REAL cache would delete the bars
# somebody is charting while it runs.
_TMP = tempfile.mkdtemp(prefix='qpcache-')
os.environ['QP_CACHE_DIR'] = _TMP

from tools.data import cache                                  # noqa: E402
cache.DIR = pathlib.Path(_TMP)

SRC = (pathlib.Path(__file__).resolve().parents[2] / 'tools' / 'data')


def _fill(n, kb=100, age0=1000):
    """n files of kb each, oldest first by mtime."""
    for f in cache.DIR.glob('*.parquet'):
        f.unlink()
    for i in range(n):
        f = cache.path(f'poly_X_1m_{i:03d}.parquet')
        f.write_bytes(b'0' * (kb * 1000))
        os.utime(f, (age0 + i, age0 + i))


print('== A. one directory, not three ==')
from tools.data import alpaca, polygon, yahoo                  # noqa: E402
ok('every loader writes to the SAME cache',
   alpaca._CACHE_DIR == polygon._CACHE_DIR == yahoo._CACHE_DIR == cache.DIR,
   (alpaca._CACHE_DIR, polygon._CACHE_DIR, yahoo._CACHE_DIR))
# Each of the three used to declare the path itself, so a sweeper pointed at
# one would have missed the other two — and a limit two thirds of the data
# escapes is not a limit.
for name in ('alpaca', 'polygon', 'yahoo'):
    txt = (SRC / f'{name}.py').read_text()
    ok(f'{name} takes the path from the shared module rather than repeating it',
       '_CACHE_DIR = _cache.DIR' in txt)


print()
print('== B. it trims itself, oldest first ==')
cache.MAX_MB = 1.0
cache.MIN_FREE_MB = 0.0          # disk trigger off, so this tests the cap alone
_fill(30)                        # 3MB against a 1MB cap
before = cache.stats()
ok('it knows it is over', before['over'] is True, before)
r = cache.sweep(force=True)
ok('a sweep deletes', r['deleted'] > 0, r)
after = cache.stats()
ok('...down under the cap', after['bytes'] <= cache.MAX_MB * 1e6, after)

# OLDEST FIRST, by modification time: the least recently written window is the
# one least likely to be asked for again. NOT largest-first, which would empty
# the deep-history frames that are the most expensive to re-fetch.
left = sorted(int(p.stem.split('_')[-1]) for p in cache.DIR.glob('*.parquet'))
ok('the OLDEST went and the newest stayed',
   left and left[-1] == 29 and 0 not in left, left)

# ...and it goes BELOW the cap, not exactly to it. A sweep that stopped at the
# line would trip again on the very next write and re-walk the whole directory.
ok('it trims below the line, so the next write does not trip it again',
   after['bytes'] <= cache.MAX_MB * 1e6 * 0.75, after['mb'])

# THROTTLED. A stat of every file on every bar fetch would make the cache
# slower than the network it exists to avoid.
_fill(30)
cache._LAST_SWEEP = time.time()
r2 = cache.sweep()               # not forced — should decline
ok('an unforced sweep does not run twice in a minute', r2['ran'] is False, r2)
ok('...but a person pressing the button is answered now',
   cache.sweep(force=True)['ran'] is True)

# WHERE IT GROWS. The whole mechanism is that the call which creates a file is
# the call that checks the limit — no cron job, nobody remembering.
for name in ('alpaca', 'polygon', 'yahoo'):
    txt = (SRC / f'{name}.py').read_text()
    ok(f'{name} checks the limit after it writes', '_cache.after_write()' in txt)
    ok(f'...right after the write itself',
       txt.index('to_parquet') < txt.index('_cache.after_write()'))


print()
print('== C. the real limit is the disk ==')
# A cap somebody picked is not a protection. This platform shares a box with
# nine screeners, their databases, the alert history and the journal; a full
# disk takes all of them down, and the cache is the only thing here that can
# be deleted without losing something.
cache.MAX_MB = 10_000.0          # cache is nowhere near its own cap
cache.MIN_FREE_MB = 10 ** 9      # ...but the disk is "nearly full"
_fill(20)
r = cache.sweep(force=True)
ok('a nearly-full DISK trims the cache even when it is under its own cap',
   r['deleted'] > 0, r)
ok('...and says the disk was the reason', 'free on the disk' in str(r.get('reason')), r)
# HARDER, because the disk is the emergency: the point is to give the machine
# room back, and everything here can be fetched again.
ok('...taking it further down than a routine trim would',
   cache.stats()['bytes'] < 20 * 100 * 1000 * 0.5, cache.stats())

cache.MIN_FREE_MB = 0.0
ok('both limits are configurable without a code change',
   'QP_CACHE_MAX_MB' in (SRC / 'cache.py').read_text()
   and 'QP_CACHE_MIN_FREE_MB' in (SRC / 'cache.py').read_text())


print()
print('== D. deleting it on purpose ==')
cache.MAX_MB = 10_000.0
_fill(10)
out = cache.clear()
ok('clear() empties it', out['deleted'] == 10 and cache.stats()['files'] == 0, out)

# Only what is old, for reclaiming a print sheet without dropping today's bars.
_fill(10)
now = time.time()
for i, p in enumerate(sorted(cache.DIR.glob('*.parquet'))):
    os.utime(p, (now - (10 * 86400 if i < 6 else 3600),) * 2)
out = cache.clear(older_than_days=2)
ok('...or only what has not been touched in N days', out['deleted'] == 6, out)
ok('...leaving the recent ones', cache.stats()['files'] == 4)

SRV = (pathlib.Path(__file__).resolve().parents[1] / 'server.py').read_text()
ok('there is a way to see how big it is', "@app.get('/api/cache')" in SRV)
ok('...and to delete it', "@app.post('/api/cache/clear')" in SRV)
ok('...and to trim it now on a box that has stopped fetching',
   "@app.post('/api/cache/sweep')" in SRV)
# RECORDED. Deleting a few gigabytes is worth being able to find afterwards.
ok('a deletion is written to the operations log', "oplog.record('cache_clear'" in SRV)

UI = (pathlib.Path(__file__).resolve().parents[1]
      / 'static' / 'index.html').read_text()
ok('the size is on the page, where the delete button is', 'id="cacheStat"' in UI)
ok('...and it says when it is over its limit', 'over, will trim' in UI)
ok('the delete buttons exist and are wired',
   'id="cacheClear"' in UI and "getElementById('cacheClear')" in UI
   and 'id="cacheOld"' in UI and "getElementById('cacheOld')" in UI)
# Safe by construction, and the page says so — otherwise it reads like the
# destructive button on the page that also holds the money settings.
ok('the page says why deleting it is safe', 'copy of' in UI and 'network time' in UI)


print()
print('== E. it can never be the cause of a failure ==')
# A fetch must not fail because the sweeper could not stat a directory, and a
# cache that took the platform down while trying to protect it would be worse
# than the problem it was written for.
_was = cache.DIR
try:
    cache.DIR = pathlib.Path('/proc/nonexistent/cannot/exist')
    ok('stats() on an unreachable directory does not raise',
       isinstance(cache.stats(), dict))
    ok('sweep() does not raise', isinstance(cache.sweep(force=True), dict))
    ok('clear() does not raise', isinstance(cache.clear(), dict))
    ok('path() does not raise', isinstance(cache.path('x.parquet'), pathlib.Path))
except Exception as e:                                        # noqa: BLE001
    ok('the cache never raises', False, e)
finally:
    cache.DIR = _was

# A file that vanishes between the listing and the delete is another process
# doing the same job, not an error.
_fill(3)
files = cache._files()
for f, _, _ in files:
    f.unlink()
ok('a file deleted under it is not an error',
   isinstance(cache._delete(files), tuple))

shutil.rmtree(_TMP, ignore_errors=True)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
