"""User settings, grade/regime multiplier tables and gate rules APIs."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import (
    GateRuleModel,
    GradeMultiplierModel,
    GradeScoringModelModel,
    RegimeMultiplierModel,
    UserSettingsModel,
)
from app.schemas import (
    GateRuleCreate,
    GateRuleOut,
    GateRuleUpdate,
    GradeMultiplierIn,
    GradePreviewIn,
    GradeScoringModelOut,
    GradeScoringModelUpdate,
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
    data = payload.model_dump(exclude_unset=True)
    for field in ("session_start_time", "session_end_time"):
        if field in data:
            parts = str(data[field]).split(":")
            if len(parts) != 2 or not all(p.isdigit() for p in parts):
                raise HTTPException(422, f"{field} must be HH:MM")
    if "watchlist_source" in data and data["watchlist_source"] not in ("screener", "manual"):
        raise HTTPException(422, "watchlist_source must be 'screener' or 'manual'")
    watchlist_changed = "watchlist_source" in data and data["watchlist_source"] != row.watchlist_source
    for key, value in data.items():
        setattr(row, key, value)
    await session.commit()
    await session.refresh(row)
    await monitor._load_settings()
    if "session_start_time" in data:
        from main import schedule_session_start  # lazy: avoids circular import

        schedule_session_start()
    if watchlist_changed:
        await monitor.restart()
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


# ----------------------------------------------------------- grading model
@router.get("/grading/model", response_model=GradeScoringModelOut)
async def get_grading_model(session: AsyncSession = Depends(get_session)):
    row = (
        await session.execute(
            select(GradeScoringModelModel).where(GradeScoringModelModel.id == 1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "grading model not initialised")
    return row


@router.put("/grading/model", response_model=GradeScoringModelOut)
async def update_grading_model(
    payload: GradeScoringModelUpdate, session: AsyncSession = Depends(get_session)
):
    row = (
        await session.execute(
            select(GradeScoringModelModel).where(GradeScoringModelModel.id == 1)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "grading model not initialised")
    data = payload.model_dump(exclude_unset=True)
    if "grade_thresholds" in data:
        invalid = set(data["grade_thresholds"]) - {"A+", "A", "B", "C"}
        if invalid:
            raise HTTPException(422, f"grade_thresholds keys must be A+/A/B/C, got {sorted(invalid)}")
    for key, value in data.items():
        setattr(row, key, value)
    await session.commit()
    await session.refresh(row)
    await monitor.grade_engine.refresh()
    return row


@router.post("/grading/preview")
async def preview_grade(payload: GradePreviewIn):
    """Dry-run the current grading model against hypothetical condition
    results (mandatory conditions are never part of grading)."""
    await monitor.grade_engine.refresh()
    return monitor.grade_engine.evaluate_detailed(
        payload.default_results, payload.additional_results
    )


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
