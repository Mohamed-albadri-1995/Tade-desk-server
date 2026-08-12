"""The funded-account question: +target% BEFORE -limit%, or the account is shut.

"Max drawdown 1.47%" does not answer it. That is the deepest fall ANYWHERE in
the run, with no statement of when — a strategy can finish +9% having been -4%
in week one, and a prop firm would have closed it in week one. The only thing a
challenge asks is which line was touched first.

The tests that matter are the ones about honesty, not arithmetic:

  - drawdown is judged on the WORST CASE, not the closed-trade curve. The
    stored trades hold entry and exit, never the path between, so a closed
    curve cannot see a position that swung -3% and came back. The worst case
    assumes every position still open stops out at once — the floor the account
    could really have touched with the stops it actually had.
  - both lines in the same instant is a FAIL. The firm closes on the breach
    whatever happened afterwards.

    python3 -m pytest chart/tests/test_challenge.py -q      (from quant-platform/)
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart.backtest import _challenge_block                   # noqa: E402


def leg(t0, t1, net, risk, date='2026-08-03', sym='AAA'):
    """(entry_ts, exit_ts, net$, risk$, date, symbol) — one sized trade."""
    return (t0, t1, net, risk, date, sym)


def run(ledger, target=6.0, limit=3.0, basis='start', equity=100_000.0):
    return _challenge_block(ledger, equity, {
        'challenge': {'target_pct': target, 'max_dd_pct': limit, 'basis': basis}})


# ── the verdict ───────────────────────────────────────────────────────────

def test_target_reached_cleanly_passes():
    out = run([leg(1, 2, 3_000, 500), leg(3, 4, 4_000, 500)])
    assert out['result'] == 'target'
    assert out['peak_profit_pct'] == 7.0


def test_drawdown_first_fails_even_when_the_run_ends_up():
    """+9% at the end, but -4% in week one. The account was closed in week one."""
    out = run([leg(1, 2, -4_000, 500),        # -4%  → breached
               leg(3, 4, 13_000, 500)])       # +9% overall, too late
    assert out['result'] == 'drawdown'
    assert out['final_pct'] == 9.0            # the misleading number, still shown


def test_neither_line_touched():
    out = run([leg(1, 2, 1_000, 500)])
    assert out['result'] == 'neither'


# ── the honesty: open positions ───────────────────────────────────────────

def test_open_risk_counts_against_the_drawdown():
    """Six positions open at once, each risking 0.5%, on a flat account.

    Nothing has been LOST — every trade closes at breakeven — but at the moment
    all six were open the account was one bad minute from -3%. A closed-trade
    curve shows a flat line and calls that a pass. The firm's trailing rule
    would have been watching the floor.
    """
    ledger = [leg(i, 100, 0.0, 500) for i in range(1, 7)]     # all open together
    out = run(ledger)
    assert out['closed_dd_pct'] == 0.0            # the optimistic view
    assert out['worst_case_dd_pct'] == 3.0        # the one that decides
    assert out['result'] == 'drawdown'


def test_the_same_risk_taken_one_at_a_time_is_safe():
    """Identical trades, identical risk — but never overlapping. Concurrency is
    the whole difference, which is exactly what the cap and top-N control."""
    ledger = [leg(i * 10, i * 10 + 1, 0.0, 500) for i in range(1, 7)]
    out = run(ledger)
    assert out['worst_case_dd_pct'] == 0.5        # only ever one at risk
    assert out['result'] == 'neither'


# ── the order of events ───────────────────────────────────────────────────

def test_open_risk_can_breach_before_the_winner_lands():
    """A big winner is on its way, and 3.5% of risk is open while it runs.

    The breach happens at the moment the risk goes ON — not when something is
    lost. This is the case a closed-trade curve cannot see at all: it shows a
    flat line, then +6%, and calls it a clean pass.
    """
    out = run([leg(1, 5, 6_000, 500),      # closes +6% at t=5
               leg(2, 99, 0.0, 3_000)])    # but sits open from t=2
    assert out['result'] == 'drawdown'
    assert out['closed_dd_pct'] == 0.0     # nothing was ever LOST
    assert out['worst_case_dd_pct'] == 3.5


# ── the basis ─────────────────────────────────────────────────────────────

def test_trailing_basis_fails_where_static_passes():
    """+5% then giving back 3% is fine against the STARTING balance and fatal
    against the high-water mark. Firms use both, so it is asked for."""
    # 3,500 off a 105,000 peak is 3.33%, and still 1.5% UP from the start
    ledger = [leg(1, 2, 5_000, 0), leg(3, 4, -3_500, 0)]
    assert run(ledger, basis='start')['result'] == 'neither'
    assert run(ledger, basis='peak')['result'] == 'drawdown'


# ── opt-in ────────────────────────────────────────────────────────────────

def test_absent_means_no_block():
    """No rules given, no verdict invented."""
    led = [leg(1, 2, 1_000, 500)]
    assert _challenge_block(led, 100_000, {}) is None
    assert _challenge_block(led, 100_000, {'challenge': {}}) is None
    assert _challenge_block(led, 100_000,
                            {'challenge': {'target_pct': 6}}) is None
    assert _challenge_block([], 100_000,
                            {'challenge': {'target_pct': 6, 'max_dd_pct': 3}}) is None


def test_the_limits_are_reported_back():
    """A verdict is unreadable without the rules it was judged against."""
    out = run([leg(1, 2, 1_000, 0)], target=6, limit=3)
    assert (out['target_pct'], out['max_dd_pct'], out['basis']) == (6.0, 3.0, 'start')
    assert 'daily loss limit' in out['not_modelled']
