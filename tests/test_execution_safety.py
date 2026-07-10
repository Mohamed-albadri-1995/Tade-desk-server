"""Execution-safety fixes from the trader review: broker close dispatch
and same-tick capital reservation."""

from datetime import datetime

import pytest

from app.models import JournalModel
from app.services.capital import CapitalService

pytestmark = pytest.mark.asyncio


def make_entry(shares=100, factors=None):
    return JournalModel(
        id=1, stock="TEST", setup_id=1, signal_side="long", status="alerted",
        entry_signal_time=datetime.utcnow(), entry_price=50.0,
        entry_sl_price=49.0, entry_tp_price=53.0, entry_shares=shares,
        entry_factors=factors or {},
    )


async def test_dispatch_close_skips_zero_shares(monkeypatch):
    from app.services.broker_engine import BrokerEngine

    engine = BrokerEngine()

    class FakeBroker:
        id, name, type = 7, "paper", "alpaca"

    async def fake_brokers():
        return [FakeBroker()]

    engine._active_brokers = fake_brokers
    results = await engine.dispatch_close(make_entry(shares=0), "session_end")
    assert results == [{"broker": "paper", "ok": True, "skipped": "zero shares"}]


async def test_dispatch_skips_zero_qty_accounts(monkeypatch):
    from app.services.broker_engine import BrokerEngine

    engine = BrokerEngine()

    class FakeBroker:
        id, name, type = 7, "paper", "alpaca"

    async def fake_brokers():
        return [FakeBroker()]

    engine._active_brokers = fake_brokers
    # Per-account breakdown says this broker's account sized to 0.
    entry = make_entry(shares=100, factors={
        "accounts": {"1": {"broker_id": 7, "final_shares": 0, "name": "Main"}}
    })
    results = await engine.dispatch(entry)
    assert results == [{"broker": "paper", "ok": True, "skipped": "zero shares"}]


def test_capital_reserve_within_tick():
    service = CapitalService()
    service.accounts = [{"id": 1, "name": "Main", "account_size": 100000.0,
                         "risk_per_trade": None, "broker_id": None, "is_primary": True}]
    service.state = {1: {"capital_base": 100000.0, "open_allocation": 0.0, "source": "manual"}}

    assert service.available(1) == 100000.0
    # First signal of the tick takes 400 shares @ $50 = $20,000.
    service.reserve({"1": {"final_shares": 400, "name": "Main"}}, entry_price=50.0)
    assert service.available(1) == 80000.0
    # A second signal in the SAME tick now sees the reduced capital.
    service.reserve({"1": {"final_shares": 100, "name": "Main"}}, entry_price=100.0)
    assert service.available(1) == 70000.0
    # Zero-share and unknown accounts are ignored safely.
    service.reserve({"1": {"final_shares": 0}, "99": {"final_shares": 10}}, entry_price=10.0)
    assert service.available(1) == 70000.0
