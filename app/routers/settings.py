"""User settings, grade/regime multiplier tables and gate rules APIs."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import (
    GateRuleModel,
    GradeMultiplierModel,
    RegimeMultiplierModel,
    UserSettingsModel,
)
from app.schemas import (
    GateRuleCreate,
    GateRuleOut,
    GateRuleUpdate,
    GradeMultiplierIn,
    RegimeMultiplierIn,
    UserSettingsOut,
    UserSettingsUpdate,
)
from app.services.monitor import monitor

router = APIRouter(prefix="/api", tags=["settings"])

VALID_GRADES = ("A+", "A", "B", "C", "D")


# ----------------------------------------------------------- user settings
@router.get("/settings", response_model=UserSettingsOut)
async def get_settings(session: AsyncSession = Depends(get_session)):
    row = (
        await session.execute(select(UserSettingsModel).where(UserSettingsModel.id == 1))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "settings not initialised")
    return row


@router.put("/settings", response_model=UserSettingsOut)
async def update_settings(
    payload: UserSettingsUpdate, session: AsyncSession = Depends(get_session)
):
    row = (
        await session.execute(select(UserSettingsModel).where(UserSettingsModel.id == 1))
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "settings not initialised")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    await session.commit()
    await session.refresh(row)
    await monitor._load_settings()
    return row


# ------------------------------------------------------- grade multipliers
@router.get("/multipliers/grade")
async def list_grade_multipliers(session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(GradeMultiplierModel))).scalars().all()
    return [{"id": r.id, "grade": r.grade, "multiplier": r.multiplier} for r in rows]


@router.put("/multipliers/grade")
async def upsert_grade_multiplier(
    payload: GradeMultiplierIn, session: AsyncSession = Depends(get_session)
):
    if payload.grade not in VALID_GRADES:
        raise HTTPException(422, f"grade must be one of {VALID_GRADES}")
    row = (
        await session.execute(
            select(GradeMultiplierModel).where(GradeMultiplierModel.grade == payload.grade)
        )
    ).scalar_one_or_none()
    if row is None:
        row = GradeMultiplierModel(grade=payload.grade, multiplier=payload.multiplier)
        session.add(row)
    else:
        row.multiplier = payload.multiplier
    await session.commit()
    await monitor.sizer_engine.refresh()
    return {"id": row.id, "grade": row.grade, "multiplier": row.multiplier}


# ------------------------------------------------------ regime multipliers
@router.get("/multipliers/regime")
async def list_regime_multipliers(session: AsyncSession = Depends(get_session)):
    rows = (await session.execute(select(RegimeMultiplierModel))).scalars().all()
    return [{"id": r.id, "regime_key": r.regime_key, "multiplier": r.multiplier} for r in rows]


@router.put("/multipliers/regime")
async def upsert_regime_multiplier(
    payload: RegimeMultiplierIn, session: AsyncSession = Depends(get_session)
):
    row = (
        await session.execute(
            select(RegimeMultiplierModel).where(
                RegimeMultiplierModel.regime_key == payload.regime_key
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = RegimeMultiplierModel(regime_key=payload.regime_key, multiplier=payload.multiplier)
        session.add(row)
    else:
        row.multiplier = payload.multiplier
    await session.commit()
    await monitor.sizer_engine.refresh()
    return {"id": row.id, "regime_key": row.regime_key, "multiplier": row.multiplier}


@router.delete("/multipliers/regime/{multiplier_id}", status_code=204)
async def delete_regime_multiplier(
    multiplier_id: int, session: AsyncSession = Depends(get_session)
):
    row = await session.get(RegimeMultiplierModel, multiplier_id)
    if row is None:
        raise HTTPException(404, "regime multiplier not found")
    await session.delete(row)
    await session.commit()
    await monitor.sizer_engine.refresh()


# --------------------------------------------------------------- gate rules
@router.get("/gate-rules", response_model=list[GateRuleOut])
async def list_gate_rules(session: AsyncSession = Depends(get_session)):
    rows = (
        await session.execute(
            select(GateRuleModel).order_by(GateRuleModel.priority.desc(), GateRuleModel.id)
        )
    ).scalars().all()
    return rows


@router.post("/gate-rules", response_model=GateRuleOut, status_code=201)
async def create_gate_rule(payload: GateRuleCreate, session: AsyncSession = Depends(get_session)):
    if payload.side_allowed not in ("long", "short", "both"):
        raise HTTPException(422, "side_allowed must be 'long', 'short' or 'both'")
    rule = GateRuleModel(**payload.model_dump())
    session.add(rule)
    await session.commit()
    await session.refresh(rule)
    await monitor.gate_engine.refresh_rules()
    return rule


@router.put("/gate-rules/{rule_id}", response_model=GateRuleOut)
async def update_gate_rule(
    rule_id: int, payload: GateRuleUpdate, session: AsyncSession = Depends(get_session)
):
    rule = await session.get(GateRuleModel, rule_id)
    if rule is None:
        raise HTTPException(404, "gate rule not found")
    data = payload.model_dump(exclude_unset=True)
    if "side_allowed" in data and data["side_allowed"] not in ("long", "short", "both"):
        raise HTTPException(422, "side_allowed must be 'long', 'short' or 'both'")
    for key, value in data.items():
        setattr(rule, key, value)
    await session.commit()
    await session.refresh(rule)
    await monitor.gate_engine.refresh_rules()
    return rule


@router.delete("/gate-rules/{rule_id}", status_code=204)
async def delete_gate_rule(rule_id: int, session: AsyncSession = Depends(get_session)):
    rule = await session.get(GateRuleModel, rule_id)
    if rule is None:
        raise HTTPException(404, "gate rule not found")
    await session.delete(rule)
    await session.commit()
    await monitor.gate_engine.refresh_rules()
