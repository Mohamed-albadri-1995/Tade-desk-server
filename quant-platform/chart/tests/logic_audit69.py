"""The warm-up floor belongs to the ANCHOR, not to the word before the dot.

2026-09-14. Every card on the list refused, all day, nothing traded:

    XNCR :: yahoo serves about 5 trading day(s) of 1m bars; the window asked
            for spans 42 calendar day(s) from 2026-08-03 and the answer came
            back starting 2026-09-08 …

`OR + VWAP 09:35` is built from `vwap.session` and `levels.window_high(930,
945)`. Both anchor INSIDE the current session — a session VWAP resets at the
open, an opening range is the first fifteen minutes of today. Neither can see
yesterday, let alone six weeks ago. The strategy was asking for forty-two days
of 1-minute bars to compute two numbers that come from one session.

WHY. required_days applied a flat forty-day floor to every primitive whose key
began `vwap.` or `levels.`, because that floor was written for `vwap.monthly`
and `levels.prev_month_open` — anchors that really do reach back. The group
prefix cannot tell `vwap.monthly` from `vwap.session`; only the key can.

WHY IT SURFACED AS A DEAD SESSION AND NOT AS A BUG. Yahoo serves five trading
days of 1m and answers a longer ask with the largest range it has. So for
months the over-ask came back SHORT and nothing said so — while the backtests
of the same strategies ran on polygon, which can serve forty days. The two
sides warmed their indicators on different histories, and the only visible
symptom was that live and backtest sometimes picked different names.

logic_audit65 made that short answer fail loudly, which was right. It also
turned a request that had been quietly wrong for months into a fatal one. The
loud failure was correct; the request it refused was the defect.

CONSERVATIVE BY CONSTRUCTION. A key not named in _SESSION_SCOPE_DAYS keeps the
forty-day floor, so a wrong entry can only ever cost history that was already
being fetched. The anchors that reach FURTHER than the floor are untouched in
_WARMUP_DAYS, and the bar-count lookbacks (atr_length, lookback, left/right)
are still added on top.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from chart import data_manager as dm                                 # noqa: E402

required_days = dm.required_days
_HISTORY_FLOOR_DAYS = dm._HISTORY_FLOOR_DAYS
_HISTORY_GROUPS = dm._HISTORY_GROUPS
_WARMUP_DAYS = dm._WARMUP_DAYS
_MAX_DAYS = dm._MAX_DAYS
_PREV_SESSION_DAYS = getattr(dm, '_PREV_SESSION_DAYS', 1)
# READ SOFTLY, so the BEHAVIOUR below is what fails on a file without the table
# rather than the import. A test that dies at line 41 proves a name is missing;
# these have to prove a session VWAP stopped asking for six weeks.
_SESSION_SCOPE_DAYS = getattr(dm, '_SESSION_SCOPE_DAYS', {})
from tools.data import yahoo                                         # noqa: E402
import pandas as pd                                                  # noqa: E402

_reach_days = yahoo._reach_days

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


def ov(key, **params):
    return {'key': key, 'params': params}


BASE = 2          # what chart/decide.py asks a live decision for

print('\n── the session anchors ask for a session ──────────────────────────')

# THE ONE THAT KILLED THE DAY. A session VWAP resets at 09:30.
ok('vwap.session no longer forces a forty-day fetch',
   required_days([ov('vwap.session')], '1m', BASE) < 10,
   f'got {required_days([ov("vwap.session")], "1m", BASE)}')

# AND THE OPENING RANGE. levels.window_high(930, 945) is today's first fifteen
# minutes — the other half of OR + VWAP 09:35.
ok('the opening range is a one-session ask',
   required_days([ov('levels.window_high', start=930, end=945)], '1m', BASE) < 10)

OR_VWAP = [ov('vwap.session'),
           ov('levels.window_high', start=930, end=945),
           ov('levels.window_low', start=930, end=945)]

# THE WHOLE POINT, AND ASKED OF THE THING THAT ACTUALLY REFUSES.
#
# Not "is the number small" — the number is in CALENDAR days and the reach is
# in TRADING days, and comparing them directly is the kind of arithmetic that
# is correct about the wrong thing. tools/data/yahoo._refuse_if_out_of_reach is
# what raised on 2026-09-14; the assertion is that it no longer does, on the
# same shape of window, with an answer that starts where yahoo's 5d starts.
E = pd.Timestamp('2026-09-14 20:00', tz='UTC')      # the day nothing traded


def yahoo_refuses(need_days, first_bar='2026-09-08'):
    """What yahoo would say to a window this long, answered from its 5d."""
    start = E - pd.Timedelta(days=need_days)
    idx = pd.DatetimeIndex([pd.Timestamp(first_bar, tz='UTC')
                            + pd.Timedelta(minutes=i) for i in range(3)])
    df = pd.DataFrame({'open': [1.0] * 3, 'high': [1.0] * 3, 'low': [1.0] * 3,
                       'close': [1.0] * 3, 'volume': [1] * 3}, index=idx)
    try:
        yahoo._refuse_if_out_of_reach('PL', '1m', start, E, df)
        return None
    except Exception as exc:                        # noqa: BLE001 — that is the point
        return str(exc)


ok('OR + VWAP 09:35 is no longer refused by yahoo',
   yahoo_refuses(required_days(OR_VWAP, '1m', BASE)) is None,
   f'asked {required_days(OR_VWAP, "1m", BASE)}d: {yahoo_refuses(required_days(OR_VWAP, "1m", BASE))}')

# AND IT WAS REFUSED BEFORE. Without this the test above could pass against a
# file that changed nothing, on a guard that refuses nothing.
ok('and the 42 days it used to ask for were refused',
   yahoo_refuses(BASE + _HISTORY_FLOOR_DAYS) is not None)

# THE PREVIOUS SESSION IS STILL IN THE WINDOW, which is what the fetch is for.
# Five calendar days back from a Monday is the Wednesday before it.
ok('and the window still reaches the previous session',
   required_days(OR_VWAP, '1m', BASE) >= _PREV_SESSION_DAYS)

print('\n── the anchors that DO reach back are untouched ───────────────────')

ok('vwap.monthly still gets the full floor',
   required_days([ov('vwap.monthly')], '1m', BASE) >= _HISTORY_FLOOR_DAYS)
#
# ITS SEVENTY DAYS ARE ASKED FOR AND THEN CAPPED — _MAX_DAYS puts a 60-day
# ceiling on 1m so a heavy combo cannot OOM the box, and the module already
# says so: on 1m these anchors cannot be met and _snapshot warns rather than
# drawing a wrong level. What matters here is that this change did not touch
# it: it still asks for everything 1m allows.
ok('levels.prev_month_open still asks for every 1m day there is',
   required_days([ov('levels.prev_month_open')], '1m', BASE) == _MAX_DAYS['1m'])
ok('and on 15m, where the ceiling is not in the way, it gets its 70',
   required_days([ov('levels.prev_month_open')], '15m', BASE)
   >= _WARMUP_DAYS['levels.prev_month_open'])

# THE HEAVIEST WINS, which is what max() is for. A strategy that uses both a
# session VWAP and a monthly one still fetches the month.
ok('a session anchor beside a monthly one does not shorten the monthly',
   required_days([ov('vwap.session'), ov('vwap.monthly')], '1m', BASE)
   == required_days([ov('vwap.monthly')], '1m', BASE))

# rel_volume's length counts SESSIONS (20 of them). That is a real reach and it
# is NOT shortened here — so a strategy carrying it is still out of yahoo's
# reach, and will still be refused. That refusal is now the truth.
ok('rel_volume(20 sessions) is still a month-and-a-half ask',
   required_days([ov('volume.rel_volume')], '1m', BASE) > _reach_days('1m'))

print('\n── the ones deliberately left on the floor ────────────────────────')

# ITS ANCHOR IS A PARAMETER. `anchor=` can name any date at all, so there is no
# reach to derive and the floor is the only safe answer.
ok('vwap.anchored keeps the floor',
   required_days([ov('vwap.anchored')], '1m', BASE) >= _HISTORY_FLOOR_DAYS)
# A SWING OR PIVOT sits an unbounded distance back; the floor is what bounds it.
ok('structure.pivot_high keeps the floor',
   required_days([ov('structure.pivot_high')], '1m', BASE) >= _HISTORY_FLOOR_DAYS)
ok('vwap.swing_hh keeps the floor',
   required_days([ov('vwap.swing_hh')], '1m', BASE) >= _HISTORY_FLOOR_DAYS)

print('\n── the mid-reach anchors reach the right distance ─────────────────')

# A WEEKEND, AND A HOLIDAY ON EITHER SIDE OF IT. Friday's close is read on
# Tuesday morning after a long weekend, which is four calendar days back.
ok('prev_day_close reaches past a long weekend',
   required_days([ov('levels.prev_day_close')], '1m', BASE) >= 4 + BASE)
ok('prev_day_close does not reach a month',
   required_days([ov('levels.prev_day_close')], '1m', BASE) < _HISTORY_FLOOR_DAYS)

# ON A MONDAY "this week" is one bar old, and last week is all there is behind
# it — so a weekly anchor needs more than seven days to exist at 09:31.
ok('a weekly anchor reaches past one week',
   required_days([ov('vwap.weekly')], '1m', BASE) > 7)
ok('a weekly anchor does not reach a month',
   required_days([ov('vwap.weekly')], '1m', BASE) < _HISTORY_FLOOR_DAYS)

print('\n── the table itself ───────────────────────────────────────────────')

# EVERY KEY MUST BE REAL. A typo here is silent: the key simply never matches,
# the floor applies, and the fix quietly does nothing for that primitive.
try:
    from qp.registry import REGISTRY
    unknown = sorted(k for k in _SESSION_SCOPE_DAYS if k not in REGISTRY)
    ok('every key in the table exists in the registry', not unknown, f'unknown: {unknown}')
    wrong_group = sorted(k for k in _SESSION_SCOPE_DAYS
                         if REGISTRY[k].group not in _HISTORY_GROUPS)
    # A KEY OUTSIDE THE HISTORY GROUPS NEVER REACHES THE BRANCH. It would sit in
    # the table looking like it did something.
    ok('and every one of them is in a group the floor applies to',
       not wrong_group, f'outside: {wrong_group}')
except ImportError:                                   # registry unavailable here
    ok('registry not importable — key check skipped', True)

# NOTHING IN BOTH TABLES. _WARMUP_DAYS raises the floor and _SESSION_SCOPE_DAYS
# lowers it; a key in both is two answers to one question.
ok('no key is in both the raise table and the lower table',
   not (set(_SESSION_SCOPE_DAYS) & set(_WARMUP_DAYS)),
   f'{sorted(set(_SESSION_SCOPE_DAYS) & set(_WARMUP_DAYS))}')

# LOWER, NEVER HIGHER. The table's whole contract is that it can only shorten a
# fetch — so an entry above the floor would be a silent widening.
ok('every entry is below the floor it replaces',
   all(v < _HISTORY_FLOOR_DAYS for v in _SESSION_SCOPE_DAYS.values()))

print('\n── and a strategy with no overlays is unchanged ───────────────────')
ok('an empty overlay list still returns the base', required_days([], '1m', BASE) == BASE)
#
# A KEY THE REGISTRY DOES NOT KNOW still gets the one-bar floor every non-empty
# overlay list gets — "even a single-bar primitive needs the bar before the
# window starts". Unchanged by this, and asserted so a future edit cannot
# quietly turn an unknown key into a forty-day fetch.
ok('an unknown key gets the intraday floor and no more',
   required_days([ov('nope.nothing')], '1m', BASE) == BASE + _PREV_SESSION_DAYS)
# AND ON A DAILY CHART there is no open to warm up from, so the floor does not
# apply and one day is still one day.
ok('on 1d an unknown key still gets a single day',
   required_days([ov('nope.nothing')], '1d', BASE) == BASE + 1)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
