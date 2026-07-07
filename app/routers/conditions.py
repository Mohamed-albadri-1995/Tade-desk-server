"""CRUD API for condition scripts.

The Python script is the single source of truth: it is validated in the
sandbox on save and the condition's name comes from the script's own
``get_name()``."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import ConditionModel
from app.schemas import ConditionCreate, ConditionOut, ConditionUpdate
from app.services.monitor import monitor
from app.services.sandbox import SandboxError, instantiate

router = APIRouter(prefix="/api/conditions", tags=["conditions"])


def derive_condition_name(script_content: str) -> str:
    """Validate the script and return the name its get_name() declares."""
    try:
        instance = instantiate(script_content, "ConditionCheck")
    except SandboxError as exc:
        raise HTTPException(422, f"condition script error: {exc}")
    if not callable(instance.__class__.__dict__.get("evaluate")):
        raise HTTPException(422, "condition script: ConditionCheck must define evaluate()")
    try:
        name = str(instance.get_name())
    except Exception as exc:
        raise HTTPException(422, f"condition script error calling get_name(): {exc}")
    if not name:
        raise HTTPException(422, "condition script: get_name() returned an empty name")
    return name


@router.get("", response_model=list[ConditionOut])
async def list_conditions(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(ConditionModel).order_by(ConditionModel.id))
    return result.scalars().all()


@router.post("", response_model=ConditionOut, status_code=201)
async def create_condition(payload: ConditionCreate, session: AsyncSession = Depends(get_session)):
    if payload.type not in ("default", "additional"):
        raise HTTPException(422, "type must be 'default' or 'additional'")
    data = payload.model_dump()
    data["name"] = derive_condition_name(payload.script_content)  # script wins
    condition = ConditionModel(**data)
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
    if "script_content" in data:
        data["name"] = derive_condition_name(data["script_content"])  # script wins
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
