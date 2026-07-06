"""Accounts + live capital API (plan Phase E)."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import AccountModel
from app.services.monitor import monitor

router = APIRouter(prefix="/api", tags=["accounts"])


class AccountIn(BaseModel):
    name: str
    account_size: float = 100000.0
    risk_per_trade: Optional[float] = None  # None -> global setting
    broker_id: Optional[int] = None
    is_primary: bool = False
    is_active: bool = True


class AccountUpdate(BaseModel):
    name: Optional[str] = None
    account_size: Optional[float] = None
    risk_per_trade: Optional[float] = None
    broker_id: Optional[int] = None
    is_primary: Optional[bool] = None
    is_active: Optional[bool] = None


def _to_dict(a: AccountModel) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "account_size": a.account_size,
        "risk_per_trade": a.risk_per_trade,
        "broker_id": a.broker_id,
        "is_primary": a.is_primary,
        "is_active": a.is_active,
    }


async def _clear_other_primaries(session: AsyncSession, keep_id: int) -> None:
    rows = (await session.execute(select(AccountModel))).scalars().all()
    for row in rows:
        if row.id != keep_id and row.is_primary:
            row.is_primary = False


@router.get("/accounts")
async def list_accounts(session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(AccountModel).order_by(AccountModel.id))).scalars().all()
    return [_to_dict(a) for a in rows]


@router.post("/accounts", status_code=201)
async def create_account(payload: AccountIn, session: AsyncSession = Depends(get_session)):
    account = AccountModel(**payload.model_dump())
    session.add(account)
    await session.commit()
    await session.refresh(account)
    if account.is_primary:
        await _clear_other_primaries(session, account.id)
        await session.commit()
    await monitor.capital_service.refresh()
    return _to_dict(account)


@router.put("/accounts/{account_id}")
async def update_account(
    account_id: int, payload: AccountUpdate, session: AsyncSession = Depends(get_session)
):
    account = await session.get(AccountModel, account_id)
    if account is None:
        raise HTTPException(404, "account not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(account, key, value)
    if account.is_primary:
        await _clear_other_primaries(session, account.id)
    await session.commit()
    await session.refresh(account)
    await monitor.capital_service.refresh()
    return _to_dict(account)


@router.delete("/accounts/{account_id}", status_code=204)
async def delete_account(account_id: int, session: AsyncSession = Depends(get_session)):
    account = await session.get(AccountModel, account_id)
    if account is None:
        raise HTTPException(404, "account not found")
    await session.delete(account)
    await session.commit()
    await monitor.capital_service.refresh()


@router.get("/capital")
async def capital_snapshot():
    """Per-account capital state as the sizer sees it right now:
    capital base (manual or live), open allocation, available capital."""
    await monitor.capital_service.refresh()
    return monitor.capital_service.snapshot()
