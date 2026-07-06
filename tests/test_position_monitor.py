"""Automatic position monitoring — SL/TP auto-close from cached bars."""

from datetime import datetime

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.database import async_session_factory, init_db
from app.models import JournalModel
from app.services.monitor import MonitorService

pytestmark = pytest.mark.asyncio


def bar(high, low, close):
    return {
        "timestamp": datetime.utcnow().isoformat(),
        "open": close, "high": high, "low": low, "close": close, "volume": 100,
    }


@pytest_asyncio.fixture()
async def service():
    await init_db()
    return MonitorService()


async def open_entry(stock="POSM", side="long", sl=98.0, tp=106.0, shares=10):
    async with async_session_factory() as session:
        entry = JournalModel(
            stock=stock, setup_id=99, signal_side=side, status="alerted",
            entry_signal_time=datetime.utcnow(), entry_price=100.0,
            entry_sl_price=sl, entry_tp_price=tp, entry_shares=shares,
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
        return entry.id


async def fetch(journal_id):
    async with async_session_factory() as session:
        return (
            await session.execute(select(JournalModel).where(JournalModel.id == journal_id))
        ).scalar_one()


async def test_long_stop_loss_hit(service):
    journal_id = await open_entry(stock="POS1")
    service.market_cache["POS1"] = {"bars": [bar(101, 97.5, 98.2)], "price": 98.2}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.status == "closed"
    assert entry.exit_reason == "stop_loss"
    assert entry.exit_price == 98.0
    assert entry.exit_pnl == -20.0  # (98-100) * 10
    assert entry.r_multiple == -1.0


async def test_long_take_profit_hit(service):
    journal_id = await open_entry(stock="POS2")
    service.market_cache["POS2"] = {"bars": [bar(106.5, 103.0, 105.9)], "price": 105.9}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.exit_reason == "take_profit"
    assert entry.exit_price == 106.0
    assert entry.exit_pnl == 60.0
    assert entry.r_multiple == 3.0


async def test_both_hit_same_bar_stop_wins(service):
    journal_id = await open_entry(stock="POS3")
    service.market_cache["POS3"] = {"bars": [bar(107.0, 97.0, 100.0)], "price": 100.0}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.exit_reason == "stop_loss"  # conservative


async def test_short_side(service):
    journal_id = await open_entry(stock="POS4", side="short", sl=102.0, tp=94.0)
    service.market_cache["POS4"] = {"bars": [bar(101.0, 93.5, 94.2)], "price": 94.2}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.exit_reason == "take_profit"
    assert entry.exit_price == 94.0
    assert entry.exit_pnl == 60.0  # (100-94) * 10


async def test_untouched_position_stays_open(service):
    journal_id = await open_entry(stock="POS5")
    service.market_cache["POS5"] = {"bars": [bar(103.0, 99.0, 102.0)], "price": 102.0}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.status == "alerted"
    assert entry.exit_pnl is None
