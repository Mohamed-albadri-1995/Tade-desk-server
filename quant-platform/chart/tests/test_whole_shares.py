"""The backtest buys whole shares, because that is what the broker fills.

Same reason as the position cap: a backtest is only worth running if the thing
it measured is the thing that trades. The screener floors the share count
before it sends an order (src/setups/risk.js) and the SignalStack bridge
REFUSES a fractional quantity outright — so every fractional position the
simulation held was a position the live system would never have taken.

The direction of the error is one-way: flooring only ever makes the simulation
smaller, never larger. 584.8 shares of CAKE was 584 shares of CAKE and 0.8
shares of nothing.

    python3 -m pytest chart/tests/test_whole_shares.py -q     (from quant-platform/)
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart.backtest import _account_block                     # noqa: E402


def trade(entry, stop, exit_px, side='long'):
    return {'date': '2026-08-03', 'symbol': 'AAA', 'side': side,
            'entry': entry, 'stop': stop, 'exit': exit_px,
            'entry_ts': 1, 'exit_ts': 9, 'legs': [], 'ctx': {}}


def spec(**kw):
    base = {'account_equity': 100_000, 'risk_pct': 0.5, 'max_leverage': 1.0}
    base.update(kw)
    return base


def test_the_share_count_is_a_whole_number():
    # $500 risk / $0.855 stop = 584.79... — the real CAKE trade from #237
    t = trade(entry=100.11, stop=100.965, exit_px=100.965, side='short')
    _account_block([t], spec())
    assert t['ctx']['acct_shares'] == 584.0


def test_it_floors_and_never_rounds_up():
    """Rounding up would risk MORE than the trade was sized for — the one
    direction a risk-sized position may never move."""
    t = trade(entry=100.11, stop=100.965, exit_px=100.965, side='short')
    _account_block([t], spec())
    shares = t['ctx']['acct_shares']
    assert shares * 0.855 <= 500.0        # never above the risk budget
    assert shares == 584.0                # not 585


def test_a_trade_that_cannot_afford_one_share_is_not_taken():
    """Live, `byRisk < 1` returns zero shares and a reason. The sim has to
    refuse the same trade rather than hold a sliver of one."""
    # one share risks $60 against a $500 budget → fine; risk $6,000 → not
    t = trade(entry=1_000.0, stop=400.0, exit_px=1_000.0)
    out = _account_block([t], spec())
    assert out['trades_sized'] == 0
    assert out['unsized_no_stop'] == 1
    assert 'more than the' in t['ctx']['acct_note']


def test_a_share_too_expensive_for_the_cap_says_so():
    """The other cause of "under one share", and it needs a different answer:
    the account's slice for one position will not buy a single share."""
    t = trade(entry=1_500.0, stop=1_499.0, exit_px=1_500.0)
    out = _account_block([t], spec(max_position_pct=1))     # 1% = $1,000
    assert out['trades_sized'] == 0
    assert 'one position may hold' in t['ctx']['acct_note']


def test_a_full_account_says_no_buying_power_not_no_risk_budget():
    """The three causes of "under one share" must not be confused.

    Backtest #238 told 67 trades "one share risks $0.19, more than the 0.5% of
    equity this trade may lose" — arithmetic nonsense against a $499 budget.
    Their real problem was that earlier positions had committed the balance.
    A wrong diagnosis sends you to change the wrong setting, so each cause is
    pinned to its own counter and its own sentence.
    """
    # $500 risk / $0.50 stop = 1,000 shares x $100 = the whole $100k balance
    big = trade(entry=100.0, stop=99.50, exit_px=100.0)
    late = trade(entry=100.0, stop=99.90, exit_px=100.0)     # arrives after it
    late['entry_ts'] = 2                                     # still open at t=2
    out = _account_block([big, late], spec(max_position_pct=100))

    assert out['trades_sized'] == 1
    assert out['skipped_no_capital'] == 1     # NOT unsized_no_stop
    assert out['unsized_no_stop'] == 0
    note = late['ctx']['acct_note']
    assert 'no buying power left' in note
    assert 'risks' not in note                # never blames the risk budget


def test_fees_and_pnl_use_the_floored_count():
    """The floor must happen BEFORE the money is computed, or the report would
    show a whole-share position earning fractional-share P&L."""
    t = trade(entry=10.0, stop=9.0, exit_px=11.0)           # 500 shares exactly
    _account_block([t], spec(fee_per_share=0.005))
    c = t['ctx']
    assert c['acct_shares'] == 500.0
    assert c['acct_notional_usd'] == 5_000.0
    assert c['acct_risk_usd'] == 500.0
    # 500 shares x $1.00 gain, minus $0.005/share on the entry and the exit
    assert c['acct_fees_usd'] == 5.0
    assert c['acct_pnl_usd'] == 495.0
