"""Audit part 43 — flat-dollar risk, and what the per-trade cap really does.

WHY THIS EXISTS.

The live desk risks a FLAT $500 a trade (`riskPerTrade` in data/risk.json). The
backtest could only risk a PERCENTAGE of equity, which compounds — over the
user's own fortnight 0.5% grew the budget from 499.95 to 552.40. Those are not
two settings of one dial, they are two different position-sizing strategies,
and the backtest could not express the one the account actually runs. So the
question "which execution is better" could not even be asked.

It is asked by measuring, not by arguing, which means both models have to be
runnable side by side. That is the whole of this change.

PART A — flat dollars size from the dollars, and NOT from equity.
PART B — a percentage still compounds, exactly as before.
PART C — the two are mutually exclusive, and saying so beats picking one.
PART D — the account block names the model it ran.
PART E — the per-trade cap: what it costs, and what it buys.
"""
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart.backtest import _account_block  # noqa: E402

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


def trade(sym, entry, stop, exit_px, side='long', ts=0, date='2026-08-19'):
    """One closed winner or loser, priced so the arithmetic is checkable by hand."""
    sgn = 1.0 if side == 'long' else -1.0
    return {'date': date, 'symbol': sym, 'side': side,
            'entry_ts': ts, 'exit_ts': ts + 60,
            'entry': entry, 'exit': exit_px, 'stop': stop,
            'ret': sgn * (exit_px - entry) / entry, 'reason': 'TP',
            'ctx': {}, 'legs': []}


print('== A. flat dollars size from the DOLLARS ==')
# $500 at risk, $1.00 of stop distance -> 500 shares. Every time, whatever the
# account has done since. Two trades, both winners, so equity moves between
# them and a compounding model WOULD size the second one bigger.
rows = [trade('AAA', 10.0, 9.0, 12.0, ts=100),
        trade('BBB', 20.0, 19.0, 22.0, ts=1000)]
a = _account_block(rows, {'account_equity': 100000, 'risk_usd': 500})
sizes = [t['ctx']['acct_shares'] for t in rows]
ok('first trade: $500 / $1.00 stop = 500 shares', sizes[0] == 500, sizes[0])
ok('second trade sized IDENTICALLY despite the win in between',
   sizes[1] == 500, sizes)
ok('P&L is the two $2.00 moves on 500 shares = $2,000',
   abs(a['net_pnl_usd'] - 2000.0) < 1e-6, a['net_pnl_usd'])
ok('risk per trade is a flat $500 on both',
   [t['ctx']['acct_risk_usd'] for t in rows] == [500.0, 500.0],
   [t['ctx']['acct_risk_usd'] for t in rows])


print()
print('== B. a percentage still compounds — unchanged ==')
rows = [trade('AAA', 10.0, 9.0, 12.0, ts=100),
        trade('BBB', 20.0, 19.0, 22.0, ts=1000)]
a = _account_block(rows, {'account_equity': 100000, 'risk_pct': 0.5})
sizes = [t['ctx']['acct_shares'] for t in rows]
ok('first trade: 0.5% of 100,000 = $500 / $1.00 = 500 shares',
   sizes[0] == 500, sizes[0])
# The first trade banked 500 x $2.00 = $1,000, so equity is 101,000 and the
# budget is 505 -> 505 shares. THIS is the difference the desk does not have.
ok('second trade sizes UP on the banked win: 0.5% of 101,000 = 505 shares',
   sizes[1] == 505, sizes)
ok('so the compounding book earns more here',
   a['net_pnl_usd'] > 2000.0, a['net_pnl_usd'])
ok('and the difference is exactly the extra 5 shares x $2.00',
   abs(a['net_pnl_usd'] - 2010.0) < 1e-6, a['net_pnl_usd'])


print()
print('== C. the two models are mutually exclusive ==')
# Preferring one silently would produce a book neither setting describes, and
# the report would name the wrong one. Refusing is the only honest option.
try:
    _account_block([trade('AAA', 10.0, 9.0, 12.0)],
                   {'account_equity': 100000, 'risk_pct': 0.5, 'risk_usd': 500})
    ok('both at once is refused', False, 'no error raised')
except ValueError as e:
    ok('both at once is refused', True)
    ok('and the message says WHY they cannot be combined',
       'compounds' in str(e), str(e)[:90])
ok('neither one = the block stays off (opt-in, as before)',
   _account_block([trade('AAA', 10.0, 9.0, 12.0)], {'account_equity': 100000}) is None)
ok('no account size = off, even with a risk model',
   _account_block([trade('AAA', 10.0, 9.0, 12.0)], {'risk_usd': 500}) is None)


print()
print('== D. the block names the model it ran ==')
# A report that printed "risking 0% per trade" over a flat-dollar book would
# read as broken, and the reader would go looking for a bug that is not there.
a = _account_block([trade('AAA', 10.0, 9.0, 12.0)],
                   {'account_equity': 100000, 'risk_usd': 500})
