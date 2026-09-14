"""A window Yahoo cannot serve must fail loudly, not come back short.

WHAT WAS RECOMMENDED, WRONGLY. A backtest of 2026-09-08 to 09-14 was proposed on
yahoo 1-minute bars so it would run on the same feed the live desk uses. The
trader's answer was one line: "can't done yahoo has 1 week data". He was right,
and the repository already knew — the MEASURED table beside _RANGE_TOKENS says

    1m   5d      1mo and beyond -> 422

while the module docstring three lines above it said "about a month", and
_MAX_DAYS said 30. Three numbers for one fact, and the wrong one was the one
that got read.

WHY IT IS WORSE THAN A WRONG SENTENCE. `_range_for` ends with

    return tokens[-1][1]

so a request longer than the reach does not fail — it silently asks for the
largest range there is. The frame is filtered to the requested window and handed
back looking exactly like a complete one. A backtest over a week of 1-minute
bars would have quietly lost its earliest sessions and reported a P&L as the
answer to the question that was asked.

That is the same substitution this desk keeps paying for: a short answer read as
a full one. So the reach is derived from the measured table in one place, and an
out-of-reach window raises with that number in the message.

ONLY WHEN THE WINDOW IS STRUCTURALLY TOO LONG. A frame that starts late because
the symbol was halted or listed mid-window is a fact about the symbol, and is
returned untouched.
"""
import pathlib
import sys

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from tools.data import yahoo                                         # noqa: E402

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


def frame(first_day, n=3):
    idx = pd.DatetimeIndex([pd.Timestamp(first_day, tz='UTC') + pd.Timedelta(minutes=i)
                            for i in range(n)])
    return pd.DataFrame({'open': [1.0] * n, 'high': [1.0] * n, 'low': [1.0] * n,
                         'close': [1.0] * n, 'volume': [1.0] * n}, index=idx)


def refused(sym, tf, start, end, df):
    try:
        yahoo._refuse_if_out_of_reach(sym, tf, start, end, df)
        return None
    except ValueError as e:
        return str(e)


# ── one source of truth for the reach ─────────────────────────────────────────
ok('the reach is DERIVED from the measured token table',
   yahoo._reach_days('1m') == yahoo._RANGE_TOKENS['1m'][-1][0],
   str(yahoo._reach_days('1m')))
ok('1-minute bars reach five trading days, not thirty',
   yahoo._reach_days('1m') == 5, str(yahoo._reach_days('1m')))
ok('a longer interval still reaches further',
   yahoo._reach_days('1d') > yahoo._reach_days('1m'))

src = pathlib.Path(yahoo.__file__).read_text()
ok('no second copy of the reach survives anywhere in the module',
   '_MAX_DAYS' not in src)
ok('the docstring no longer says a month at 1-minute resolution',
   'about a month at 1-minute' not in src)
ok('...and it names what it really serves',
   'FIVE TRADING DAYS' in src)

# ── the range token is still chosen, not hoped ────────────────────────────────
S = pd.Timestamp('2026-09-08', tz='UTC')
E = pd.Timestamp('2026-09-14', tz='UTC')
# The +2 weekend guard means even a single day asks for 5d, which is correct:
# a Monday window whose data sits behind a weekend would otherwise come back
# empty. It is the CEILING that must not be exceeded silently, not the token.
ok('a one-day window still asks wide enough to clear a weekend',
   yahoo._range_for('1m', E, E) in ('1d', '5d'), yahoo._range_for('1m', E, E))
ok('a week of 1-minute asks for the ceiling token',
   yahoo._range_for('1m', S, E) == '5d', yahoo._range_for('1m', S, E))

# ── and a short answer is refused rather than returned ────────────────────────
#
# THE CASE THAT MATTERS: the window is far longer than the reach AND the answer
# really did come back starting later than it was asked for.
LONG = pd.Timestamp('2026-08-20', tz='UTC')
msg = refused('PL', '1m', LONG, E, frame('2026-09-09'))
ok('an out-of-reach window that came back short is refused', msg is not None)
ok('...and the message carries the measured reach',
   bool(msg) and '5 trading day' in msg, str(msg)[:80])
ok('...and says it is a SHORT answer, not a quiet market',
   bool(msg) and 'not a quiet market' in msg)
ok('...and names the loader that does have the history',
   bool(msg) and 'polygon' in msg)

# AN EMPTY FRAME OVER A LONG WINDOW IS THE SAME LIE, and the worse one: zero
# bars read as a symbol that did not trade.
ok('an out-of-reach window that came back EMPTY is refused too',
   refused('PL', '1m', LONG, E, frame('2026-09-09').iloc[0:0]) is not None)

# ── and the cases it must leave alone ─────────────────────────────────────────
ok('a window inside the reach passes, weekend included',
   refused('PL', '1m', S, E, frame('2026-09-08')) is None)
ok('a long window that DID come back covering its start passes',
   refused('PL', '1m', LONG, E, frame('2026-08-20')) is None)
#
# A SHORT WINDOW WITH NO BARS IS A FACT ABOUT THE SYMBOL — halted, or listed
# after the window opened. Refusing it would turn a real answer into an error.
ok('a short window with no bars is left alone',
   refused('PL', '1m', S, pd.Timestamp('2026-09-09', tz='UTC'),
           frame('2026-09-09').iloc[0:0]) is None)
ok('a year of daily bars is not out of reach',
   refused('PL', '1d', pd.Timestamp('2026-01-01', tz='UTC'), E,
           frame('2026-01-02')) is None)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
