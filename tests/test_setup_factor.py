"""SetupFactorEngine — the health cap (WR/PF/drawdown → factor 0..1)."""

from datetime import datetime, timedelta

import pytest

from app.services.setup_factor import SetupFactorEngine


def make_trades(rs, setup_id=1):
    from app.models import JournalModel

    out = []
    for i, r in enumerate(rs):
        t0 = datetime(2026, 6, 1, 14, 0) + timedelta(hours=i)
        out.append(
            JournalModel(
                id=i + 1, stock="TEST", setup_id=setup_id, signal_side="long",
                status="closed", entry_signal_time=t0, entry_price=100.0,
                entry_sl_price=98.0, entry_shares=10, exit_time=t0 + timedelta(minutes=30),
                exit_price=100.0 + 2 * r, exit_pnl=20.0 * r, r_multiple=float(r),
            )
        )
    return out


def make_engine(min_trades=30):
    engine = SetupFactorEngine()
    engine.min_trades = min_trades
    return engine


def test_insufficient_data_is_neutral():
    state = make_engine().compute_state(make_trades([1.0] * 10))  # n=10 < 30
    assert state["final_factor"] == 1.0
    assert state["insufficient_data"] is True


def test_great_setup_full_trust():
    # 60%+ win rate, PF >= 2, small drawdown -> all norms ~1 -> factor 1.0
    rs = ([2.0, 2.0, -1.0] * 10)  # WR 66.7%, PF 4.0, shallow DD
    state = make_engine().compute_state(make_trades(rs))
    assert state["insufficient_data"] is False
    assert state["final_factor"] == 1.0  # health*1.2 clamped to 1.0
    assert state["inputs"]["n"] == 30


def test_terrible_setup_low_factor():
    # mostly losers: WR 10%, PF << 1, deep drawdown
    rs = [-1.0] * 27 + [0.5] * 3
    state = make_engine().compute_state(make_trades(rs))
    assert state["final_factor"] < 0.2
    assert state["components"]["dd_norm"] == 0.0  # > 10R drawdown


def test_health_formula_exact():
    engine = make_engine(min_trades=4)
    # 2 wins (+2R each = +40 pnl each), 2 losses (-1R = -20 each)
    state = engine.compute_state(make_trades([2.0, -1.0, 2.0, -1.0]))
    # WR=0.5 -> 0.8333; PF=80/40=2 -> 1.0; maxDD=1R -> 0.9
    expected_health = 0.8333 * 0.30 + 1.0 * 0.40 + 0.9 * 0.30
    assert state["score"] == pytest.approx(expected_health, abs=0.001)
    assert state["final_factor"] == pytest.approx(min(1.0, expected_health * 1.2), abs=0.01)


def test_factor_never_boosts():
    rs = [3.0] * 30  # perfect setup
    state = make_engine().compute_state(make_trades(rs))
    assert state["final_factor"] <= 1.0  # health is a cap, not a booster


def test_per_side_states():
    engine = make_engine(min_trades=5)
    good = engine.compute_state(make_trades([2.0, 2.0, -1.0] * 4))
    bad = engine.compute_state(make_trades([-1.5] * 12))
    engine._states = {
        (1, "pooled"): {**good, "side": "pooled"},
        (1, "long"): {**good, "side": "long"},
        (1, "short"): {**bad, "side": "short"},
    }
    assert engine.get_state(1, "long")["final_factor"] > engine.get_state(1, "short")["final_factor"]
    assert engine.get_state(1, "short")["side_used"] == "short"


def test_sizer_capital_cap_with_final_multiplier():
    from app.services.sizer_engine import SizerEngine

    sizer = SizerEngine()
    sizer.risk_per_trade = 0.01
    accounts = [
        {"id": 1, "name": "Main", "account_size": 100000.0, "risk_per_trade": None,
         "broker_id": None, "is_primary": True},
    ]
    available = {1: 20000.0}

    result = sizer.calculate_multi(
        entry_price=100.0, sl_price=98.0, final_multiplier=1.0,
        accounts=accounts, available_fn=lambda i: available[i],
    )
    main = result["accounts"]["1"]
    assert main["risk_based_shares"] == 500  # 1000 risk / 2
    assert main["capital_capped"] is True
    assert main["final_shares"] == 200  # 20000 / 100

    boosted = sizer.calculate_multi(
        entry_price=100.0, sl_price=98.0, final_multiplier=1.4,
        accounts=accounts, available_fn=lambda i: None,
    )
    assert boosted["accounts"]["1"]["final_shares"] == 700  # 500 × 1.4

    zero = sizer.calculate_multi(
        entry_price=100.0, sl_price=98.0, final_multiplier=0.0,
        accounts=accounts, available_fn=lambda i: None,
    )
    assert zero["final_shares"] == 0
