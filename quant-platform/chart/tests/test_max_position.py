"""The per-trade position cap — the backtest obeying the rule the screener runs.

The point of a backtest is that the thing you tested is the thing that trades.
The screener has capped every order at `maxPositionPct` of the account since it
could place orders at all (src/setups/risk.js); the backtest had no such knob,
so it was measuring a strategy nobody would ever run.

What that cost, from backtest #237: ALNY's $0.63 stop bought 471 shares =
$99,966 of a $100,000 balance on ONE trade. CELH took $100,925. With the
account full by 09:36 the other 93 signals were skipped "no buying power left"
— dropped by ARRIVAL ORDER, not by quality, and the dropped set held ADEA
+13.70%, SEDG +8.64%, LIFE +7.97%.

Three things are pinned here:
  1) the cap binds, and shares come out at exactly N% of equity / entry;
  2) it is applied BEFORE the portfolio-wide leverage cap, so it actually frees
     room for later names — reversed, the first trade would still swallow the
     balance and the cap would only bite on trades already squeezed;
  3) absent means absent — every backtest run before this existed must produce
     the same numbers it did then.

    python3 -m pytest chart/tests/test_max_position.py -q     (from quant-platform/)
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart.backtest import _account_block                     # noqa: E402


def trade(sym, entry, stop, exit_px, t0, t1, side='long'):
    """One closed trade. Times are plain ints — only their order matters."""
    return {'date': '2026-08-03', 'symbol': sym, 'side': side,
            'entry': entry, 'stop': stop, 'exit': exit_px,
            'entry_ts': t0, 'exit_ts': t1, 'legs': [], 'ctx': {}}


def spec(**kw):
    base = {'account_equity': 100_000, 'risk_pct': 0.5, 'max_leverage': 1.0}
    base.update(kw)
    return base


# A $0.10 stop on a $100 stock: risk sizing wants $500 / $0.10 = 5,000 shares
# = $500,000 of stock. Cash-only leverage already trims that to $100,000; the
# per-trade cap is what trims it to a share of the day.
TIGHT = dict(entry=100.0, stop=99.90, exit_px=100.0)


def test_the_cap_binds_at_exactly_n_percent():
    t = trade('AAA', **TIGHT, t0=1, t1=9)
    _account_block([t], spec(max_position_pct=25))
    # 25% of $100,000 = $25,000 / $100 = 250 shares
    assert t['ctx']['acct_shares'] == 250.0
    assert t['ctx']['acct_notional_usd'] == 25_000.0


def test_without_the_cap_one_trade_takes_the_whole_account():
    """The behaviour that made #237 unreadable, kept as the baseline."""
    t = trade('AAA', **TIGHT, t0=1, t1=9)
    out = _account_block([t], spec())
    assert t['ctx']['acct_notional_usd'] == 100_000.0     # 100% of equity
    assert out['size_capped_by_position'] == 0


def test_the_cap_runs_before_the_portfolio_cap_so_later_names_get_funded():
    """Three tight-stop signals at the same moment, cash-only account.

    Uncapped, the first swallows the balance and the other two are skipped for
    lack of capital. That is the arrival-order selection the cap exists to end.
    """
    def three():
        return [trade('AAA', **TIGHT, t0=1, t1=9),
                trade('BBB', **TIGHT, t0=2, t1=9),
                trade('CCC', **TIGHT, t0=3, t1=9)]

    bare = three()
    out = _account_block(bare, spec())
    assert out['trades_sized'] == 1
    assert out['skipped_no_capital'] == 2

    capped = three()
    out = _account_block(capped, spec(max_position_pct=25))
    assert out['trades_sized'] == 3
    assert out['skipped_no_capital'] == 0
    assert out['size_capped_by_position'] == 3
    assert [t['ctx']['acct_notional_usd'] for t in capped] == [25_000.0] * 3


def test_a_wide_stop_is_untouched():
    """The cap must only bite where risk sizing overshoots. A $5 stop wants
    100 shares = $10,000, which is under 25% — it stays exactly 100."""
    t = trade('AAA', entry=100.0, stop=95.0, exit_px=100.0, t0=1, t1=9)
    out = _account_block([t], spec(max_position_pct=25))
    assert t['ctx']['acct_shares'] == 100.0
    assert out['size_capped_by_position'] == 0


def test_absent_means_absent():
    """Every value that reads as "not set" must leave sizing untouched, so no
    backtest saved before this knob existed changes its numbers."""
    for v in (None, 0, 0.0, '', -5):
        t = trade('AAA', **TIGHT, t0=1, t1=9)
        out = _account_block([t], spec(max_position_pct=v))
        assert t['ctx']['acct_notional_usd'] == 100_000.0, v
        assert out['max_position_pct'] is None, v


def test_the_cap_is_reported():
    t = trade('AAA', **TIGHT, t0=1, t1=9)
    out = _account_block([t], spec(max_position_pct=25))
    assert out['max_position_pct'] == 25.0
    assert out['size_capped_by_position'] == 1
