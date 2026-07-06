"""CRUD API for setups. Scripts are stored as raw Python text."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import SetupModel
from app.schemas import SetupCreate, SetupOut, SetupUpdate
from app.services.monitor import monitor

router = APIRouter(prefix="/api/setups", tags=["setups"])


@router.get("", response_model=list[SetupOut])
async def list_setups(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(SetupModel).order_by(SetupModel.id))
    return result.scalars().all()


@router.post("", response_model=SetupOut, status_code=201)
async def create_setup(payload: SetupCreate, session: AsyncSession = Depends(get_session)):
    setup = SetupModel(**payload.model_dump())
    session.add(setup)
    await session.commit()
    await session.refresh(setup)
    return setup


@router.get("/{setup_id}", response_model=SetupOut)
async def get_setup(setup_id: int, session: AsyncSession = Depends(get_session)):
    setup = await session.get(SetupModel, setup_id)
    if setup is None:
        raise HTTPException(404, "setup not found")
    return setup


@router.put("/{setup_id}", response_model=SetupOut)
async def update_setup(
    setup_id: int, payload: SetupUpdate, session: AsyncSession = Depends(get_session)
):
    setup = await session.get(SetupModel, setup_id)
    if setup is None:
        raise HTTPException(404, "setup not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(setup, key, value)
    await session.commit()
    await session.refresh(setup)
    monitor.setup_engine.invalidate(setup_id)
    return setup


@router.delete("/{setup_id}", status_code=204)
async def delete_setup(setup_id: int, session: AsyncSession = Depends(get_session)):
    setup = await session.get(SetupModel, setup_id)
    if setup is None:
        raise HTTPException(404, "setup not found")
    await session.delete(setup)
    await session.commit()
    monitor.setup_engine.invalidate(setup_id)
