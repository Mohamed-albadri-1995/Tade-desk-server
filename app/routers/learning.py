"""Learning engine API: status, manual trigger, config, and the
simplified per-regime gate toggles."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import LearningConfigModel, RegimeGateModel, SetupModel
from app.services.monitor import monitor

router = APIRouter(prefix="/api", tags=["learning"])


class LearningConfigUpdate(BaseModel):
    min_trades: Optional[int] = None


class RegimeGateUpdate(BaseModel):
    regime_key: str
    allow_long: Optional[bool] = None
    allow_short: Optional[bool] = None


# ----------------------------------------------------------------- learning
@router.get("/learning/status")
async def learning_status(session: AsyncSession = Depends(get_session)):
    status = monitor.learning_engine.status()
    setups = (await session.execute(select(SetupModel))).scalars().all()
    names = {s.id: s.name for s in setups}
    for model in status["models"]:
        model["setup_name"] = names.get(model["setup_id"], f"setup {model['setup_id']}")
    return status


@router.post("/learning/run")
async def run_learning_now():
    """Manual trigger — same as the nightly 20:00 ET run."""
    result = await monitor.learning_engine.run_learning()
    monitor.setup_factor_engine.min_trades = monitor.learning_engine.min_trades
    await monitor.setup_factor_engine.recompute_all()
    return result


@router.put("/learning/config")
async def update_learning_config(
    payload: LearningConfigUpdate, session: AsyncSession = Depends(get_session)
):
    row = (
        await session.execute(select(LearningConfigModel).where(LearningConfigModel.id == 1))
    ).scalar_one_or_none()
    if row is None:
        row = LearningConfigModel(id=1)
        session.add(row)
    if payload.min_trades is not None:
        if payload.min_trades < 5:
            raise HTTPException(422, "min_trades must be at least 5")
        row.min_trades = payload.min_trades
    await session.commit()
    monitor.learning_engine.min_trades = row.min_trades
    monitor.setup_factor_engine.min_trades = row.min_trades
    return {"min_trades": row.min_trades}


# -------------------------------------------------------------- regime gate
@router.get("/gate-regimes")
async def list_regime_gates(session: AsyncSession = Depends(get_session)):
    rows = (
        await session.execute(select(RegimeGateModel).order_by(RegimeGateModel.id))
    ).scalars().all()
    return [
        {"regime_key": r.regime_key, "allow_long": r.allow_long, "allow_short": r.allow_short}
        for r in rows
    ]


@router.put("/gate-regimes")
async def update_regime_gate(
    payload: RegimeGateUpdate, session: AsyncSession = Depends(get_session)
):
    row = (
        await session.execute(
            select(RegimeGateModel).where(RegimeGateModel.regime_key == payload.regime_key)
        )
    ).scalar_one_or_none()
    if row is None:
        row = RegimeGateModel(regime_key=payload.regime_key)
        session.add(row)
    if payload.allow_long is not None:
        row.allow_long = payload.allow_long
    if payload.allow_short is not None:
        row.allow_short = payload.allow_short
    await session.commit()
    await monitor.gate_engine.refresh_rules()
    return {"regime_key": row.regime_key, "allow_long": row.allow_long, "allow_short": row.allow_short}
