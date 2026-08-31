"""What qp was asked to do, what it answered, and how long it took.

WHY THIS EXISTS.

qp's record of its own operation was `print()` to stdout, which systemd keeps
for a while and nobody reads, and which cannot be queried at all. So after the
fact these had no answer:

    the 09:35 decision came back empty — was it asked?
    how long did it take, and was that inside the minute it had to land in?
    which symbols did it evaluate, and how many errored?
    the print sheet died on Tuesday — how many charts was it building?
    that backtest ran for six minutes — on how many day-symbol pairs?

Not "hard to answer". No answer: the numbers existed inside one request and
were dropped when it returned.

WHAT IT IS.

One JSON object per operation, appended to a file named for the month, holding
what was ASKED, what came BACK, and how long it took. Reviewed with a reader,
not by scrolling a terminal.

WHAT IT IS DELIBERATELY NOT.

  NOT the alert feed. That is for things worth interrupting someone about. A
  line per decision would bury the one line that mattered.

  NOT a debugger. It records the shape of an answer — counts, timings, error
  text — never the answer itself. A day of full backtest payloads is hundreds
  of megabytes and none of it is what the question needs.

  NOT a replacement for the exception. A failure is still raised and still
  reported to the caller; this only means the failure is still findable
  tomorrow.

NEVER THE CAUSE OF A FAILURE. Every function here swallows its own errors. A
log that could take the decision down with it would be worse than no log — the
one thing worse than not knowing what happened is not trading because of the
thing that was supposed to tell you.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
import threading
import time

# Beside the strategy database rather than inside the repo, so a deploy never
# wipes the record of what the desk did last week — the same reasoning that put
# the database there.
_DIR = pathlib.Path(os.environ.get('QP_DATA_DIR')
                    or (pathlib.Path(__file__).resolve().parent / 'data'))

_LOCK = threading.Lock()

# One file per MONTH. A single growing file eventually cannot be opened on the
# box that wrote it, and one per day is a directory nobody can scan by eye.
_MAX_ERR = 400          # an error message, not a stack trace


def _path(when: _dt.datetime | None = None) -> pathlib.Path:
    d = when or _dt.datetime.now(_dt.timezone.utc)
    return _DIR / f'oplog-{d:%Y-%m}.jsonl'


def record(op: str, **fields) -> None:
    """Append one operation. Never raises."""
    try:
        row = {
            # MILLISECONDS, not seconds. A decision that has to land inside one
            # minute is described by a stamp that can tell two of them apart,
            # and a second is long enough to hold a whole scan.
            'at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='milliseconds'),
            'op': str(op),
            **fields,
        }
        _DIR.mkdir(parents=True, exist_ok=True)
        line = json.dumps(row, default=str)
        # Locked because FastAPI serves on a threadpool and two appends can
        # interleave inside one line — which makes the file unparseable from
        # that point on, silently, until someone tries to read it.
        with _LOCK:
            with _path().open('a', encoding='utf-8') as fh:
                fh.write(line + '\n')
    except Exception:  # noqa: BLE001 — see the module note
        pass


class timed:
    """Context manager: records once, with `ms`, whether or not it raised.

        with oplog.timed('decide', symbols=len(syms), date=day) as t:
            out = decide(...)
            t.add(picks=len(out['picks']))

    THE FAILURE PATH IS THE POINT. An operation that only logged on success
    would be silent for exactly the runs worth reviewing.
    """

    def __init__(self, op: str, **fields):
        self.op = op
        self.fields = dict(fields)
        self._t0 = 0.0

    def add(self, **fields):
        """Anything only knowable once the work is done."""
        self.fields.update(fields)
        return self

    def __enter__(self):
        self._t0 = time.time()
        return self

    def __exit__(self, exc_type, exc, tb):
        ms = int((time.time() - self._t0) * 1000)
        if exc is not None:
            self.fields['ok'] = False
            # The message, not the traceback: a stack is for a terminal and
            # this file is read a week later, when the line that matters is
            # "which symbol, and what did it say".
            self.fields['error'] = f'{exc_type.__name__}: {exc}'[:_MAX_ERR]
        else:
            self.fields.setdefault('ok', True)
        record(self.op, ms=ms, **self.fields)
        return False        # never swallow the caller's exception


def read(limit: int = 200, op: str = '', day: str = '',
         months: int = 2) -> list:
    """The most recent operations, newest first. Never raises.

    `months` back rather than "everything": the reader is for looking at what
    just happened, and a year of files is not a page.
    """
    rows: list = []
    try:
        now = _dt.datetime.now(_dt.timezone.utc)
        files = []
        for i in range(max(1, int(months))):
            y, m = now.year, now.month - i
            while m <= 0:
                m += 12
                y -= 1
            files.append(_DIR / f'oplog-{y:04d}-{m:02d}.jsonl')
        # `seq` is the append position, which is what breaks a tie CORRECTLY.
        # Two operations can finish inside the same millisecond, and sorting on
        # the stamp alone leaves those in file order — i.e. OLDEST FIRST, for
        # exactly the busy stretch someone opened the log to look at. Files are
        # walked newest month first, so a later file gets a higher base.
        seq = 0
        for f in reversed(files):
            if not f.exists():
                continue
            for line in f.read_text(encoding='utf-8').splitlines():
                seq += 1
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    # ONE BAD LINE IS NOT A BAD FILE. A truncated write at a
                    # restart must not hide every operation around it.
                    continue
                if op and row.get('op') != op:
                    continue
                if day and not str(row.get('at', '')).startswith(day):
                    continue
                rows.append((seq, row))
    except Exception:  # noqa: BLE001 — see the module note
        return [r for _, r in rows][:limit]
    rows.sort(key=lambda p: (str(p[1].get('at', '')), p[0]), reverse=True)
    return [r for _, r in rows][:int(limit)]


def summary(day: str = '') -> dict:
    """Counts and timings per operation, for the day asked for.

    The shape of a session in one object: how many decisions, how many failed,
    and how slow the slowest was — which is the question that matters for an
    operation that has to land inside one minute.
    """
    out: dict = {}
    for row in read(limit=20000, day=day, months=2):
        op = str(row.get('op') or '?')
        g = out.setdefault(op, {'n': 0, 'failed': 0, 'ms_max': 0, 'ms_total': 0})
        g['n'] += 1
        if row.get('ok') is False:
            g['failed'] += 1
        ms = row.get('ms')
        if isinstance(ms, (int, float)):
            g['ms_max'] = max(g['ms_max'], int(ms))
            g['ms_total'] += int(ms)
    for g in out.values():
        g['ms_avg'] = int(g['ms_total'] / g['n']) if g['n'] else 0
        del g['ms_total']
    return out
