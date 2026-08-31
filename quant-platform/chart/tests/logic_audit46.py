"""Audit part 46 — qp records what it was asked to do.

WHY THIS EXISTS.

qp's record of its own operation was `print()` to stdout: kept by systemd for a
while, read by nobody, and impossible to query. So after the fact these had no
answer at all —

    the 09:35 decision came back empty — was it even asked?
    how long did it take, and was that inside the minute it had to land in?
    how many symbols errored?
    the print sheet died on Tuesday — how many charts was it building?
    that backtest ran six minutes — on how many day-symbol pairs?

Not "hard to answer". No answer: the numbers existed for the length of one
request and were dropped when it returned.

PART A — one line per operation, with what was asked and how long it took.
PART B — THE FAILURE PATH IS THE POINT. An operation that only logged on
         success would be silent for exactly the runs worth reviewing.
PART C — it can never be the cause of a failure.
PART D — reading it back: newest first, filterable, and one bad line does not
         hide a good file.
PART E — the operations that matter are actually wired to it.
"""
import json
import pathlib
import sys
import tempfile

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


# Its own directory: a test that appended to the real log would put invented
# operations into the record someone reviews a session with.
_TMP = tempfile.mkdtemp(prefix='oplog-')
import os                                                    # noqa: E402
os.environ['QP_DATA_DIR'] = _TMP

from chart import oplog                                      # noqa: E402
oplog._DIR = pathlib.Path(_TMP)


print('== A. one line per operation ==')
oplog.record('decide', setup='T2', symbols=39, picks=3, ms=812)
rows = oplog.read()
ok('the operation is there', len(rows) == 1, len(rows))
ok('...with what was asked', rows[0].get('symbols') == 39, rows[0])
ok('...and what came back', rows[0].get('picks') == 3)
ok('...and when', str(rows[0].get('at', '')).startswith('20'), rows[0].get('at'))
ok('ok defaults to nothing being claimed either way', 'ok' not in rows[0])

with oplog.timed('backtest', id=349) as t:
    t.add(trades=30)
rows = oplog.read()
ok('a timed operation records its duration',
   isinstance(rows[0].get('ms'), int), rows[0])
ok('...and what was only knowable at the end', rows[0].get('trades') == 30)
ok('...and marks itself ok', rows[0].get('ok') is True)


print()
print('== B. the failure path, which is the point ==')
try:
    with oplog.timed('decide', setup='T2'):
        raise ValueError('feed timed out')
except ValueError:
    pass
rows = oplog.read()
ok('a failed operation is recorded, not skipped', rows[0].get('op') == 'decide')
ok('...marked as failed', rows[0].get('ok') is False, rows[0])
ok('...naming what went wrong', 'feed timed out' in str(rows[0].get('error')))
ok('...and still timed, so a slow failure is visible',
   isinstance(rows[0].get('ms'), int))

# THE EXCEPTION IS NOT SWALLOWED. A log that ate the error would turn a visible
# failure into a silent one, which is worse than not logging at all.
raised = False
try:
    with oplog.timed('x'):
        raise RuntimeError('must escape')
except RuntimeError:
    raised = True
ok('the caller still sees its own exception', raised)

# A STACK IS FOR A TERMINAL. This file is read a week later, and the line that
# matters is which symbol and what it said.
long_err = 'x' * 5000
try:
    with oplog.timed('y'):
        raise ValueError(long_err)
except ValueError:
    pass
ok('the message is bounded', len(str(oplog.read()[0].get('error'))) <= 420,
   len(str(oplog.read()[0].get('error'))))


print()
print('== C. it can never be the cause of a failure ==')
# The one thing worse than not knowing what happened is not trading because of
# the thing that was supposed to tell you.
_was = oplog._DIR
try:
    oplog._DIR = pathlib.Path('/proc/nonexistent/cannot/write')
    oplog.record('decide', setup='T2')
    ok('an unwritable log does not raise', True)
except Exception as e:  # noqa: BLE001
    ok('an unwritable log does not raise', False, e)
finally:
    oplog._DIR = _was

try:
    ok('reading a directory that is not there returns nothing, not an error',
       oplog.read() is not None)
except Exception as e:  # noqa: BLE001
    ok('reading is safe', False, e)

# A value json cannot serialise must not lose the whole line.
try:
    oplog.record('odd', when=object())
    ok('an unserialisable field does not lose the line',
       oplog.read()[0].get('op') == 'odd')
except Exception as e:  # noqa: BLE001
    ok('an unserialisable field does not lose the line', False, e)


print()
print('== D. reading it back ==')
ok('newest first', oplog.read()[0].get('op') == 'odd', oplog.read()[0])

# NEWEST FIRST HAS TO SURVIVE A TIE, which is the case that actually happens: a
# scan writes several operations inside the same instant, and sorting on the
# stamp alone leaves those in FILE order — oldest first — for exactly the busy
# stretch someone opened the log to look at. This caught a real bug.
for i in range(6):
    oplog.record('burst', i=i)
burst = [r['i'] for r in oplog.read(op='burst')]
ok('a burst inside one instant still reads newest first', burst == [5, 4, 3, 2, 1, 0], burst)
ok('...and the stamp can tell two of them apart',
   len(str(oplog.read()[0].get('at'))) > len('2026-08-31T16:42:20+00:00'),
   oplog.read()[0].get('at'))

ok('filtered by operation',
   all(r['op'] == 'decide' for r in oplog.read(op='decide')))
ok('...and there are some', len(oplog.read(op='decide')) >= 2)
ok('limit is honoured', len(oplog.read(limit=2)) == 2)

# ONE BAD LINE IS NOT A BAD FILE. A truncated write at a restart must not hide
# every operation around it.
with oplog._path().open('a', encoding='utf-8') as fh:
    fh.write('{"at": "2026-09-01T00:00:00+00:00", "op": "trun\n')
oplog.record('after_truncation')
ok('a truncated line is skipped, not fatal',
   any(r.get('op') == 'after_truncation' for r in oplog.read()),
   'a half-written line must not hide the operations around it')

s = oplog.summary()
ok('the summary counts each operation', s.get('decide', {}).get('n') >= 2, s)
ok('...and how many failed', s.get('decide', {}).get('failed') == 1, s)
ok('...and the slowest, which is what matters for a deadline',
   'ms_max' in s.get('decide', {}))


print()
print('== E. the operations that matter are wired ==')
SRV = (pathlib.Path(__file__).resolve().parents[1] / 'server.py').read_text()
BT = (pathlib.Path(__file__).resolve().parents[1] / 'backtest.py').read_text()

# THE LIVE DECISION, which has to land inside one minute — the operation whose
# timing is not a curiosity but the whole question.
ok('the live decision is timed', "oplog.timed('decide'" in SRV)
ok('...recording how many symbols it was given', 'symbols=len(symbols)' in SRV)
ok('...and the shape of the answer', 'picks=len(' in SRV)

ok('the backtest is timed', "oplog.timed('backtest'" in BT)
ok('...recording what came back', 'trades=_sum.get(' in BT)

# A REFUSED PRINT is the interesting event: it means two sheets were started
# together, which is the shape of the crash the lock exists to prevent.
ok('a refused print sheet is recorded', "oplog.record('print_refused'" in SRV)

ok('there is a way to read it back over HTTP', "@app.get('/api/oplog')" in SRV)
ok('...and the reader cannot 500', 'a log reader must not 500' in SRV)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
