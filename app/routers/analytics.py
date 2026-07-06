"""Analytics API (plan Phase B). All computation server-side; every
endpoint accepts the same filters."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import JournalModel
from app.services import analytics

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


async def _filtered_trades(
    session: AsyncSession,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    setup_id: Optional[int] = None,
    side: Optional[str] = None,
    stock: Optional[str] = None,
    grade: Optional[str] = None,
):
    query = select(JournalModel)
    if setup_id is not None:
        query = query.where(JournalModel.setup_id == setup_id)
    if side:
        query = query.where(JournalModel.signal_side == side)
    if stock:
        query = query.where(JournalModel.stock == stock.upper())
    if grade:
        query = query.where(JournalModel.entry_grade == grade)
    if date_from:
        query = query.where(JournalModel.entry_signal_time >= datetime.fromisoformat(date_from))
    if date_to:
        query = query.where(
            JournalModel.entry_signal_time <= datetime.fromisoformat(date_to + "T23:59:59")
        )
    return (await session.execute(query)).scalars().all()


def _filters(
    date_from: Optional[str] = Query(None, alias="from"),
    date_to: Optional[str] = Query(None, alias="to"),
    setup_id: Optional[int] = None,
    side: Optional[str] = None,
    stock: Optional[str] = None,
    grade: Optional[str] = None,
):
    return {
        "date_from": date_from,
        "date_to": date_to,
        "setup_id": setup_id,
        "side": side,
        "stock": stock,
        "grade": grade,
    }


@router.get("/overview")
async def overview(filters: dict = Depends(_filters), session: AsyncSession = Depends(get_session)):
    trades = await _filtered_trades(session, **filters)
    return {
        "metrics": analytics.account_metrics(trades),
        "equity": analytics.equity_series(trades),
    }


@router.get("/calendar")
async def calendar(
    month: Optional[str] = None,
    filters: dict = Depends(_filters),
    session: AsyncSession = Depends(get_session),
):
    trades = await _filtered_trades(session, **filters)
    return analytics.calendar(trades, month)


@router.get("/time")
async def time_view(filters: dict = Depends(_filters), session: AsyncSession = Depends(get_session)):
    trades = await _filtered_trades(session, **filters)
    return analytics.time_view(trades)


@router.get("/risk")
async def risk_view(filters: dict = Depends(_filters), session: AsyncSession = Depends(get_session)):
    trades = await _filtered_trades(session, **filters)
    return analytics.risk_view(trades)


@router.get("/magnitude")
async def magnitude_view(
    filters: dict = Depends(_filters), session: AsyncSession = Depends(get_session)
):
    trades = await _filtered_trades(session, **filters)
    return analytics.magnitude_view(trades)


@router.get("/stats")
async def stats_catalog(
    filters: dict = Depends(_filters), session: AsyncSession = Depends(get_session)
):
    """Every metric with its value AND its formula — full transparency."""
    trades = await _filtered_trades(session, **filters)
    metrics = analytics.account_metrics(trades)
    return [
        {
            "metric": key,
            "value": metrics.get(key),
            "formula": formula,
        }
        for key, formula in analytics.METRIC_FORMULAS.items()
    ]


@router.get("/breakdown")
async def breakdown(
    dim: str,
    filters: dict = Depends(_filters),
    session: AsyncSession = Depends(get_session),
):
    if dim not in analytics.BREAKDOWN_DIMS:
        raise HTTPException(422, f"dim must be one of {analytics.BREAKDOWN_DIMS}")
    trades = await _filtered_trades(session, **filters)
    return {"dim": dim, "rows": analytics.breakdown(trades, dim)}
