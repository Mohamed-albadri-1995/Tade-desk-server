"""Every headline number, against arithmetic done by hand.

"I think the win rate calculation is wrong. You need to check it piece by
piece — over time with edits I think something refers to the wrong place or
calculates the wrong way."

So: a fixed set of trades whose every statistic can be worked out on paper, run
through the real `_summary`, and compared. No fixture is shared between parts,
because a shared one hides the bug where two metrics read the same wrong list.

PART A — counting. How many trades, how many won, and over WHICH set.
PART B — the percentage block: average, total, drawdown.
PART C — the account block: shares, fees, net, win rate, return.
PART D — Sharpe and the daily series.
PART E — the two win rates are DIFFERENT questions, and must not be mixed.
PART F — scale-out P&L: several fills, several commissions.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import chart.backtest as bt                                  # noqa: E402

PASS = 0
FAIL = 0


def ok(name, got, exp, tol=None):
    global PASS, FAIL
    good = (abs(got - exp) <= tol) if (tol is not None and got is not None
                                       and isinstance(got, (int, float))) else got == exp
    if good:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: got={got!r} expected={exp!r}")


DAY = '2024-01-09'
TS = 1704808800          # 2024-01-09 14:00 UTC


def trade(ret, *, entry=100.0, stop=99.0, side='long', n=0, date=DAY,
          symbol='AAA', legs=None, exit_px=None):
    """One closed trade. `ret` is the fractional return the engine produced."""
    return {'date': date, 'symbol': symbol, 'side': side,
            'entry_ts': TS + n * 600, 'exit_ts': TS + n * 600 + 300,
            'entry': entry, 'exit': exit_px if exit_px is not None else entry * (1 + ret),
            'stop': stop, 'ret': ret, 'reason': 'TP' if ret > 0 else 'SL',
            'ctx': {}, 'legs': legs or []}


# ── PART A · counting ───────────────────────────────────────────────────────
print("PART A — what is counted, and over which set")

# Five closed: +2%, +1%, -1%, 0%, +3%.  Three are > 0.  ZERO IS NOT A WIN.
RETS = [0.02, 0.01, -0.01, 0.0, 0.03]
CLOSED = [trade(r, n=i) for i, r in enumerate(RETS)]
OPENS = [{'date': DAY, 'symbol': 'ZZZ', 'side': 'long', 'entry_ts': TS,
          'exit_ts': None, 'entry': 100.0, 'exit': None, 'stop': 99.0,
          'ret': 0.05, 'reason': 'open', 'ctx': {}, 'legs': []}]

s = bt._summary(CLOSED, OPENS, n_pairs=20, errors=[], all_dates=[DAY])
ok('trades counts CLOSED trades only', s['trades'], 5)
ok('the open one is counted separately, not silently', s['open_trades'], 1)
ok('wins are strictly greater than zero — a flat trade is not a win',
   s['wins'], 3)
ok('win rate = 3 of 5 = 60.0%', s['win_rate'], 60.0)

# The open trade is up 5%. If it leaked into the win rate it would read 4/6.
ok('an OPEN winner does not inflate the win rate', s['win_rate'], 60.0)

s_noopen = bt._summary(CLOSED, [], n_pairs=20, errors=[], all_dates=[DAY])
ok('...and removing it changes nothing but the open count',
   (s_noopen['win_rate'], s_noopen['trades']), (60.0, 5))

# A losing day and a winning day must not be conflated by `reason`.
ok('exits are counted by reason', s['exits_by'], {'TP': 3, 'SL': 2})


# ── PART B · the percentage block ───────────────────────────────────────────
print("PART B — average, total and drawdown, on paper")

# sum = 0.02+0.01-0.01+0.00+0.03 = 0.05
ok('total = the returns added up = 5.0%', s['total_return_pct'], 5.0, tol=1e-9)
ok('average = 0.05 / 5 = 1.0%', s['avg_return_pct'], 1.0, tol=1e-9)

# Drawdown walks the cumulative sum IN EXIT ORDER:
#   0.02, 0.03, 0.02, 0.02, 0.05   peak 0.03 -> trough 0.02  = 0.01
ok('drawdown is the worst peak-to-trough of the cumulative sum = 1.0',
   s['max_drawdown_pct'], 1.0, tol=1e-9)

# Exit ORDER, not input order: a list handed over shuffled must give the same
# curve, because the curve is a property of when trades closed.
shuffled = [CLOSED[4], CLOSED[0], CLOSED[3], CLOSED[2], CLOSED[1]]
s_sh = bt._summary(shuffled, [], n_pairs=20, errors=[], all_dates=[DAY])
ok('the equity curve is built in EXIT order, however the trades arrive',
   (s_sh['max_drawdown_pct'], [p['value'] for p in s_sh['equity_curve']]),
   (s['max_drawdown_pct'], [p['value'] for p in s['equity_curve']]))

# THE UNITS. `total_return_pct` and `max_drawdown_pct` here are sums of
# percentage MOVES of trades that were never the same size — a strategy score,
# not an account return — and the drawdown is in percentage POINTS of that
# score. The account block below answers the money question separately.
ok('the curve ends at the total', s['equity_curve'][-1]['value'],
   s['total_return_pct'], tol=1e-6)


# ── PART C · the account block ──────────────────────────────────────────────
print("PART C — the money, at 100k risking 1% with no fees")

# One trade: entry 100, stop 99 -> $1 of risk per share.
# 1% of 100,000 = $1,000 risk -> 1000 shares.  Exit 102 -> +$2,000.
ONE = [trade(0.02, entry=100.0, stop=99.0, exit_px=102.0, n=0)]
acct = bt._account_block(ONE, {'account_equity': 100000, 'risk_pct': 1.0,
                               'max_leverage': 100})
ok('shares = risk$ / risk-per-share = 1000 / 1', acct['trades_sized'], 1)
ok('...and the size is on the trade', ONE[0]['ctx']['acct_shares'], 1000.0)
ok('net = 1000 x $2 = $2,000', acct['net_pnl_usd'], 2000.0)
ok('equity 100,000 -> 102,000', acct['equity_end'], 102000.0)
ok('return = +2.00%', acct['return_pct'], 2.0)
ok('no fees were charged', acct['fees_usd'], 0.0)
ok('R multiple = 2000 gross / 1000 risk = 2.0', ONE[0]['ctx']['acct_r_multiple'], 2.0)
ok('average = the one trade', acct['avg_pnl_usd'], 2000.0)
ok('win rate = 1 of 1', acct['win_rate_pct'], 100.0)

# Fees. TTP: half a cent a share, 75c minimum per ORDER. One entry order and
# one exit order at 1000 shares = $5 each = $10.
acct_fee = bt._account_block(
    [trade(0.02, entry=100.0, stop=99.0, exit_px=102.0, n=0)],
    {'account_equity': 100000, 'risk_pct': 1.0, 'max_leverage': 100,
     'fee_per_share': 0.005, 'fee_min_per_order': 0.75})
ok('two orders x 1000 shares x $0.005 = $10 of commission',
   acct_fee['fees_usd'], 10.0)
ok('net is AFTER fees: 2000 - 10', acct_fee['net_pnl_usd'], 1990.0)

# The minimum bites on a small order: 10 shares x $0.005 = 5c -> 75c.
acct_min = bt._account_block(
    [trade(0.02, entry=100.0, stop=90.0, exit_px=102.0, n=0)],
    {'account_equity': 1000, 'risk_pct': 10.0, 'max_leverage': 100,
     'fee_per_share': 0.005, 'fee_min_per_order': 0.75})
ok('the per-order minimum applies, not the per-share rate',
   acct_min['fees_usd'], 1.5)

# A trade with no usable stop cannot be sized, and is EXCLUDED rather than
# guessed at — but it must be counted as excluded.
NOSTOP = [trade(0.02, entry=100.0, stop=100.0, exit_px=102.0, n=0),
          trade(0.02, entry=100.0, stop=99.0, exit_px=102.0, n=1)]
acct_ns = bt._account_block(NOSTOP, {'account_equity': 100000, 'risk_pct': 1.0,
                                     'max_leverage': 100})
ok('a stop at the entry cannot size a trade', acct_ns['unsized_no_stop'], 1)
ok('...and it is not in the sized count', acct_ns['trades_sized'], 1)
ok('...nor in the account win rate', acct_ns['win_rate_pct'], 100.0)


# ── PART D · Sharpe and the daily series ────────────────────────────────────
print("PART D — Sharpe, over every evaluated day")

# Two trades on two days, +2% and -1%, across FOUR evaluated days.
# daily = [0.02, -0.01, 0, 0]   mean = 0.0025
# sample variance = ((0.0175)^2+(0.0125)^2+(0.0025)^2+(0.0025)^2)/3
#                 = (0.00030625+0.00015625+0.00000625+0.00000625)/3
#                 = 0.000475/3 = 0.00015833   sd = 0.0125831
# sharpe = 0.0025/0.0125831 x sqrt(252) = 0.19868 x 15.8745 = 3.154
DAYS = ['2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12']
TWO = [trade(0.02, n=0, date=DAYS[0]), trade(-0.01, n=1, date=DAYS[1])]
s2 = bt._summary(TWO, [], n_pairs=8, errors=[], all_dates=DAYS)
ok('Sharpe is annualised from the daily series', s2['sharpe'], 3.15, tol=0.02)

# FLAT DAYS COUNT. Dropping them shrinks the sample and inflates the ratio;
# with only the two traded days the answer is a different number entirely.
s2_short = bt._summary(TWO, [], n_pairs=8, errors=[], all_dates=DAYS[:2])
ok('...and dropping the flat days would change it', s2_short['sharpe'] != s2['sharpe'],
   True)

# Two trades on the SAME day are one daily return, not two.
SAMEDAY = [trade(0.02, n=0, date=DAYS[0]), trade(-0.01, n=1, date=DAYS[0])]
s3 = bt._summary(SAMEDAY, [], n_pairs=8, errors=[], all_dates=DAYS)
# daily = [0.01, 0, 0, 0]  mean 0.0025  var = ((0.0075)^2+3*(0.0025)^2)/3
#       = (0.00005625+0.00001875)/3 = 0.000025  sd = 0.005
# sharpe = 0.0025/0.005 * 15.8745 = 7.937
ok('two trades on one day are ONE daily return', s3['sharpe'], 7.94, tol=0.02)


# ── PART E · the two win rates are different questions ──────────────────────
print("PART E — the unsized win rate and the account win rate")

# A trade that made +0.5% GROSS but lost money after commission. The strategy
# score says it won; the account says it did not. Both are right, and showing
# one under the other's label is how a 60% strategy reads as 60% of trades
# making money.
THIN = [trade(0.005, entry=100.0, stop=99.9, exit_px=100.5, n=0)]
s_thin = bt._summary(THIN, [], n_pairs=1, errors=[], all_dates=[DAY],
                     spec={'account_equity': 10000, 'risk_pct': 0.1,
                           'fee_per_share': 0.005, 'fee_min_per_order': 0.75,
                           'max_leverage': 100})
ok('the unsized win rate counts it as a win (the MOVE was positive)',
   s_thin['win_rate'], 100.0)
a_thin = s_thin['account']
# 0.1% of 10,000 = $10 risk; risk/share = 0.10 -> 100 shares.
# gross = 100 x 0.50 = $50.
# Commission: 100 x $0.005 = $0.50 an order, which is UNDER the 75c minimum, so
# each order pays 75c -> $1.50. (Worked out as $1.00 first, forgetting the
# minimum; the code had it right and the hand arithmetic did not.)
ok('the account sizes it at 100 shares', THIN[0]['ctx']['acct_shares'], 100.0)
ok('...and nets $48.50 — the 75c per-order minimum beats the per-share rate',
   a_thin['net_pnl_usd'], 48.5)
ok('so this one is a win on both counts', a_thin['win_rate_pct'], 100.0)

# Now make the commission bigger than the edge: 1 share, 75c minimum each way.
TINY = [trade(0.005, entry=100.0, stop=99.5, exit_px=100.5, n=0)]
s_tiny = bt._summary(TINY, [], n_pairs=1, errors=[], all_dates=[DAY],
                     spec={'account_equity': 100, 'risk_pct': 0.5,
                           'fee_per_share': 0.005, 'fee_min_per_order': 0.75,
                           'max_leverage': 100})
a_tiny = s_tiny['account']
# 0.5% of 100 = $0.50 risk; risk/share = 0.50 -> 1 share.
# gross = $0.50. fees = 2 x 0.75 = $1.50. net = -$1.00.
ok('gross positive, net negative after the per-order minimum',
   a_tiny['net_pnl_usd'], -1.0)
ok('THE STRATEGY says it won', s_tiny['win_rate'], 100.0)
ok('THE ACCOUNT says it lost', a_tiny['win_rate_pct'], 0.0)
ok('the two numbers are allowed to disagree, and here they must',
   s_tiny['win_rate'] != a_tiny['win_rate_pct'], True)


# ── PART F · scale-out P&L ──────────────────────────────────────────────────
print("PART F — a trade that exits in three places")

# entry 100, stop 99 ($1 risk/share). 10% out at 103, 80% at 106, 10% runner
# exits at 104.
#   per share: 0.1x3 + 0.8x6 + 0.1x4 = 0.3 + 4.8 + 0.4 = 5.5
# At 1000 shares: gross $5,500.
# Commission: the ENTRY order (1000 sh) + three exit orders (100, 800, 100)
#   = 1000 + 1000 = 2000 shares x $0.005 = $10.00
SCALE = [trade(0.055, entry=100.0, stop=99.0, exit_px=104.0, n=0,
               legs=[{'fraction': 0.1, 'price': 103.0},
                     {'fraction': 0.8, 'price': 106.0}])]
a_sc = bt._account_block(SCALE, {'account_equity': 100000, 'risk_pct': 1.0,
                                 'max_leverage': 100, 'fee_per_share': 0.005,
                                 'fee_min_per_order': 0.0})
ok('every leg is priced at its own exit, not at the runner\'s',
   a_sc['net_pnl_usd'], 5500.0 - 10.0)
ok('one commission per ORDER — entry plus three exits', a_sc['fees_usd'], 10.0)
ok('R multiple over the whole position = 5500 / 1000',
   SCALE[0]['ctx']['acct_r_multiple'], 5.5)

# The fractions must be honoured exactly: a leg list that does not reach 1.0
# leaves a runner, and one that exceeds it must not invent shares.
fills = bt._fills(SCALE[0], True)
ok('the fills add to the whole position', round(sum(f for f, _ in fills), 9), 1.0)
ok('there are three of them', len(fills), 3)

# An OPEN position banks its legs and has no runner fill.
open_fills = bt._fills(SCALE[0], False)
ok('an open position realises only the banked legs',
   round(sum(f for f, _ in open_fills), 9), 0.9)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
