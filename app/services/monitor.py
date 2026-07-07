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
from app.models import (
    ConditionModel,
    JournalModel,
    SetupModel,
    UserSettingsModel,
    WatchlistModel,
)
from app.services.broker_engine import BrokerEngine
from app.services.capital import OPEN_STATUSES, CapitalService
from app.services.condition_engine import ConditionEngine
from app.services.event_bus import event_bus
from app.services.gate_engine import GateEngine
from app.services.grade_engine import GradeEngine
from app.services.journal_service import JournalService, journal_to_dict
from app.services.market_data import MarketDataService
from app.services.market_proxy import MarketDataProxy
from app.services.screener_data import ScreenerDataService
from app.services.setup_engine import SetupEngine
from app.services.setup_factor import SetupFactorEngine
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
        self.setup_factor_engine = SetupFactorEngine()
        self.capital_service = CapitalService()
        self.broker_engine = BrokerEngine()
        self.journal_service = JournalService()

        self.session_start_time = "09:35"
        self.session_end_time = "10:00"  # last new entry; positions monitored regardless
        self.watchlist_source = "screener"  # 'screener' (auto) | 'manual' (uploads)
        self.market_refresh_interval = 5

        self._task: Optional[asyncio.Task] = None
        self._armed: Dict[tuple, Optional[str]] = {}  # (stock, setup_id) -> fired side
        self._statuses: Dict[tuple, str] = {}  # (stock, setup_id, condition) -> status
        self._published: Dict[tuple, object] = {}  # last mandatory/raw values sent (WS dedupe)

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        await self.stop()
        await self._load_settings()
        # 'screener' mode: symbols come from the screener registry and are
        # synced automatically each tick; 'manual' mode uses uploads.
        symbols = [] if self.watchlist_source == "screener" else await self._load_watchlist()
        await self.market_service.start(symbols)
        await self.screener_service.start(symbols)
        await self.capital_service.start()
        await self.setup_factor_engine.load_states()
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
        await self.capital_service.stop()

    async def restart(self) -> None:
        await self.start()

    def reset_signals(self) -> None:
        """Re-arm all signals (called daily at session start)."""
        self._armed.clear()
        self._statuses.clear()
        self._published.clear()

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
            "session_end_time": self.session_end_time,
            "session_open": self._session_open(),
            "watchlist_source": self.watchlist_source,
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
            self.session_end_time = row.session_end_time
            self.watchlist_source = row.watchlist_source
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

    @staticmethod
    def _parse_hhmm(value: str, fallback: tuple) -> tuple:
        try:
            hour, minute = (int(x) for x in value.split(":"))
            return (hour, minute)
        except (ValueError, AttributeError):
            return fallback

    def _session_open(self) -> bool:
        """New entries are evaluated only inside [start, end] ET —
        the session starts and stops automatically."""
        start = self._parse_hhmm(self.session_start_time, (9, 35))
        end = self._parse_hhmm(self.session_end_time, (10, 0))
        now = datetime.now(MARKET_TZ)
        return start <= (now.hour, now.minute) <= end

    # ------------------------------------------------------------ main loop

    async def _run(self) -> None:
        while True:
            try:
                await self._tick()
            except Exception:
                logger.exception("monitor tick failed")
            await asyncio.sleep(self.market_refresh_interval)

    async def _tick(self) -> None:
        # Open positions are watched whenever data flows, even outside the
        # session window — an overnight position still needs its stop.
        await self._monitor_positions()
        await self._sync_screener_watchlist()
        if not self._session_open():
            return
        # Refresh DB-backed caches so signal-time lookups are pure memory reads.
        await self.gate_engine.refresh_rules()
        await self.sizer_engine.refresh()
        await self.grade_engine.refresh()
        await self.capital_service.refresh()

        setups = await self._load_active_setups()
        conditions = await self._load_active_conditions()
        # The condition->setup association doesn't depend on the stock, so
        # build the map once per tick, not once per (stock, setup).
        conditions_by_setup = {
            setup.id: [c for c in conditions if setup.id in (c.associated_setups or [])]
            for setup in setups
        }

        for stock in list(self.market_cache):
            for setup in setups:
                await self._evaluate_pair(stock, setup, conditions_by_setup[setup.id])

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

        # Live mandatory ✅/❌ updates — published only when the value changed
        # so a large watchlist doesn't flood the WebSocket every tick.
        for name, passed in (evaluation["mandatory_results"] or {}).items():
            key = ("mandatory", stock, setup.id, name)
            if self._published.get(key) != bool(passed):
                self._published[key] = bool(passed)
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
            key = ("raw", stock, setup.id, condition.name)
            if values and self._published.get(key) != values:
                self._published[key] = values
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

    async def _sync_screener_watchlist(self) -> None:
        """In 'screener' mode the watchlist is whatever the screener
        registry currently holds; restart the market feed when it changes."""
        if self.watchlist_source != "screener":
            return
        screener_symbols = sorted(self.screener_cache.keys())
        if not screener_symbols:
            return
        if set(screener_symbols) != set(self.market_service.symbols):
            logger.info("screener watchlist changed -> %d symbols", len(screener_symbols))
            await self.market_service.start(screener_symbols)

    # ------------------------------------------------ position monitoring

    async def _monitor_positions(self) -> None:
        """Auto-close open positions whose SL or TP was touched by the
        latest cached bar (step 10 of the pipeline: fill the exit
        snapshot). Fill assumption is the level itself; if a bar touches
        both SL and TP, the stop wins (conservative)."""
        async with async_session_factory() as session:
            open_entries = (
                await session.execute(
                    select(JournalModel).where(
                        JournalModel.status.in_(OPEN_STATUSES),
                        JournalModel.exit_pnl == None,  # noqa: E711
                    )
                )
            ).scalars().all()

        closed_setups = []
        for entry in open_entries:
            cache = self.market_cache.get(entry.stock)
            if not cache or not cache.get("bars"):
                continue
            last_bar = cache["bars"][-1]
            high, low = float(last_bar["high"]), float(last_bar["low"])
            sl, tp = entry.entry_sl_price, entry.entry_tp_price

            exit_price = reason = None
            if entry.signal_side == "long":
                if sl is not None and low <= sl:
                    exit_price, reason = sl, "stop_loss"
                elif tp is not None and high >= tp:
                    exit_price, reason = tp, "take_profit"
            else:  # short
                if sl is not None and high >= sl:
                    exit_price, reason = sl, "stop_loss"
                elif tp is not None and low <= tp:
                    exit_price, reason = tp, "take_profit"
            if reason is None:
                continue

            closed = await self.journal_service.update_exit_card(
                entry.id,
                {"exit_price": float(exit_price), "exit_reason": reason},
                bars=cache["bars"],
            )
            closed_setups.append(closed.setup_id)
            data = journal_to_dict(closed)
            await event_bus.publish({"type": "new_entry", "entry": data})
            await event_bus.publish(
                {
                    "type": "position_closed",
                    "position": {
                        "journal_id": closed.id,
                        "stock": closed.stock,
                        "setup_id": closed.setup_id,
                        "side": closed.signal_side,
                        "reason": reason,
                        "exit_price": closed.exit_price,
                        "exit_pnl": closed.exit_pnl,
                        "r_multiple": closed.r_multiple,
                        "time": closed.exit_time.isoformat() if closed.exit_time else None,
                    },
                }
            )
            logger.info(
                "auto-closed %s #%s via %s at %.4f",
                closed.stock, closed.id, reason, float(exit_price),
            )

        if closed_setups:
            for setup_id in set(closed_setups):
                await self.setup_factor_engine.recompute_all(setup_id=setup_id)
            await self.capital_service.refresh()

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

        # Step 6: grading first (the sizer consumes the grade multiplier).
        # The grade comes from the signal-points model over default +
        # additional results; mandatory conditions are excluded.
        grading = self.grade_engine.evaluate_detailed(default_results, additional_results)
        grade, grade_score = grading["grade"], grading["score"]

        # Step 7: sizing — per account, with the setup factor and the
        # at-the-moment capital cap. All inputs are cached (zero I/O).
        setup_factor_state = self.setup_factor_engine.get_state(setup.id, signal_side)
        setup_factor = float(setup_factor_state["final_factor"])
        regime_key = str(screener_snapshot.get("regime") or "")
        sl_for_risk = sl_price if sl_price is not None else entry_price
        # One sizing path for every card shape: with no accounts configured
        # a synthetic account built from the global settings stands in, so
        # entry_factors.accounts is always present and identical in form.
        accounts = self.capital_service.accounts or [
            {
                "id": 0,
                "name": "default",
                "account_size": self.sizer_engine.account_size,
                "risk_per_trade": None,
                "broker_id": None,
                "is_primary": True,
            }
        ]
        sizing = self.sizer_engine.calculate_multi(
            entry_price,
            sl_for_risk,
            grade,
            regime_key,
            setup_factor,
            accounts,
            self.capital_service.available,
        )

        card_data["entry_shares"] = sizing["final_shares"]
        card_data["entry_factors"] = {
            **sizing["factors"],
            "grade_score": grade_score,
            "grade_raw_points": grading["raw_points"],
            "grade_breakdown": grading["breakdown"],
            "setup_factor": setup_factor,
            "setup_factor_state": setup_factor_state,
            "accounts": sizing["accounts"],
        }
        card_data["entry_grade"] = grade

        # A setup factor of 0 blocks the trade: the card is still written
        # (full audit trail) but no alert is dispatched.
        if setup_factor <= 0.0:
            card_data["status"] = "blocked_by_setup_factor"
            entry = await self.journal_service.create_entry_card(card_data)
            await event_bus.publish({"type": "new_entry", "entry": journal_to_dict(entry)})
            return journal_to_dict(entry)

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
