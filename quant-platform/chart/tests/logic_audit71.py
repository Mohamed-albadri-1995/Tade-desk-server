"""A borrow check that was asked for and did not happen must not read as a pass.

Backtest #355, 2026-09-15, with `check_shortable` ticked:

    size_ratio               = 0.9
    refused_no_borrow        = 0
    borrow_checked           = True          <-- says the check ran
    borrow_unchecked_names   = ['BLSH', 'FTAI', 'MMED']

Every one of its three shorts unchecked, and the field above them reporting
True. It kept MMED for -$449.71 — a name Alpaca, asked directly the same
morning, calls `shortable: False`:

    MMED {'shortable': False, 'easy': False,
          'reason': 'MMED cannot be sold short at this broker'}

Live could not place it at all, which is what a borrow refusal looks like from
the other side. And because the sim spent $37,266 of buying power on it, BLSH
was sized at 62 shares where live got 1096 — one unchecked name moving the size
of a completely different trade.

TWO FAULTS, AND THEY ARE THE SAME FAULT TWICE.

  `borrow_checked` was the SPEC FLAG, not the outcome. It answered True for a
  run that checked everything and for a run that checked nothing. A field that
  says the same thing whatever happened — in the code written to stop exactly
  that. It is now two fields: borrow_asked (the setting) and borrow_answered
  (how many names got a yes or a no).

  AND THE RUN SAID NOTHING. Ticking the box and getting no answer produces a
  result identical to one where every name came back borrowable: the same
  trades, the same P&L, the same confident numbers, and no warning anywhere.
  A silence read as a pass.

It does NOT refuse the run. A backtest that cannot reach the broker is still
worth reading, and refusing would make the tool unusable offline. But it must
be impossible to read the result as "borrow was checked".
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.backtest as B                                          # noqa: E402
from chart.report import compute                                    # noqa: E402

PASS = 0
FAIL = 0


def field(summary, name, missing=None):
    """A summary field, or `missing` when the file under test has no such key.

    READ SOFTLY so the BEHAVIOUR is what fails on a file without these fields,
    not the lookup. A test that dies with KeyError proves a name is absent; the
    point here is that a run answered about nothing must not read like one
    answered about everything.
    """
    return (summary or {}).get(name, missing)


def ok(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {label}')
    else:
        FAIL += 1
        print(f'  FAIL {label} {detail}')


def trade(symbol, entry, stop, pps, side='short'):
    return {'symbol': symbol, 'side': side, 'entry': entry, 'stop': stop,
            'pnl_per_share': pps, 'date': '2026-09-15',
            'entry_ts': 1_757_000_000, 'exit_ts': 1_757_003_600}


class Broker:
    """Stands in for tools.data.borrow, answering whatever the case needs."""

    def __init__(self, answers):
        self.answers = answers
        self.asked = []

    def shortable(self, sym, timeout=6.0):
        self.asked.append(sym)
        return self.answers.get(sym, {'shortable': None, 'reason': 'no answer'})


def run(trades, answers, **spec):
    real = B._borrow
    B._borrow = Broker(answers)
    try:
        base = {'account_equity': 100_000, 'risk_usd': 500, 'max_leverage': 1,
                'check_shortable': True, 'size_ratio': 0.9}
        base.update(spec)
        rows = [dict(t) for t in trades]
        summary = _account_block(rows, base)
        return {'summary': summary, 'all': rows, 'spec': base}
    finally:
        B._borrow = real


_account_block = B._account_block

# The real morning. MMED is the one Alpaca refuses.
MMED = trade('MMED', 21.96, 22.225, -0.265)
FTAI = trade('FTAI', 175.30, 176.60, 2.26)
BLSH = trade('BLSH', 36.02, 36.275, 0.32)

NO_ANSWER = {}
ANSWERS = {'MMED': {'shortable': False, 'reason': 'MMED cannot be sold short'},
           'FTAI': {'shortable': True}, 'BLSH': {'shortable': True}}

print('\n── asked, and answered ────────────────────────────────────────────')

good = run([MMED, FTAI, BLSH], ANSWERS)
gs = good['summary']
ok('MMED is refused when the broker says no',
   field(gs, 'refused_no_borrow') == 1 and gs['refused_no_borrow_names'] == ['MMED'],
   str(field(gs, 'refused_no_borrow_names')))
ok('and it is not sized at all',
   (good['all'][0].get('ctx') or {}).get('acct_shares') is None)
ok('all three were answered about', field(gs, 'borrow_answered') == 3,
   str(field(gs, 'borrow_answered')))
ok('so nothing is listed as unchecked', not field(gs, 'borrow_unchecked_names'))
ok('and the run says the check was asked for', field(gs, 'borrow_asked') is True)

# THE CASCADE, which is the whole reason MMED matters beyond MMED. Refusing it
# leaves its $37k of buying power for the names behind it.
sh = {t['symbol']: (t.get('ctx') or {}).get('acct_shares') for t in good['all']}
ok('the capital MMED did not spend is left for BLSH',
   (sh.get('BLSH') or 0) > 900, str(sh))

print('\n── asked, and NOT answered ────────────────────────────────────────')

blind = run([MMED, FTAI, BLSH], NO_ANSWER)
bs = blind['summary']
ok('every name is named as unchecked',
   field(bs, 'borrow_unchecked_names') == ['BLSH', 'FTAI', 'MMED'],
   str(field(bs, 'borrow_unchecked_names')))
# THE ONE THAT WAS WRONG. It reported True for this run.
ok('borrow_answered is 0, not True', field(bs, 'borrow_answered') == 0,
   str(field(bs, 'borrow_answered')))
ok('borrow_asked is still True — the setting was on', field(bs, 'borrow_asked') is True)
ok('and nothing was refused, because nothing was known',
   field(bs, 'refused_no_borrow') == 0)

# AND THE TRADES STAND. Refusing every short because the broker did not answer
# would be a worse failure than the one this prevents.
ok('MMED is still taken, since no refusal was ever received',
   (blind['all'][0].get('ctx') or {}).get('acct_shares') is not None)

print('\n── the two runs must not look alike ───────────────────────────────')

# THIS IS THE WHOLE POINT. Under the old field both of these said True.
ok('the answered run and the blind run disagree about borrow_answered',
   field(gs, 'borrow_answered') != field(bs, 'borrow_answered'))
ok('and a reader can tell them apart from the summary alone',
   (field(gs, 'borrow_unchecked_names'), field(gs, 'borrow_answered'))
   != (field(bs, 'borrow_unchecked_names'), field(bs, 'borrow_answered')))

print('\n── and the run SAYS so, where the other warnings are ──────────────')


def warnings_of(res):
    st = compute(res['all'], {'account': res['summary']}, res['spec'])
    return [w[0] for w in (st.get('warnings') or [])]


blind_w = warnings_of(blind)
ok('a run answered about nothing carries a borrow warning',
   any('borrow was NOT checked' in w for w in blind_w), str(blind_w))
ok('a fully answered run carries none',
   not any('borrow' in w for w in warnings_of(good)), str(warnings_of(good)))

# PARTIAL IS ITS OWN CASE. Two of three answered is not "checked" and is not
# "not checked", and rounding it to either loses the names that were missed.
part = run([MMED, FTAI, BLSH], {'FTAI': {'shortable': True}})
part_w = warnings_of(part)
ok('a partly answered run says how many were missed',
   any('borrow unchecked on 2 of 3' in w for w in part_w), str(part_w))
ok('and names them', field(part['summary'], 'borrow_unchecked_names') == ['BLSH', 'MMED'],
   str(field(part['summary'], 'borrow_unchecked_names')))

print('\n── the check is not run when it was not asked for ─────────────────')

off = run([MMED, FTAI, BLSH], ANSWERS, check_shortable=False)
ok('no name is refused', field(off['summary'], 'refused_no_borrow') == 0)
ok('borrow_asked is False', field(off['summary'], 'borrow_asked') is False)
ok('nothing is listed as unchecked either — it was never asked',
   not field(off['summary'], 'borrow_unchecked_names'))
ok('and no warning is raised about a check nobody wanted',
   not any('borrow' in w for w in warnings_of(off)), str(warnings_of(off)))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
