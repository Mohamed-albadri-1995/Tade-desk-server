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
    GradeMultiplierModel,
    GradeScoringModelModel,
    SetupFactorModelModel,
    UserSettingsModel,
)
from app.routers import (
    accounts,
    analytics,
    brokers,
    conditions,
    journal,
    monitor as monitor_router,
    settings as settings_router,
    setup_factor,
    setups,
    watchlist,
)
from app.services.setup_factor import DEFAULT_FACTOR_MAP, DEFAULT_SIGNALS
from app.services.monitor import MARKET_TZ, monitor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("trade-desk")

DEFAULT_GRADE_MULTIPLIERS = {"A+": 1.5, "A": 1.25, "B": 1.0, "C": 0.75, "D": 0.5}

scheduler = AsyncIOScheduler(timezone=MARKET_TZ)


async def seed_defaults() -> None:
    async with async_session_factory() as session:
        settings_row = (
            await session.execute(select(UserSettingsModel).where(UserSettingsModel.id == 1))
        ).scalar_one_or_none()
        if settings_row is None:
            session.add(UserSettingsModel(id=1))
        existing = {
            g.grade
            for g in (await session.execute(select(GradeMultiplierModel))).scalars().all()
        }
        for grade, multiplier in DEFAULT_GRADE_MULTIPLIERS.items():
            if grade not in existing:
                session.add(GradeMultiplierModel(grade=grade, multiplier=multiplier))
        grading_row = (
            await session.execute(
                select(GradeScoringModelModel).where(GradeScoringModelModel.id == 1)
            )
        ).scalar_one_or_none()
        if grading_row is None:
            session.add(GradeScoringModelModel(id=1))
        factor_row = (
            await session.execute(
                select(SetupFactorModelModel).where(SetupFactorModelModel.id == 1)
            )
        ).scalar_one_or_none()
        if factor_row is None:
            session.add(
                SetupFactorModelModel(
                    id=1, signals=dict(DEFAULT_SIGNALS), factor_map=dict(DEFAULT_FACTOR_MAP)
                )
            )
        has_accounts = (await session.execute(select(AccountModel))).scalars().first()
        if has_accounts is None:
            size = settings_row.account_size if settings_row else 100000.0
            session.add(
                AccountModel(name="Main", account_size=size, is_primary=True, is_active=True)
            )
        await session.commit()
    await monitor.grade_engine.refresh()
    await monitor.setup_factor_engine.refresh_model()
    await monitor.setup_factor_engine.recompute_all()


async def session_start_job() -> None:
    """Daily at session start: re-arm signals and (re)start the feeds."""
    logger.info("session start — re-arming signals and restarting feeds")
    monitor.reset_signals()
    await monitor.setup_factor_engine.recompute_all()
    await monitor.start()


def schedule_session_start() -> None:
    try:
        hour, minute = (int(x) for x in monitor.session_start_time.split(":"))
    except ValueError:
        hour, minute = 9, 35
    scheduler.add_job(
        session_start_job,
        CronTrigger(day_of_week="mon-fri", hour=hour, minute=minute),
        id="session-start",
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

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse("static/index.html")
