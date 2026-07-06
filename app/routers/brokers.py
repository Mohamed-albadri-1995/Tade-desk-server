"""Broker configuration API. Credentials are stored encrypted and never
returned in responses.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import BrokerModel
from app.schemas import BrokerCreate, BrokerOut, BrokerUpdate
from app.security import encrypt

router = APIRouter(prefix="/api/brokers", tags=["brokers"])


def _to_out(broker: BrokerModel) -> BrokerOut:
    return BrokerOut(
        id=broker.id,
        type=broker.type,
        name=broker.name,
        is_active=broker.is_active,
        has_api_key=bool(broker.api_key),
        has_secret=bool(broker.secret),
    )


@router.get("", response_model=list[BrokerOut])
async def list_brokers(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(BrokerModel).order_by(BrokerModel.id))
    return [_to_out(b) for b in result.scalars().all()]


@router.post("", response_model=BrokerOut, status_code=201)
async def create_broker(payload: BrokerCreate, session: AsyncSession = Depends(get_session)):
    if payload.type not in ("alpaca", "signalstack"):
        raise HTTPException(422, "type must be 'alpaca' or 'signalstack'")
    broker = BrokerModel(
        type=payload.type,
        name=payload.name,
        api_key=encrypt(payload.api_key),
        secret=encrypt(payload.secret),
        is_active=payload.is_active,
    )
    session.add(broker)
    await session.commit()
    await session.refresh(broker)
    return _to_out(broker)


@router.put("/{broker_id}", response_model=BrokerOut)
async def update_broker(
    broker_id: int, payload: BrokerUpdate, session: AsyncSession = Depends(get_session)
):
    broker = await session.get(BrokerModel, broker_id)
    if broker is None:
        raise HTTPException(404, "broker not found")
    data = payload.model_dump(exclude_unset=True)
    if "type" in data and data["type"] not in ("alpaca", "signalstack"):
        raise HTTPException(422, "type must be 'alpaca' or 'signalstack'")
    if "api_key" in data:
        data["api_key"] = encrypt(data["api_key"])
    if "secret" in data:
        data["secret"] = encrypt(data["secret"])
    for key, value in data.items():
        setattr(broker, key, value)
    await session.commit()
    await session.refresh(broker)
    return _to_out(broker)


@router.delete("/{broker_id}", status_code=204)
async def delete_broker(broker_id: int, session: AsyncSession = Depends(get_session)):
    broker = await session.get(BrokerModel, broker_id)
    if broker is None:
        raise HTTPException(404, "broker not found")
    await session.delete(broker)
    await session.commit()
