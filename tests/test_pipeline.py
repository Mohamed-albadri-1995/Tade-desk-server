"""End-to-end test of the 10-step signal pipeline (spec section 4) using
in-memory caches and the real DB-backed journal."""

import pytest
import pytest_asyncio

from app.database import init_db
from app.models import ConditionModel, SetupModel
from app.services.monitor import MonitorService
from app.services.screener_data import TickerContext

pytestmark = pytest.mark.asyncio


SETUP_SCRIPT = """
from typing import Dict, List, Optional, Tuple
from datetime import datetime

class SetupIndicator:
    def get_mandatory_conditions(self) -> List[str]:
        return ["always_on"]
    def evaluate_mandatory(self, stock, timestamp, market_data) -> Dict[str, bool]:
        return {"always_on": True}
    def check_signal(self, stock, timestamp, market_data) -> Optional[str]:
        return "long"
    def get_sl_tp(self, stock, timestamp, market_data) -> Tuple[float, float]:
        price = market_data.get_current_price(stock)
        return (price - 2.0, price + 4.0)
    def get_entry_params(self) -> Tuple[str, Optional[float]]:
        return ("market", None)
"""

CONDITION_SCRIPT = """
class ConditionCheck:
    def get_name(self):
        return "trend_ok"
    def evaluate(self, signal_side, stock, timestamp, market_data):
        return signal_side == "long"
    def get_raw_display(self, stock, timestamp, market_data):
        return {"price": market_data.get_current_price(stock)}
"""


@pytest_asyncio.fixture()
async def monitor_service(bars):
    await init_db()
    service = MonitorService()
    service.market_cache["TEST"] = {"bars": bars, "price": bars[-1]["close"], "timestamp": None}
    service.screener_cache["TEST"] = TickerContext(stock="TEST", regime="BULL", secBias="BULLISH")
    service.sizer_engine.account_size = 100000.0
    service.sizer_engine.risk_per_trade = 0.01
    service.sizer_engine._grade_multipliers = {"B": 1.0}
    return service


def make_setup(**overrides) -> SetupModel:
    data = dict(
        id=1,
        name="test setup",
        script_content=SETUP_SCRIPT,
        mandatory_conditions=["always_on"],
        sl_tp=None,
        entry_method="market",
        entry_price=None,
        is_active=True,
    )
    data.update(overrides)
    return SetupModel(**data)


def make_condition(type_: str, **overrides) -> ConditionModel:
    data = dict(
        id=1 if type_ == "default" else 2,
        name=f"{type_}_cond",
        type=type_,
        script_content=CONDITION_SCRIPT,
        associated_setups=[1],
        is_active=True,
    )
    data.update(overrides)
    return ConditionModel(**data)


async def test_full_pipeline_creates_alerted_entry(monitor_service, bars):
    setup = make_setup()
    conditions = [make_condition("default"), make_condition("additional")]
    evaluation = monitor_service.setup_engine.evaluate(
        "TEST", setup, __import__("datetime").datetime.utcnow()
    )
    assert evaluation["signal_side"] == "long"

    entry = await monitor_service.run_signal_pipeline("TEST", setup, conditions, evaluation)
    assert entry is not None
    assert entry["status"] == "alerted"
    assert entry["signal_side"] == "long"
    assert entry["entry_price"] == pytest.approx(bars[-1]["close"])
    assert entry["entry_sl_price"] == pytest.approx(bars[-1]["close"] - 2.0)
    assert entry["entry_tp_price"] == pytest.approx(bars[-1]["close"] + 4.0)
    # Both gradable conditions aligned -> signal-points model gives 100 -> A+.
    assert entry["entry_grade"] == "A+"
    assert entry["entry_factors"]["grade_score"] == 100.0
    assert set(entry["entry_factors"]["grade_breakdown"]) == {"default_cond", "additional_cond"}
    assert entry["entry_mandatory_results"] == {"always_on": True}
    assert entry["entry_default_results"] == {"default_cond": True}
    assert entry["entry_additional_results"] == {"additional_cond": True}
    assert entry["entry_gate_allowed"] is True
    # 1000 risk / 2.0 per share; A+ has no multiplier configured in this test -> 1.0
    assert entry["entry_shares"] == 500
    assert entry["entry_gate_screener_snapshot"]["regime"] == "BULL"


async def test_pipeline_gate_rejection_stops(monitor_service):
    monitor_service.gate_engine._rules = [
        {"id": 1, "rule_name": "block-longs", "condition": {"secBias": "BULLISH"},
         "side_allowed": "short", "priority": 10}
    ]
    setup = make_setup(id=2)
    evaluation = monitor_service.setup_engine.evaluate(
        "TEST", setup, __import__("datetime").datetime.utcnow()
    )
    entry = await monitor_service.run_signal_pipeline("TEST", setup, [], evaluation)
    assert entry["status"] == "rejected"
    assert entry["entry_gate_allowed"] is False
    # STOP after gate: no sizing/grading was performed.
    assert entry["entry_shares"] is None
    assert entry["entry_grade"] is None


async def test_exit_card_update(monitor_service):
    setup = make_setup(id=3)
    evaluation = monitor_service.setup_engine.evaluate(
        "TEST", setup, __import__("datetime").datetime.utcnow()
    )
    entry = await monitor_service.run_signal_pipeline("TEST", setup, [], evaluation)
    updated = await monitor_service.journal_service.update_exit_card(
        entry["id"], {"exit_price": 110.0, "exit_pnl": 250.0, "exit_reason": "target", "status": "closed"}
    )
    assert updated.exit_price == 110.0
    assert updated.exit_reason == "target"
    assert updated.status == "closed"
    assert updated.exit_time is not None
    # Entry snapshot remains immutable.
    assert updated.entry_price == entry["entry_price"]
