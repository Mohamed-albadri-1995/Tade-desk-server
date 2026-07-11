"""Standard-order fan-out: one canonical order, per-broker scale + exit mode."""

from datetime import datetime

import pytest

from app.models import JournalModel
from app.services.broker_engine import (
    build_entry_order,
    scaled_qty,
    standard_order_from_entry,
)


def make_entry(shares=100, factors=None):
    return JournalModel(
        id=1, stock="NVDA", setup_id=1, signal_side="long", status="pending",
        entry_signal_time=datetime.utcnow(), entry_price=50.0,
        entry_sl_price=48.0, entry_tp_price=56.0, entry_shares=shares,
        entry_factors=factors or {},
    )


def test_scaled_qty_floors_never_rounds_up():
    assert scaled_qty(100, 1.0) == 100
    assert scaled_qty(100, 0.25) == 25
    assert scaled_qty(100, 2.0) == 200
    assert scaled_qty(10, 0.25) == 2     # 2.5 floored to 2 (never 3)
    assert scaled_qty(3, 0.25) == 0      # 0.75 floored to 0 -> broker skipped
    assert scaled_qty(100, 0.0) == 0


def test_standard_order_prefers_stored():
    entry = make_entry(factors={"standard_order": {"symbol": "X", "qty": 7, "side": "sell"}})
    assert standard_order_from_entry(entry)["qty"] == 7
    # Falls back to card fields when not stored.
    plain = standard_order_from_entry(make_entry(shares=40))
    assert plain["qty"] == 40 and plain["side"] == "buy"
    assert plain["stop_loss"] == 48.0 and plain["take_profit"] == 56.0


def test_bracket_entry_attaches_legs():
    std = standard_order_from_entry(make_entry(shares=100))
    order = build_entry_order(std, scale=1.0, exit_mode="bracket")
    assert order["qty"] == 100
    assert order["order_class"] == "bracket"
    assert order["stop_loss"] == {"stop_price": 48.0}
    assert order["take_profit"] == {"limit_price": 56.0}


def test_at_exit_entry_has_no_legs():
    std = standard_order_from_entry(make_entry(shares=100))
    order = build_entry_order(std, scale=0.5, exit_mode="at_exit")
    assert order["qty"] == 50
    assert "order_class" not in order  # plain entry; tool sends the exit later


def test_scale_zero_returns_no_order():
    std = standard_order_from_entry(make_entry(shares=3))
    assert build_entry_order(std, scale=0.25, exit_mode="bracket") is None  # 0.75 -> 0


@pytest.mark.asyncio
async def test_dispatch_fans_out_to_each_broker(monkeypatch):
    from app.services.broker_engine import BrokerEngine

    engine = BrokerEngine()

    class B:
        def __init__(self, id, type, scale, exit_mode):
            self.id, self.type, self.scale, self.exit_mode = id, type, scale, exit_mode
            self.name = f"{type}-{scale}"
            self.api_key = self.secret = ""

    async def brokers():
        return [B(1, "paper", 1.0, "at_exit"),
                B(2, "paper", 0.25, "bracket"),
                B(3, "paper", 0.01, "bracket")]  # scales 100*0.01=1 -> ok

    engine._active_brokers = brokers
    results = await engine.dispatch(make_entry(shares=100))
    by_name = {r["broker"]: r for r in results}
    assert by_name["paper-1.0"]["qty"] == 100
    assert by_name["paper-0.25"]["qty"] == 25
    assert by_name["paper-0.01"]["qty"] == 1
    assert all(r["ok"] for r in results)


@pytest.mark.asyncio
async def test_dispatch_skips_broker_that_floors_to_zero():
    from app.services.broker_engine import BrokerEngine

    engine = BrokerEngine()

    class B:
        id, type, scale, exit_mode, name, api_key, secret = 1, "paper", 0.001, "bracket", "tiny", "", ""

    async def brokers():
        return [B()]

    engine._active_brokers = brokers
    results = await engine.dispatch(make_entry(shares=100))  # 100*0.001=0.1 -> 0
    assert results[0]["skipped"] == "zero shares at scale"
