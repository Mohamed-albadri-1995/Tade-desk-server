"""MonitorService — orchestrates the continuous evaluation loop and the
exact signal pipeline (spec section 4).

Every market refresh tick, each (stock, active setup) pair is evaluated:

* mandatory conditions -> ``mandatory_update`` WebSocket events
* default/additional conditions -> ``raw_display`` events and
  '⏳ unknown' status until a signal fires
* on signal: the 10-step pipeline runs entirely from cached data
  (zero-latency guarantee) and publishes ``signal_fire``,
  ``status_change``, ``new_entry`` and ``new_alert`` events.

A signal for a (stock, setup) pair fires once and re-arms only after the
setup script stops reporting that side (and daily at session start).
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.database import async_session_factory
from app.models import ConditionModel, SetupModel, UserSettingsModel, WatchlistModel
from app.services.broker_engine import BrokerEngine
from app.services.condition_engine import ConditionEngine
from app.services.event_bus import event_bus
from app.services.gate_engine import GateEngine
from app.services.grade_engine import GradeEngine
from app.services.journal_service import JournalService, journal_to_dict
from app.services.market_data import MarketDataService
from app.services.market_proxy import MarketDataProxy
from app.services.screener_data import ScreenerDataService
from app.services.setup_engine import SetupEngine
from app.services.sizer_engine import SizerEngine

logger = logging.getLogger(__name__)

MARKET_TZ = ZoneInfo("America/New_York")


class MonitorService:
    def __init__(self):
        self.market_cache: Dict[str, dict] = {}
        self.screener_cache: Dict[str, object] = {}

        self.market_service = MarketDataService(self.market_cache)
        self.screener_service = ScreenerDataService(self.screener_cache)
        self.market_data = MarketDataProxy(self.market_cache)

        self.setup_engine = SetupEngine(self.market_data)
        self.condition_engine = ConditionEngine(self.market_data)
        self.gate_engine = GateEngine(self.screener_cache)
        self.sizer_engine = SizerEngine()
        self.grade_engine = GradeEngine()
        self.broker_engine = BrokerEngine()
        self.journal_service = JournalService()

        self.session_start_time = "09:35"
        self.market_refresh_interval = 5

        self._task: Optional[asyncio.Task] = None
        self._armed: Dict[tuple, Optional[str]] = {}  # (stock, setup_id) -> fired side
        self._statuses: Dict[tuple, str] = {}  # (stock, setup_id, condition) -> status

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        await self.stop()
        symbols = await self._load_watchlist()
        await self._load_settings()
        await self.market_service.start(symbols)
        await self.screener_service.start(symbols)
        self._task = asyncio.create_task(self._run(), name="monitor-loop")
        logger.info("MonitorService started for %d symbols", len(symbols))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self.market_service.stop()
        await self.screener_service.stop()

    async def restart(self) -> None:
        await self.start()

    def reset_signals(self) -> None:
        """Re-arm all signals (called daily at session start)."""
        self._armed.clear()
        self._statuses.clear()

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict:
        return {
            "monitor_running": self.running,
            "market_data_running": self.market_service.running,
            "screener_running": self.screener_service.running,
            "symbols_cached": sorted(self.market_cache.keys()),
            "screener_cached": sorted(self.screener_cache.keys()),
            "session_start_time": self.session_start_time,
        }

    # -------------------------------------------------------------- loaders

    async def _load_watchlist(self) -> List[str]:
        async with async_session_factory() as session:
            row = (
                await session.execute(
                    select(WatchlistModel).order_by(WatchlistModel.uploaded_at.desc())
                )
            ).scalars().first()
            return list(row.symbols) if row else []

    async def _load_settings(self) -> None:
        async with async_session_factory() as session:
            row = (
                await session.execute(select(UserSettingsModel).where(UserSettingsModel.id == 1))
            ).scalar_one_or_none()
        if row:
            self.session_start_time = row.session_start_time
            self.market_refresh_interval = row.market_refresh_interval
            self.market_service.refresh_interval = row.market_refresh_interval
            self.market_service.lookback_bars = row.ohlcv_lookback_bars
            self.screener_service.refresh_interval = row.screener_refresh_interval

    async def _load_active_setups(self) -> List[SetupModel]:
        async with async_session_factory() as session:
            result = await session.execute(select(SetupModel).where(SetupModel.is_active == True))  # noqa: E712
            return list(result.scalars().all())

    async def _load_active_conditions(self) -> List[ConditionModel]:
        async with async_session_factory() as session:
            result = await session.execute(
                select(ConditionModel).where(ConditionModel.is_active == True)  # noqa: E712
            )
            return list(result.scalars().all())

    def _session_open(self) -> bool:
        try:
            hour, minute = (int(x) for x in self.session_start_time.split(":"))
        except ValueError:
            hour, minute = 9, 35
        now = datetime.now(MARKET_TZ)
        return (now.hour, now.minute) >= (hour, minute)

    # ------------------------------------------------------------ main loop

    async def _run(self) -> None:
        while True:
            try:
                await self._tick()
            except Exception:
                logger.exception("monitor tick failed")
            await asyncio.sleep(self.market_refresh_interval)

    async def _tick(self) -> None:
        if not self._session_open():
            return
        # Refresh DB-backed caches so signal-time lookups are pure memory reads.
        await self.gate_engine.refresh_rules()
        await self.sizer_engine.refresh()

        setups = await self._load_active_setups()
        conditions = await self._load_active_conditions()
        symbols = [s for s in self.market_cache.keys()]

        for stock in symbols:
            for setup in setups:
                setup_conditions = [
                    c for c in conditions if setup.id in (c.associated_setups or [])
                ]
                await self._evaluate_pair(stock, setup, setup_conditions)

    async def _publish_status(self, stock: str, setup_id: int, condition: str, status: str) -> None:
        key = (stock, setup_id, condition)
        if self._statuses.get(key) == status:
            return
        self._statuses[key] = status
        await event_bus.publish(
            {
                "type": "status_change",
                "stock": stock,
                "setup_id": setup_id,
                "condition": condition,
                "status": status,
            }
        )

    async def _evaluate_pair(
        self, stock: str, setup: SetupModel, conditions: List[ConditionModel]
    ) -> None:
        now = datetime.utcnow()
        evaluation = self.setup_engine.evaluate(stock, setup, now)
        if evaluation.get("error"):
            return

        # Live mandatory ✅/❌ updates.
        for name, passed in (evaluation["mandatory_results"] or {}).items():
            await event_bus.publish(
                {
                    "type": "mandatory_update",
                    "stock": stock,
                    "setup_id": setup.id,
                    "condition": name,
                    "passed": bool(passed),
                }
            )

        # Raw values + unknown status for default/additional conditions.
        for condition in conditions:
            values = self.condition_engine.get_raw_display(condition, stock, now)
            if values:
                await event_bus.publish(
                    {
                        "type": "raw_display",
                        "stock": stock,
                        "setup_id": setup.id,
                        "condition": condition.name,
                        "values": values,
                    }
                )
            key = (stock, setup.id, condition.name)
            if key not in self._statuses:
                await self._publish_status(stock, setup.id, condition.name, "unknown")

        signal_side = evaluation.get("signal_side")
        armed_key = (stock, setup.id)
        if signal_side is None:
            # Side cleared -> re-arm and reset condition statuses to unknown.
            if self._armed.get(armed_key):
                self._armed[armed_key] = None
                for condition in conditions:
                    await self._publish_status(stock, setup.id, condition.name, "unknown")
            return

        if self._armed.get(armed_key) == signal_side:
            return  # already fired for this persisting signal

        self._armed[armed_key] = signal_side
        await self.run_signal_pipeline(stock, setup, conditions, evaluation)

    # ------------------------------------------------- signal pipeline (§4)

    async def run_signal_pipeline(
        self,
        stock: str,
        setup: SetupModel,
        conditions: List[ConditionModel],
        evaluation: dict,
    ) -> Optional[dict]:
        # Step 1 happened in the caller: signal_side != None.
        signal_side = evaluation["signal_side"]

        # Step 2: record signal time.
        signal_time = datetime.utcnow()
        await event_bus.publish(
            {
                "type": "signal_fire",
                "stock": stock,
                "setup_id": setup.id,
                "side": signal_side,
                "time": signal_time.isoformat(),
            }
        )

        # Step 3: evaluate all default & additional conditions with signal_side.
        default_results: Dict[str, bool] = {}
        additional_results: Dict[str, bool] = {}
        for condition in conditions:
            aligned = self.condition_engine.evaluate_alignment(
                condition, stock, signal_time, signal_side
            )
            bucket = default_results if condition.type == "default" else additional_results
            bucket[condition.name] = aligned
            await self._publish_status(
                stock, setup.id, condition.name, "aligned" if aligned else "not_aligned"
            )

        # Step 4: entry / SL / TP prices (cached data only — no network calls).
        entry_method, script_price = ("market", None)
        if evaluation.get("entry_params"):
            entry_method, script_price = evaluation["entry_params"]
        if script_price is not None:
            entry_price = float(script_price)
        elif setup.entry_price is not None and (setup.entry_method or "market") != "market":
            entry_price = float(setup.entry_price)
        else:
            try:
                entry_price = self.market_data.get_current_price(stock)
            except KeyError:
                logger.warning("no cached price for %s at signal time", stock)
                return None
        sl_tp = evaluation.get("sl_tp") or setup.sl_tp or (None, None)
        sl_price = float(sl_tp[0]) if sl_tp and sl_tp[0] is not None else None
        tp_price = float(sl_tp[1]) if sl_tp and len(sl_tp) > 1 and sl_tp[1] is not None else None

        card_data = {
            "stock": stock,
            "setup_id": setup.id,
            "signal_side": signal_side,
            "entry_signal_time": signal_time,
            "entry_mandatory_results": evaluation["mandatory_results"] or {},
            "entry_default_results": default_results,
            "entry_additional_results": additional_results,
            "entry_price": entry_price,
            "entry_sl_price": sl_price,
            "entry_tp_price": tp_price,
        }

        # Step 5: gate check — rejected cards are journaled, then STOP.
        allowed, screener_snapshot = self.gate_engine.is_allowed(stock, signal_side)
        card_data["entry_gate_allowed"] = allowed
        card_data["entry_gate_screener_snapshot"] = screener_snapshot
        if not allowed:
            card_data["status"] = "rejected"
            entry = await self.journal_service.create_entry_card(card_data)
            await event_bus.publish({"type": "new_entry", "entry": journal_to_dict(entry)})
            return journal_to_dict(entry)

        # Steps 6 & 7: sizing and grading. GradeEngine is the placeholder
        # ('B', 1.0); its grade feeds the sizer's grade multiplier.
        grade, grade_score = self.grade_engine.evaluate(
            evaluation["mandatory_results"] or {}, default_results, additional_results
        )
        regime_key = str(screener_snapshot.get("regime") or "")
        sizing = self.sizer_engine.calculate(
            entry_price, sl_price if sl_price is not None else entry_price, grade, regime_key
        )
        card_data["entry_shares"] = sizing["final_shares"]
        card_data["entry_factors"] = {**sizing["factors"], "grade_score": grade_score}
        card_data["entry_grade"] = grade

        # Step 8: write the immutable Entry Card.
        card_data["status"] = "pending"
        entry = await self.journal_service.create_entry_card(card_data)
        await event_bus.publish({"type": "new_entry", "entry": journal_to_dict(entry)})

        # Step 9: dispatch broker alerts and mark as alerted.
        dispatch_results = await self.broker_engine.dispatch(entry)
        await self.journal_service.set_status(entry.id, "alerted")
        entry.status = "alerted"
        await event_bus.publish(
            {
                "type": "new_alert",
                "alert": {
                    "journal_id": entry.id,
                    "stock": stock,
                    "setup_id": setup.id,
                    "side": signal_side,
                    "shares": entry.entry_shares,
                    "entry_price": entry.entry_price,
                    "sl_price": entry.entry_sl_price,
                    "tp_price": entry.entry_tp_price,
                    "grade": grade,
                    "time": signal_time.isoformat(),
                    "dispatch": dispatch_results,
                },
            }
        )

        # Step 10: monitoring continues; the exit snapshot is filled later
        # via JournalService.update_exit_card.
        return journal_to_dict(entry)


monitor = MonitorService()
