"""Trade Desk trading tool — FastAPI application entry point.

Run: uvicorn main:app --host 0.0.0.0 --port 8000
"""

import logging
from contextlib import asynccontextmanager

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from app.database import async_session_factory, init_db
from app.models import (
    AccountModel,
    BrokerModel,
    LearningConfigModel,
    RegimeGateModel,
    UserSettingsModel,
)
from app.routers import (
    accounts,
    analytics,
    brokers,
    conditions,
    journal,
    learning as learning_router,
    monitor as monitor_router,
    settings as settings_router,
    setup_factor,
    setups,
    watchlist,
)
from app.services.learning import backfill_alignments
from app.services.monitor import MARKET_TZ, monitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("trade-desk")

# qp_loader runs at import (before basicConfig), so restate the confirmation
# here with the app's formatter — this is the boot-log line to look for.
_qp = __import__("qp")
from app import qp_loader  # noqa: E402

logger.info(
    "VERIFIED qp library loaded from %s — %d approved primitives",
    qp_loader.QP_DIR, len(_qp.approved_primitives()),
)

# The screener's 15 regime slugs (src/sideD/regime.js REGIME_CATALOG).
REGIME_KEYS = [
    "STRONG_UP", "EXTENDED_UP", "UP", "WEAK_UP", "PULLBACK_BULL",
    "CHOP_BULL", "CORRECTION", "RECOVERY", "BASING", "TOPPING",
    "CHOP_BEAR", "BEAR_RALLY", "DOWN", "STRONG_DOWN", "CAPITULATION",
]

scheduler = AsyncIOScheduler(timezone=MARKET_TZ)


async def seed_defaults() -> None:
    async with async_session_factory() as session:
        settings_row = (
            await session.execute(select(UserSettingsModel).where(UserSettingsModel.id == 1))
        ).scalar_one_or_none()
        if settings_row is None:
            session.add(UserSettingsModel(id=1))
        learning_row = (
            await session.execute(select(LearningConfigModel).where(LearningConfigModel.id == 1))
        ).scalar_one_or_none()
        if learning_row is None:
            session.add(LearningConfigModel(id=1))
        existing_regimes = {
            g.regime_key
            for g in (await session.execute(select(RegimeGateModel))).scalars().all()
        }
        for key in REGIME_KEYS:
            if key not in existing_regimes:
                session.add(RegimeGateModel(regime_key=key, allow_long=True, allow_short=True))
        has_accounts = (await session.execute(select(AccountModel))).scalars().first()
        if has_accounts is None:
            size = settings_row.account_size if settings_row else 100000.0
            session.add(
                AccountModel(name="Main", account_size=size, is_primary=True, is_active=True)
            )
        has_brokers = (await session.execute(select(BrokerModel))).scalars().first()
        if has_brokers is None:
            # The always-on baseline: a paper broker at the standard size.
            # The journal is its fill record — this is the clean track the
            # learning engine trains on.
            session.add(
                BrokerModel(type="paper", name="Paper (standard ×1)", scale=1.0,
                            exit_mode="at_exit", is_active=True)
            )
        await session.commit()
    await backfill_alignments()
    await monitor.setup_factor_engine.recompute_all()


async def learning_job() -> None:
    """Nightly (20:00 ET): retrain all (setup, side) models from the journal."""
    logger.info("nightly learning run starting")
    try:
        result = await monitor.learning_engine.run_learning()
        monitor.setup_factor_engine.min_trades = monitor.learning_engine.min_trades
        await monitor.setup_factor_engine.recompute_all()
        logger.info("nightly learning done: %s trained", len(result["trained"]))
    except Exception:
        logger.exception("nightly learning run failed")


async def session_start_job() -> None:
    """Daily at session start: re-arm signals and (re)start the feeds."""
    logger.info("session start — re-arming signals and restarting feeds")
    monitor.reset_signals()
    await monitor.setup_factor_engine.recompute_all()
    await monitor.start()


def schedule_session_start() -> None:
    hour, minute = monitor._parse_hhmm(monitor.session_start_time, (9, 35))
    scheduler.add_job(
        session_start_job,
        CronTrigger(day_of_week="mon-fri", hour=hour, minute=minute),
        id="session-start",
        replace_existing=True,
    )
    scheduler.add_job(
        learning_job,
        CronTrigger(day_of_week="mon-fri", hour=20, minute=0),  # 20:00 ET, after close
        id="nightly-learning",
        replace_existing=True,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await seed_defaults()
    # Continuous data feed from session start: services run immediately;
    # the monitor loop itself only evaluates once the session is open.
    await monitor.start()
    schedule_session_start()
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)
    await monitor.stop()


app = FastAPI(title="Trade Desk", version="1.0.0", lifespan=lifespan)

app.include_router(setups.router)
app.include_router(conditions.router)
app.include_router(watchlist.router)
app.include_router(journal.router)
app.include_router(brokers.router)
app.include_router(settings_router.router)
app.include_router(monitor_router.router)
app.include_router(analytics.router)
app.include_router(accounts.router)
app.include_router(setup_factor.router)
app.include_router(learning_router.router)

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse("static/index.html")
