"""Setup factor API (plan Phase D) — states with full breakdown, and the
user-editable model."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import SetupFactorModelModel, SetupModel
from app.services.monitor import monitor

router = APIRouter(prefix="/api/setup-factor", tags=["setup-factor"])


class SetupFactorModelUpdate(BaseModel):
    signals: Optional[dict] = None
    factor_map: Optional[dict] = None
    split_by_side: Optional[bool] = None
    factor_min: Optional[float] = None
    factor_max: Optional[float] = None
    min_trades: Optional[int] = None
    hard_floor_trades: Optional[int] = None
    recent_window: Optional[int] = None


@router.get("")
async def list_states(session: AsyncSession = Depends(get_session)):
    """Every setup with its full factor derivation per side: inputs ->
    signal points -> score -> mapped factor -> confidence -> final."""
    setups = (await session.execute(select(SetupModel))).scalars().all()
    split = monitor.setup_factor_engine.model.get("split_by_side")
    out = []
    for s in setups:
        sides = ["pooled", "long", "short"] if split else ["pooled"]
        for side in sides:
            state = monitor.setup_factor_engine._states.get((s.id, side))
            if state is None:
                if side != "pooled":
                    continue
                state = monitor.setup_factor_engine.get_state(s.id)
            out.append(
                {
                    "setup_id": s.id,
                    "setup_name": s.name,
                    "is_active": s.is_active,
                    "side": side,
                    **{k: v for k, v in state.items() if k != "side"},
                }
            )
    return out


@router.get("/model")
async def get_model(session: AsyncSession = Depends(get_session)):
    row = (
        await session.execute(select(SetupFactorModelModel).where(SetupFactorModelModel.id == 1))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "setup factor model not initialised")
    return {
        "signals": row.signals,
        "factor_map": row.factor_map,
        "split_by_side": row.split_by_side,
        "factor_min": row.factor_min,
        "factor_max": row.factor_max,
        "min_trades": row.min_trades,
        "hard_floor_trades": row.hard_floor_trades,
        "recent_window": row.recent_window,
        "updated_at": row.updated_at,
    }


@router.put("/model")
async def update_model(
    payload: SetupFactorModelUpdate, session: AsyncSession = Depends(get_session)
):
    row = (
        await session.execute(select(SetupFactorModelModel).where(SetupFactorModelModel.id == 1))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "setup factor model not initialised")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    await session.commit()
    await monitor.setup_factor_engine.recompute_all()
    return await get_model(session)


@router.post("/recompute")
async def recompute():
    states = await monitor.setup_factor_engine.recompute_all()
    return {"recomputed": len(states)}
