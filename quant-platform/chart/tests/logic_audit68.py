"""The short book is only real if the broker will lend the name.

Backtest #354, 2026-09-08 to 09-14, twelve trades:

    net profit                   +$1,345.43
    XE, short, its largest win   +$1,408.60
    without XE                      -$63.17

Live, the same signal came back

    alpaca1: FAILED — asset "XE" cannot be sold short

so the entire profit of that run was one trade the broker refuses to place.
STKH and LBGJ went the same way on 2026-08-14, and CAPR before them. Most of
what these screeners find is a small cap with no borrow, so for a short book
this is the common case rather than the edge one.

REFUSED WHERE LIVE REFUSES IT — after the ranking, not before. XE was ranked
second of three and the refusal came at order time, so it SPENT a top-3 slot
and produced no position. Filtering it out earlier would hand that slot to a
fourth name the desk never saw, which is a different strategy with a better
result and no relationship to the session it claims to describe.

TODAY'S FLAG ON A PAST DAY. Alpaca reports borrow as it stands now and keeps no
history, so nothing here can know what XE was on the 9th. It is a good
approximation of a standing fact and still an approximation, and the run says
so rather than presenting it as measurement.

AN UNANSWERABLE CHECK IS NOT A REFUSAL. If the broker cannot be reached the
trade stands and the name is listed as unchecked. Dropping trades because a
lookup timed out would turn a network blip into a strategy result — a worse lie
than the one this fixes. The live desk makes the same choice: checkShortable
warns and sends.
"""
import pathlib
import sys
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from chart.backtest import _account_block                            # noqa: E402
from tools.data import borrow                                        # noqa: E402

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


def trades():
    """XE and QCOM as backtest #354 had them on 2026-09-09."""
    return [
        {'date': '2026-09-09', 'symbol': 'XE', 'side': 'short', 'entry': 18.265,
         'exit': 17.179, 'stop': 18.565, 'ret': 0.046, 'reason': 'eod',
         'entry_ts': 1, 'exit_ts': 2, 'ctx': {}},
        {'date': '2026-09-09', 'symbol': 'QCOM', 'side': 'long', 'entry': 179.76,
         'exit': 177.17, 'stop': 177.17, 'ret': -0.014, 'reason': 'SL',
         'entry_ts': 3, 'exit_ts': 4, 'ctx': {}},
    ]


BASE = {'account_equity': 100000, 'risk_pct': 0.5,
        'fee_per_share': '', 'fee_min': '', 'min_profit_ps': None}


def run(spec, answer):
    with patch('chart.backtest._borrow.shortable', side_effect=lambda s, **k: answer(s)):
        t = trades()
        return t, _account_block(t, spec)


NO_XE = (lambda s: {'shortable': False,
                    'reason': 'XE cannot be sold short at this broker'}
         if s == 'XE' else {'shortable': True, 'easy': True})
UNASKABLE = lambda s: {'shortable': None, 'reason': 'could not ask the broker'}   # noqa: E731

# ── off changes nothing ──────────────────────────────────────────────────────
#
# An existing run must not quietly become a different run. The check is a
# control the trader turns on, not a default that rewrites old results.
t, b = run(BASE, NO_XE)
ok('with the check off, nothing is refused', b['refused_no_borrow'] == 0)
ok('...and no note is added to the trade', t[0]['ctx'].get('acct_note') is None)
# `borrow_checked` SPLIT INTO TWO FIELDS (logic_audit71). It reported the spec
# flag, so it said True for a run answered about every name and for a run
# answered about none — which is what backtest #355 did above a trade the
# broker refuses. `borrow_asked` is the setting; `borrow_answered` is the count
# that actually got a yes or a no.
ok('...and the summary says the check was never asked for',
   b['borrow_asked'] is False, str(b.get('borrow_asked')))
ok('...and nothing was answered about', b['borrow_answered'] == 0,
   str(b.get('borrow_answered')))

# ── on, and the broker says no ───────────────────────────────────────────────
t, b = run(dict(BASE, check_shortable=True), NO_XE)
ok('a short the broker will not lend is refused', b['refused_no_borrow'] == 1,
   str(b['refused_no_borrow']))
ok('...and it is NAMED, not just counted',
   b['refused_no_borrow_names'] == ['XE'], str(b['refused_no_borrow_names']))
ok('...with the broker\'s own reason on the row',
   'cannot be sold short' in (t[0]['ctx'].get('acct_note') or ''),
   str(t[0]['ctx'].get('acct_note')))
#
# AND THE REST OF THE BOOK IS UNTOUCHED. A borrow check that quietly dropped
# longs would be a far worse bug than the one it replaces.
ok('the long beside it is still sized', 'acct_note' not in t[1]['ctx'],
   str(t[1]['ctx'].get('acct_note')))
# ASKED *AND* ANSWERED — the two the old single field could not separate.
ok('the run reports the check was asked for', b['borrow_asked'] is True)
ok('and that the broker actually answered about it',
   b['borrow_answered'] >= 1, str(b.get('borrow_answered')))

# ── on, and the broker cannot be asked ───────────────────────────────────────
t, b = run(dict(BASE, check_shortable=True), UNASKABLE)
ok('an unanswerable check refuses nothing', b['refused_no_borrow'] == 0,
   str(b['refused_no_borrow']))
ok('...the trade stands', t[0]['ctx'].get('acct_note') is None)
ok('...and the name is listed as unchecked',
   b['borrow_unchecked_names'] == ['XE'], str(b['borrow_unchecked_names']))
#
# None AND False ARE OPPOSITE INSTRUCTIONS, and the day they are collapsed a
# timed-out lookup starts deleting trades.
ok('so "not asked" is never counted as "refused"',
   b['refused_no_borrow_names'] is None, str(b['refused_no_borrow_names']))

# ── the lookup itself ────────────────────────────────────────────────────────
borrow.forget()
with patch.dict('os.environ', {}, clear=False):
    import os
    for k in ('APCA_API_KEY_ID', 'APCA_API_SECRET_KEY'):
        os.environ.pop(k, None)
    r = borrow.shortable('XE')
ok('with no credentials the answer is None, not False',
   r['shortable'] is None, str(r))
ok('...and it says why', 'credentials' in (r.get('reason') or ''), str(r.get('reason')))

borrow.forget()
calls = {'n': 0}


def counted(sym, timeout):
    calls['n'] += 1
    return {'shortable': False, 'reason': 'nope'}


with patch('tools.data.borrow._fetch', side_effect=counted):
    borrow.shortable('XE')
    borrow.shortable('XE')
    borrow.shortable('xe')
ok('a symbol is asked once per process, however often it comes up',
   calls['n'] == 1, str(calls['n']))
ok('...case-insensitively', borrow.shortable('Xe')['shortable'] is False)

# ── the page offers it ───────────────────────────────────────────────────────
page = (pathlib.Path(__file__).resolve().parents[1] / 'static' / 'index.html').read_text()
ok('the backtest page has the control', 'id="btShortable"' in page)
ok('...on by default', 'id="btShortable" checked' in page)
ok('...and it posts check_shortable', 'check_shortable:document.getElementById' in page)
ok('...and the page says it is today\'s flag on a past day',
   "today's borrow flag applied to a past day" in page)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
