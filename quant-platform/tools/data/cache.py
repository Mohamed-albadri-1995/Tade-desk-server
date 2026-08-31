"""The bar cache: where it lives, how big it may get, and what removes it.

WHY THIS FILE EXISTS.

Three loaders — alpaca, polygon, yahoo — each wrote parquet files into
~/.qp-cache and NOTHING EVER DELETED ONE. The directory only grew, for the
life of the box, and when it filled the disk the platform stopped working:
not gracefully, and not in a way that pointed at the cache.

A print sheet is what gets there fastest, and the arithmetic is not close.
One sheet is up to 150 charts; a register day is 150 files; twenty register
days is three thousand. Each is a frame of 1-minute bars across a multi-day
window — hundreds of kilobytes to a megabyte apiece. A few afternoons of
printing is gigabytes, and none of it was ever reclaimed.

WHAT A CACHE IS FOR, AND WHAT IT IS NOT. It is a copy of something that can
be fetched again. Losing all of it costs time; keeping all of it costs the
machine. So it has a ceiling, and when it reaches one the OLDEST goes first —
the least recently useful, and the most likely to be a window nobody will ask
for again.

THE REAL LIMIT IS THE DISK, NOT A NUMBER SOMEBODY PICKED. A 512MB cap is
comfortable on a box with 20GB free and fatal on one with 300MB. So there are
two triggers and either one fires:

    the cache is over its own ceiling      trim to the ceiling
    the DISK is nearly full                trim hard, whatever the cache size

The second is the one that matters. This platform shares a box with nine
screeners, their databases, the alert history and the journal — a full disk
takes all of them down, and the cache is the only thing here that can be
deleted without losing something.

NEVER THE CAUSE OF A FAILURE. Every function swallows its own errors. A fetch
must not fail because the sweeper could not stat a directory, and a cache that
takes the platform down while trying to protect it would be worse than the
problem it was written for.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

DIR = Path(os.environ.get('QP_CACHE_DIR') or (Path.home() / '.qp-cache'))

# The cache's own ceiling, in megabytes. Generous enough that ordinary use
# never trims, small enough that it cannot be the thing that fills a disk.
MAX_MB = float(os.environ.get('QP_CACHE_MAX_MB') or 512)

# ...and the floor under the DISK. If free space falls under this, the cache
# is trimmed regardless of its own size — see the module note.
MIN_FREE_MB = float(os.environ.get('QP_CACHE_MIN_FREE_MB') or 1024)

# How often the sweeper is allowed to walk the directory. A stat of every file
# on every bar fetch would make the cache slower than the network it exists to
# avoid; once a minute is far more often than it can fill.
_EVERY_S = 60.0

_LOCK = threading.Lock()
_LAST_SWEEP = 0.0


def path(name: str) -> Path:
    """A file in the cache. Creates the directory; never raises."""
    try:
        DIR.mkdir(parents=True, exist_ok=True)
    except Exception:                     # noqa: BLE001 — see the module note
        pass
    return DIR / name


def _files():
    try:
        out = []
        for f in DIR.glob('*.parquet'):
            try:
                st = f.stat()
                out.append((f, st.st_mtime, st.st_size))
            except OSError:               # deleted under us — not an error
                continue
        return out
    except Exception:                     # noqa: BLE001
        return []


def free_mb() -> float:
    """Free space on the volume the cache is on, in MB. -1 when unknown."""
    try:
        return shutil.disk_usage(str(DIR)).free / 1e6
    except Exception:                     # noqa: BLE001
        return -1.0


def stats() -> dict:
    """What is in there, for anything that has to SAY so before deleting it."""
    files = _files()
    total = sum(s for _, _, s in files)
    mtimes = [m for _, m, _ in files]
    return {
        'dir': str(DIR),
        'files': len(files),
        'bytes': total,
        'mb': round(total / 1e6, 1),
        'max_mb': MAX_MB,
        'free_mb': round(free_mb(), 1),
        'min_free_mb': MIN_FREE_MB,
        'oldest': min(mtimes) if mtimes else None,
        'newest': max(mtimes) if mtimes else None,
        # Whether it would trim right now, so a page can say "over its limit"
        # rather than making someone compare two numbers.
        'over': bool(total > MAX_MB * 1e6
                     or (0 <= free_mb() < MIN_FREE_MB)),
    }


def _delete(files) -> tuple:
    """Delete a list of (path, mtime, size). Returns (count, bytes)."""
    n = b = 0
    for f, _, size in files:
        try:
            f.unlink()
            n += 1
            b += size
        except OSError:
            continue
    return n, b


def sweep(force: bool = False) -> dict:
    """Trim the cache to its ceiling, oldest first. Never raises.

    OLDEST FIRST, by modification time: the least recently written window is
    the one least likely to be asked for again. Not largest-first, which would
    empty the deep-history frames that are the most expensive to refetch.

    `force` skips the once-a-minute throttle — used by the endpoint, so a
    person who presses the button gets an answer about now rather than about
    the last time a fetch happened to trigger one.
    """
    global _LAST_SWEEP
    out = {'ran': False, 'deleted': 0, 'freed_bytes': 0, 'reason': None}
    try:
        with _LOCK:
            now = time.time()
            if not force and (now - _LAST_SWEEP) < _EVERY_S:
                return out
            _LAST_SWEEP = now

        files = _files()
        total = sum(s for _, _, s in files)
        free = free_mb()

        # TWO TRIGGERS, and the disk one wins because it is the one that takes
        # the whole box down rather than just this tool.
        low_disk = 0 <= free < MIN_FREE_MB
        over_cap = total > MAX_MB * 1e6
        if not (low_disk or over_cap):
            return out

        # How far down to trim. Under the ceiling with room to spare, so the
        # next fetch does not immediately trip it again and re-walk the whole
        # directory — a sweeper that runs on every write is its own problem.
        target = MAX_MB * 1e6 * 0.7
        if low_disk:
            # THE EMERGENCY TARGET IS COMPUTED FROM WHAT IS THERE, NOT FROM
            # THE CAP — and this was a real bug, found by the audit.
            #
            # It used to be `min(target, MAX_MB * 0.25)`, which reads as
            # "trim hard" and is not: with a 512MB cap and 60MB of cache on a
            # disk with 200MB free, the target came out at 128MB, the cache
            # was already under it, and NOTHING WAS DELETED. The sweeper
            # reported the disk as the reason, said it had run, and freed
            # zero bytes — an emergency path that announces itself and does
            # nothing is worse than not having one, because the log then says
            # the cache was handled.
            #
            # Two bounds, and the smaller wins:
            #   what still fits   leave only what the disk can afford
            #   a quarter of it   because the disk is the emergency and every
            #                     file here can be fetched again
            need = max(0.0, (MIN_FREE_MB - free) * 1e6)
            target = min(target, max(0.0, total - need), total * 0.25)
            out['reason'] = f'only {free:.0f}MB free on the disk'
        else:
            out['reason'] = f'cache is {total/1e6:.0f}MB, over its {MAX_MB:.0f}MB limit'

        files.sort(key=lambda t: t[1])           # oldest first
        doomed, running = [], total
        for f in files:
            if running <= target:
                break
            doomed.append(f)
            running -= f[2]
        n, b = _delete(doomed)
        out.update({'ran': True, 'deleted': n, 'freed_bytes': b,
                    'freed_mb': round(b / 1e6, 1),
                    'left_mb': round((total - b) / 1e6, 1)})
        return out
    except Exception as e:                # noqa: BLE001 — see the module note
        out['error'] = str(e)[:200]
        return out


def clear(older_than_days: float | None = None) -> dict:
    """Delete the cache — all of it, or only what has not been touched in
    `older_than_days`. Never raises.

    The whole thing is a safe operation: every file is a copy of something the
    feeds can return again. It costs the next fetch its network time and
    nothing else.
    """
    out = {'deleted': 0, 'freed_bytes': 0, 'freed_mb': 0.0}
    try:
        files = _files()
        if older_than_days is not None:
            cut = time.time() - float(older_than_days) * 86400
            files = [f for f in files if f[1] < cut]
        n, b = _delete(files)
        out.update({'deleted': n, 'freed_bytes': b, 'freed_mb': round(b / 1e6, 1)})
    except Exception as e:                # noqa: BLE001
        out['error'] = str(e)[:200]
    return out


def after_write() -> None:
    """Called by a loader once it has written a file.

    The whole self-limiting mechanism is this one call: the cache is checked
    where it GROWS, so it cannot grow without being checked. Throttled inside
    sweep(), so the common case is a clock comparison.
    """
    sweep()
