"""CRUD API for condition scripts."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import ConditionModel
from app.schemas import ConditionCreate, ConditionOut, ConditionUpdate
from app.services.monitor import monitor

router = APIRouter(prefix="/api/conditions", tags=["conditions"])


@router.get("", response_model=list[ConditionOut])
async def list_conditions(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(ConditionModel).order_by(ConditionModel.id))
    return result.scalars().all()


@router.post("", response_model=ConditionOut, status_code=201)
async def create_condition(payload: ConditionCreate, session: AsyncSession = Depends(get_session)):
    if payload.type not in ("default", "additional"):
        raise HTTPException(422, "type must be 'default' or 'additional'")
    condition = ConditionModel(**payload.model_dump())
    session.add(condition)
    await session.commit()
    await session.refresh(condition)
    return condition


@router.get("/{condition_id}", response_model=ConditionOut)
async def get_condition(condition_id: int, session: AsyncSession = Depends(get_session)):
    condition = await session.get(ConditionModel, condition_id)
    if condition is None:
        raise HTTPException(404, "condition not found")
    return condition


@router.put("/{condition_id}", response_model=ConditionOut)
async def update_condition(
    condition_id: int, payload: ConditionUpdate, session: AsyncSession = Depends(get_session)
):
    condition = await session.get(ConditionModel, condition_id)
    if condition is None:
        raise HTTPException(404, "condition not found")
    data = payload.model_dump(exclude_unset=True)
    if "type" in data and data["type"] not in ("default", "additional"):
        raise HTTPException(422, "type must be 'default' or 'additional'")
    for key, value in data.items():
        setattr(condition, key, value)
    await session.commit()
    await session.refresh(condition)
    monitor.condition_engine.invalidate(condition_id)
    return condition


@router.delete("/{condition_id}", status_code=204)
async def delete_condition(condition_id: int, session: AsyncSession = Depends(get_session)):
    condition = await session.get(ConditionModel, condition_id)
    if condition is None:
        raise HTTPException(404, "condition not found")
    await session.delete(condition)
    await session.commit()
    monitor.condition_engine.invalidate(condition_id)