ok("flat run reports risk_model 'fixed_usd'", a['risk_model'] == 'fixed_usd', a['risk_model'])
ok('and carries the dollar figure', a['risk_usd'] == 500.0, a['risk_usd'])
a = _account_block([trade('AAA', 10.0, 9.0, 12.0)],
                   {'account_equity': 100000, 'risk_pct': 0.5})
ok("percentage run reports 'pct_of_equity'", a['risk_model'] == 'pct_of_equity', a['risk_model'])
ok('and risk_usd is None rather than 0 — absent, not zero',
   a['risk_usd'] is None, a['risk_usd'])


print()
print('== E. the per-trade cap: what it costs and what it buys ==')
# THE QUESTION THE USER ASKED: "if max 16% is giving bad results why do we need
# it?" This is the answer in arithmetic.
#
# Three signals in one day on a $100k cash account, ALL STILL OPEN when the
# next one fires — which is the normal case for a register backtest and the
# only case in which the shared balance can bind.
#
# AAA has a very tight stop ($0.05), so risk-based sizing wants
# $500 / $0.05 = 10,000 shares at $20 = $200,000 of stock. The account has
# $100,000. BBB and CCC have ordinary stops and want $5,000 each.
def day_rows():
    return [trade('AAA', 20.0, 19.95, 20.60, ts=100),   # tight stop, +3%
            trade('BBB', 50.0, 45.00, 51.00, ts=200),   # +2%
            trade('CCC', 40.0, 36.00, 41.00, ts=300)]   # +2.5%


u_rows = day_rows()
c_rows = day_rows()
for _t in u_rows + c_rows:
    _t['exit_ts'] = 99999                 # nothing closes before the last entry
uncapped = _account_block(u_rows, {'account_equity': 100000, 'risk_usd': 500})
capped = _account_block(c_rows, {'account_equity': 100000, 'risk_usd': 500,
                                 'max_position_pct': 16.66})

# UNCAPPED: AAA is cut down only by the portfolio cash cap, to 5,000 shares
# ($100k), and the balance is then fully committed. BBB and CCC are skipped —
# not because they were worse, but because they arrived second and third.
ok('uncapped: the tight stop swallows the balance',
   uncapped['size_capped_by_leverage'] == 1, uncapped['size_capped_by_leverage'])
ok('uncapped: the other two are SKIPPED for lack of capital',
   uncapped['skipped_no_capital'] == 2, uncapped['skipped_no_capital'])
ok('uncapped: only one trade actually happened',
   uncapped['trades_sized'] == 1, uncapped['trades_sized'])

# CAPPED at 16.66%: AAA may hold $16,660 = 833 shares. That leaves the balance
# for the rest of the day, and all three ranked signals are taken.
ok('capped: the tight stop is cut to 16.66% of equity',
   capped['size_capped_by_position'] == 1, capped['size_capped_by_position'])
ok('capped: NOTHING is skipped for lack of capital',
   capped['skipped_no_capital'] == 0, capped['skipped_no_capital'])
ok('capped: all three trades happen',
   capped['trades_sized'] == 3, capped['trades_sized'])
_aaa = math.floor(100000 * 16.66 / 100.0 / 20.0)          # 833
ok(f'capped: AAA holds {_aaa} shares = 16.66% of 100,000 at $20',
   c_rows[0]['ctx']['acct_shares'] == _aaa, c_rows[0]['ctx']['acct_shares'])
ok('capped: BBB and CCC are NOT capped — their stops are ordinary',
   [c_rows[1]['ctx']['acct_shares'], c_rows[2]['ctx']['acct_shares']] == [100, 125],
   [c_rows[1]['ctx'].get('acct_shares'), c_rows[2]['ctx'].get('acct_shares')])
# UNCAPPED, the same AAA: cut only by the portfolio cash cap, to the whole
# $100,000 balance. That is the position that eats the day.
ok('uncapped: AAA holds 5,000 shares — the entire account, in one name',
   u_rows[0]['ctx']['acct_shares'] == 5000, u_rows[0]['ctx'].get('acct_shares'))

# THE POINT, stated as a test. On this day the uncapped book made MORE money
# from one lucky position, and it is still the worse setting: it is one trade
# of sample, chosen by clock, with two ranked signals thrown away.
ok('uncapped made more dollars here',
   uncapped['net_pnl_usd'] > capped['net_pnl_usd'],
   (uncapped['net_pnl_usd'], capped['net_pnl_usd']))
ok('...on one third of the trades',
   uncapped['trades_sized'] * 3 == capped['trades_sized'],
   (uncapped['trades_sized'], capped['trades_sized']))
ok('...which is why skipped_no_capital is reported beside every P&L',
   'skipped_no_capital' in uncapped and 'trades_sized' in uncapped)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
