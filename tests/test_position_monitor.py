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
    svc = MonitorService()
    # Keep the entry window open for the SL/TP tests so the session-end
    # time-stop doesn't interfere; the time-stop tests close it explicitly.
    svc.session_start_time = "00:00"
    svc.session_end_time = "23:59"
    return svc


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


async def _make_setup(setup_id, close_at_session_end):
    from app.models import SetupModel

    async with async_session_factory() as session:
        session.add(
            SetupModel(
                id=setup_id, name=f"s{setup_id}", script_content="x=1",
                close_at_session_end=close_at_session_end,
            )
        )
        await session.commit()


async def test_session_end_time_stop_closes_position(service):
    await _make_setup(201, close_at_session_end=True)
    journal_id = await open_entry(stock="POS6")
    async with async_session_factory() as session:
        entry = await session.get(JournalModel, journal_id)
        entry.setup_id = 201
        await session.commit()
    service.session_start_time = "00:00"
    service.session_end_time = "00:01"  # window long over
    service.market_cache["POS6"] = {"bars": [bar(103.0, 99.0, 102.0)], "price": 102.0}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.status == "closed"
    assert entry.exit_reason == "session_end"
    assert entry.exit_price == 102.0  # current cached price
    assert entry.exit_pnl == 20.0


async def test_session_end_hold_when_setup_says_no(service):
    await _make_setup(202, close_at_session_end=False)
    journal_id = await open_entry(stock="POS7")
    async with async_session_factory() as session:
        entry = await session.get(JournalModel, journal_id)
        entry.setup_id = 202
        await session.commit()
    service.session_start_time = "00:00"
    service.session_end_time = "00:01"
    service.market_cache["POS7"] = {"bars": [bar(103.0, 99.0, 102.0)], "price": 102.0}
    await service._monitor_positions()
    entry = await fetch(journal_id)
    assert entry.status == "alerted"  # held: SL/TP still governs
    assert entry.exit_pnl is None
