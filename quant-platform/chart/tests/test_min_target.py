"""The minimum-move gate: refuse a signal whose profit target is only cents away.

Why this exists, from backtest #236 (OR + VWAP 09:35, 8 sessions, register
T2:R1): 117 signals fired, 18 were sized, and 97 of the other 99 were dropped
with "no buying power left". Position size comes from the stop — risk$ / stop$
shares — so a stop a few cents wide implies a position the size of the whole
account. CELH's $0.115 stop bought $100,300 of stock on a $100k account, and
every signal after it that morning was skipped for lack of capital. The
skipping is by ARRIVAL ORDER, not by quality: the dropped set held ADEA
+13.70%, SEDG +8.64%, LIFE +7.97%.

So the fix belongs at the signal, before the money is committed. A 2R target on
a $0.04 stop is $0.08 — less than the spread on most names. That trade cannot
pay for itself and it costs the day everything behind it.

Two behaviours are the point, and the second one is the one worth guarding:
  1) a signal whose nearest target is under the floor is DROPPED, counted as
     `target_too_close`;
  2) a signal with NO priced target at all — an exit-RULE strategy, of which
     this repo has three — is KEPT. The gate has nothing to measure and must
     not invent a target to measure against. A filter that silently deleted
     Fashionably Late, PM Breakout and PML breakout would be worse than no
     filter, and would look exactly like "the strategy stopped firing".

    python3 -m pytest chart/tests/test_min_target.py -q      (from quant-platform/)
"""

import sys
import pathlib

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart.strategy import _pair_trades                      # noqa: E402


def bars(n=30, start=100.0, step=0.5):
    """A clean uptrend — every long entry reaches any target above it."""
    px = np.array([start + step * i for i in range(n)], float)
    return pd.DataFrame({
        'ts': np.arange(n) * 60_000,
        'open': px, 'high': px + 0.05, 'low': px - 0.05, 'close': px,
        'volume': np.full(n, 1000.0),
    })


def run(stop_pct, floor, targets=None, ts=None):
    """One long entry on bar 2, stop `stop_pct` below, 2R scale-out target."""
    b = bars()
    n = len(b)
    entry = np.zeros(n, bool)
    entry[2] = True
    risk = {'sl': {'type': 'pct', 'value': stop_pct},
            'targets': targets if targets is not None
            else [{'fraction': 1.0, 'r_multiple': 2.0}]}
    diag: dict = {}
    trades, _, _, open_trade = _pair_trades(
        b, b['ts'].to_numpy(), entry, np.zeros(n, bool), 'long', risk, {},
        fill='close', min_target_usd=floor, diag=diag)
    return trades, diag, open_trade


# ── the drop ──────────────────────────────────────────────────────────────

def test_target_under_the_floor_is_dropped():
    # entry ~101, stop 0.02% = $0.0202, 2R target = $0.040 away — under $0.10.
    trades, diag, _ = run(0.02, 0.10)
    assert trades == []
    assert diag.get('target_too_close') == 1


def test_target_over_the_floor_is_taken():
    # stop 0.5% = ~$0.505, 2R target ~$1.01 away — clears $0.10 comfortably.
    trades, diag, _ = run(0.5, 0.10)
    assert len(trades) == 1
    assert 'target_too_close' not in diag


def test_the_floor_is_measured_in_dollars_not_percent():
    """The same 0.02% stop passes once the floor drops below the move."""
    dropped, _, _ = run(0.02, 0.10)
    kept, _, _ = run(0.02, 0.01)
    assert dropped == [] and len(kept) == 1


def test_no_floor_means_no_gate():
    """Absent must behave exactly as before the gate existed — every existing
    strategy has no `min_target_usd`, and none of them may change behaviour."""
    for floor in (None, 0, 0.0, ''):
        trades, diag, _ = run(0.02, floor)
        assert len(trades) == 1, floor
        assert 'target_too_close' not in diag


# ── the refusal to guess ──────────────────────────────────────────────────

def test_rule_exit_strategy_is_kept_and_counted():
    """No targets at all → nothing to measure → the trade is NOT dropped.

    With no target and no exit rule the position is still OPEN at the last bar,
    which is the honest outcome: the gate let it through, it just never closed.
    """
    trades, diag, open_trade = run(0.02, 0.10, targets=[])
    assert open_trade is not None
    assert 'target_too_close' not in diag
    assert diag.get('target_unpriced_kept') == 1


# ── nearest, not furthest ─────────────────────────────────────────────────

def test_the_nearest_leg_decides():
    """A scale-out ladder is judged on its FIRST leg — that is the first money
    the trade can bank, and the leg the spread eats. A 1R leg at $0.04 is not
    rescued by a 10R leg behind it."""
    ladder = [{'fraction': 0.5, 'r_multiple': 1.0},
              {'fraction': 0.5, 'r_multiple': 10.0}]
    trades, diag, _ = run(0.02, 0.10, targets=ladder)
    assert trades == []
    assert diag.get('target_too_close') == 1
