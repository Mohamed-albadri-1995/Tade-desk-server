"""Per-side setup factor, session window, and screener watchlist sync."""

from datetime import datetime
from zoneinfo import ZoneInfo

from app.services.monitor import MonitorService
from app.services.setup_factor import NEUTRAL_STATE, SetupFactorEngine

from tests.test_setup_factor import make_trades


def test_side_states_computed_separately():
    engine = SetupFactorEngine()
    trades = make_trades([1.5] * 10) + [
        t for t in make_trades([-1.5] * 10)
    ]
    for t in trades[10:]:
        t.signal_side = "short"
    # emulate recompute grouping
    pooled = engine.compute_state(trades)
    longs = engine.compute_state([t for t in trades if t.signal_side == "long"])
    shorts = engine.compute_state([t for t in trades if t.signal_side == "short"])
    engine._states = {
        (1, "pooled"): {**pooled, "side": "pooled"},
        (1, "long"): {**longs, "side": "long"},
        (1, "short"): {**shorts, "side": "short"},
    }
    # long side profitable, short side toxic — factors must differ
    assert engine.get_state(1, "long")["final_factor"] > 1.0
    assert engine.get_state(1, "short")["final_factor"] < 1.0
    assert engine.get_state(1, "long")["side_used"] == "long"


def test_side_fallback_to_pooled_when_thin():
    engine = SetupFactorEngine()
    pooled = engine.compute_state(make_trades([1.0] * 20))
    thin_short = engine.compute_state(make_trades([1.0] * 2))  # below hard floor
    engine._states = {
        (1, "pooled"): {**pooled, "side": "pooled"},
        (1, "short"): {**thin_short, "side": "short"},
    }
    state = engine.get_state(1, "short")
    assert state["side_used"] == "pooled"  # too few short trades -> pooled
    assert state["final_factor"] == pooled["final_factor"]


def test_split_off_uses_pooled():
    engine = SetupFactorEngine()
    engine.model["split_by_side"] = False
    pooled = engine.compute_state(make_trades([1.0] * 20))
    engine._states = {
        (1, "pooled"): {**pooled, "side": "pooled"},
        (1, "long"): {**dict(NEUTRAL_STATE), "side": "long", "final_factor": 99.0},
    }
    assert engine.get_state(1, "long")["side_used"] == "pooled"


def test_session_window_open_and_closed():
    service = MonitorService()
    now = datetime.now(ZoneInfo("America/New_York"))
    # Window spanning right now -> open
    service.session_start_time = "00:00"
    service.session_end_time = "23:59"
    assert service._session_open() is True
    # Window fully in the past (or future) relative to now -> closed
    hh = f"{(now.hour + 2) % 24:02d}"
    service.session_start_time = f"{hh}:00"
    service.session_end_time = f"{hh}:01"
    assert service._session_open() is False


def test_default_entry_window_is_935_to_10():
    service = MonitorService()
    assert service.session_start_time == "09:35"
    assert service.session_end_time == "10:00"


import pytest

pytestmark_async = pytest.mark.asyncio


@pytest.mark.asyncio
async def test_shortlist_watchlist_sync():
    service = MonitorService()
    service.watchlist_source = "shortlist"
    service.screener_service.shortlist = ["NVDA", "SDOT"]

    started_with, stopped = [], []

    async def fake_start(symbols):
        started_with.append(sorted(symbols))
        service.market_service._symbols = sorted(symbols)

    async def fake_stop():
        stopped.append(True)
        service.market_service._symbols = []

    service.market_service.start = fake_start
    service.market_service.stop = fake_stop

    await service._sync_screener_watchlist()
    assert started_with == [["NVDA", "SDOT"]]

    # Star another ticker in the screener -> picked up on the next sync.
    service.screener_service.shortlist = ["NVDA", "SDOT", "TSLA"]
    await service._sync_screener_watchlist()
    assert started_with[-1] == ["NVDA", "SDOT", "TSLA"]

    # Clearing the shortlist stops the market feed.
    service.screener_service.shortlist = []
    await service._sync_screener_watchlist()
    assert stopped == [True]


@pytest.mark.asyncio
async def test_screener_watchlist_sync():
    from app.services.screener_data import TickerContext

    service = MonitorService()
    service.watchlist_source = "registry"
    service.screener_cache["NVDA"] = TickerContext(stock="NVDA")
    service.screener_cache["AMD"] = TickerContext(stock="AMD")

    started_with = []

    async def fake_start(symbols):
        started_with.append(sorted(symbols))

    service.market_service.start = fake_start
    await service._sync_screener_watchlist()
    assert started_with == [["AMD", "NVDA"]]

    # No change -> no restart. (fake_start didn't update _symbols, so patch it.)
    service.market_service._symbols = ["AMD", "NVDA"]
    await service._sync_screener_watchlist()
    assert len(started_with) == 1

    # Manual mode never syncs.
    service.watchlist_source = "manual"
    service.screener_cache["TSLA"] = TickerContext(stock="TSLA")
    await service._sync_screener_watchlist()
    assert len(started_with) == 1
