"""cost_bps was subtracted from the percentage and from nothing else.

Backtest #358, 2026-09-15, run with cost_bps = 50:

    FTAI   gross_usd 777.98   fees_usd 0.00   net_usd 777.98

Byte-identical to the same run at cost_bps 0 — while `return_pct` moved by
exactly 1.5%. The knob appeared to work: it was stored in the spec, it changed
a number on screen, and it left the headline the trader reads untouched. Every
account-sized run ever made reported its P&L with NO transaction cost, whatever
the box said.

`cost` was applied in one place, to `ret`, the percentage basis. The account
block — which turns a return into shares and dollars — never read the spec key
at all.

AND THE MODEL WAS WRONG WHERE IT DID APPLY. `(2.0 + nlegs) * cost` charged the
spread on the WHOLE position for every partial exit, so a two-leg scale-out
paid four times over on a position it trades twice. Every share pays the cost
once going in and once coming out, however many pieces the exit is cut into.

WHAT THE RIGHT NUMBER IS, measured rather than guessed. 2026-09-15, FTAI, 345
shares, decided at 175.30:

    backtest gross                 +$777.98
    live, same 345 shares          +$373.67

At 33 bps a side this file's model returns $378.82 — within five dollars of
what the account actually made. 50 bps was an overestimate taken from the entry
slip alone; the exits barely slip at all.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from chart.backtest import _account_block                           # noqa: E402

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


# The real trade, as the run recorded it: a half at T1, the rest on the runner.
FTAI = {'symbol': 'FTAI', 'side': 'short', 'entry': 175.30, 'exit': 173.39,
        'stop': 176.60, 'pnl_per_share': 2.255,
        'legs': [{'fraction': 0.5, 'price': 172.70}],
        'date': '2026-09-15', 'entry_ts': 1_757_000_000, 'exit_ts': 1_757_003_600}


class Ctx(dict):
    """The trade's ctx, answering 0.0 for the fields this change introduces.

    READ SOFTLY so the BEHAVIOUR is what fails on a file without them, not the
    lookup. A KeyError proves a name is absent; the point here is that a costed
    run must not equal a free one.
    """

    def __missing__(self, key):
        return 0.0 if key.startswith('acct_slip') else None


def run(bps, trade=None, **spec):
    base = {'account_equity': 100_000, 'risk_usd': 500, 'max_leverage': 1,
            'size_ratio': 0.9, 'cost_bps': bps}
    base.update(spec)
    rows = [dict(trade or FTAI)]
    summary = _account_block(rows, base)
    return summary, Ctx(rows[0].get('ctx') or {})


print('\n── the dollars pay the cost ───────────────────────────────────────')

_, free = run(0)
_, paid = run(50)
# THE ASSERTION THE OLD FILE FAILED. Both of these were 777.98.
ok('a costed run does not equal a free one',
   paid['acct_pnl_usd'] != free['acct_pnl_usd'],
   f"{paid['acct_pnl_usd']} vs {free['acct_pnl_usd']}")
ok('and it is SMALLER — a cost cannot pay you',
   paid['acct_pnl_usd'] < free['acct_pnl_usd'])
ok('at zero it costs exactly nothing', free['acct_slip_usd'] == 0.0)

print('\n── every share twice, not every leg at full size ──────────────────')

# 345 shares x 175.30 x 2 sides x 0.005 = 604.79
ok('the charge is the position notional, twice, at the rate',
   abs(paid['acct_slip_usd'] - 345 * 175.30 * 2 * 0.0050) < 0.02,
   str(paid['acct_slip_usd']))

# THE BUG IN THE OLD MODEL. (2 + nlegs) made this trade pay three sides, and a
# two-leg scale-out four. Cutting the exit into more pieces must not cost more.
one_leg = dict(FTAI)
two_leg = dict(FTAI, legs=[{'fraction': 0.25, 'price': 173.5},
                           {'fraction': 0.25, 'price': 172.7}])
_, a = run(50, one_leg)
_, b = run(50, two_leg)
ok('cutting the exit into more pieces costs the same',
   abs(a['acct_slip_usd'] - b['acct_slip_usd']) < 0.02,
   f"{a['acct_slip_usd']} vs {b['acct_slip_usd']}")

print('\n── it is reported, and not folded into the commission ─────────────')

s, c = run(50)
ok('the trade carries its own slippage line', c['acct_slip_usd'] > 0)
ok('separate from fees, which are zero on a commission-free account',
   c['acct_fees_usd'] == 0.0)
ok('the run totals it',
   abs((s.get('slippage_usd') or 0) - c['acct_slip_usd']) < 0.02,
   str(s.get('slippage_usd')))
# STATED EVEN AT ZERO, so "this run charged no slippage" is a statement rather
# than a missing field — the state backtest #358 was in.
ok('and the rate is reported, even when it is zero',
   run(0)[0].get('cost_bps_per_side') == 0.0)
ok('and when it is not', s.get('cost_bps_per_side') == 50.0)

print('\n── the cost scales with the rate, linearly ────────────────────────')

_, c25 = run(25)
_, c50 = run(50)
ok('twice the rate is twice the cost',
   abs(c50['acct_slip_usd'] - 2 * c25['acct_slip_usd']) < 0.02)
ok('and the gross is untouched by it',
   abs((c50['acct_pnl_usd'] + c50['acct_slip_usd'])
       - (c25['acct_pnl_usd'] + c25['acct_slip_usd'])) < 0.02)

print('\n── against what the account actually made ─────────────────────────')

# 2026-09-15: the desk shorted FTAI at 174.21 against a decision of 175.30 and
# made $373.67 on the same 345 shares. This is the whole point of the setting —
# a rate that reproduces the fill the account really got.
_, real = run(33)
ok('33 bps a side lands within $10 of the live result',
   abs(real['acct_pnl_usd'] - 373.67) < 10.0,
   f"{real['acct_pnl_usd']} vs live 373.67")
ok('and 50 bps overshoots it', run(50)[1]['acct_pnl_usd'] < 373.67 - 50)
ok('while 0 bps is nowhere near', free['acct_pnl_usd'] > 373.67 + 300)

print('\n── nonsense is not a cost ─────────────────────────────────────────')

ok('a negative rate charges nothing rather than paying you',
   run(-10)[1]['acct_slip_usd'] == 0.0)
ok('a rate that is not a number charges nothing',
   run('x')[1]['acct_slip_usd'] == 0.0)
ok('and the shares are unchanged by any of it',
   run(0)[1]['acct_shares'] == run(50)[1]['acct_shares'],
   'cost must not move position size — it is charged after sizing')

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
