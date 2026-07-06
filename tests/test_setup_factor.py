"""SetupFactorEngine — performance signals, shrinkage, and the 0 block."""

from datetime import datetime, timedelta

from app.models import JournalModel
from app.services.setup_factor import SetupFactorEngine


def make_trades(rs, setup_id=1):
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


def test_insufficient_data_is_neutral():
    engine = SetupFactorEngine()
    state = engine.compute_state(make_trades([1.0, 1.0]))  # n=2 < hard floor 5
    assert state["final_factor"] == 1.0
    assert state["insufficient_data"] is True


def test_strong_setup_gets_boost():
    engine = SetupFactorEngine()
    # 20 trades, mostly winners: expectancy well above +0.5R
    state = engine.compute_state(make_trades([1.5, 1.2, -0.5, 1.0, 1.4] * 4))
    assert state["insufficient_data"] is False
    assert state["confidence"] == 1.0  # n=20 = min_trades
    assert state["final_factor"] > 1.0
    assert state["signal_points"]["expectancy_r"] == 2.0
    assert state["inputs"]["n"] == 20


def test_bad_setup_reaches_zero():
    engine = SetupFactorEngine()
    # 20 straight losers: score bottoms out -> mapped factor 0.0, full confidence
    state = engine.compute_state(make_trades([-1.0] * 20))
    assert state["mapped_factor"] == 0.0
    assert state["final_factor"] == 0.0  # the block point the user asked for


def test_shrinkage_pulls_toward_neutral():
    engine = SetupFactorEngine()
    # Same losing profile (maps to 0.0) but only 10 trades -> confidence 0.5
    state = engine.compute_state(make_trades([-1.5] * 10))
    assert state["confidence"] == 0.5
    assert state["mapped_factor"] == 0.0
    assert state["final_factor"] == 0.5  # 1 + (0 - 1) * 0.5


def test_recent_form_signal():
    engine = SetupFactorEngine()
    # Early trades bad, recent 10 good -> recent form point awarded
    state = engine.compute_state(make_trades([-1.0] * 10 + [1.0] * 10))
    assert state["signal_points"].get("recent_form") == 1.0


def test_sizer_capital_cap_and_setup_factor():
    from app.services.sizer_engine import SizerEngine

    sizer = SizerEngine()
    sizer.risk_per_trade = 0.01
    sizer._grade_multipliers = {"B": 1.0}
    sizer._regime_multipliers = {}
    accounts = [
        {"id": 1, "name": "Main", "account_size": 100000.0, "risk_per_trade": None,
         "broker_id": None, "is_primary": True},
        {"id": 2, "name": "Small", "account_size": 10000.0, "risk_per_trade": 0.02,
         "broker_id": 7, "is_primary": False},
    ]
    available = {1: 20000.0, 2: 500.0}  # "at the moment" capital

    result = sizer.calculate_multi(
        entry_price=100.0, sl_price=98.0, grade="B", regime_key="",
        setup_factor=1.0, accounts=accounts, available_fn=lambda i: available[i],
    )
    main = result["accounts"]["1"]
    # risk-based: 1000 / 2 = 500 shares, but only 20000/100 = 200 affordable
    assert main["risk_based_shares"] == 500
    assert main["capital_cap_shares"] == 200
    assert main["capital_capped"] is True
    assert main["final_shares"] == 200
    small = result["accounts"]["2"]
    # risk-based: 200 / 2 = 100 shares, cap 500/100 = 5
    assert small["final_shares"] == 5
    assert result["final_shares"] == 200  # primary account headline

    # setup factor scales risk-based shares; factor 0 -> zero everywhere
    zero = sizer.calculate_multi(
        entry_price=100.0, sl_price=98.0, grade="B", regime_key="",
        setup_factor=0.0, accounts=accounts, available_fn=lambda i: available[i],
    )
    assert zero["final_shares"] == 0
    assert all(a["final_shares"] == 0 for a in zero["accounts"].values())
