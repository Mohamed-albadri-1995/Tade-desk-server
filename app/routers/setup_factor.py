"""Setup factor (health cap) API — per (setup, side) states with the full
derivation: WR/PF/drawdown → normalised components → health score →
factor."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import SetupModel
from app.services.monitor import monitor
from app.services.setup_factor import (
    DD_TERRIBLE_R,
    PF_GREAT,
    SCORE_TO_FACTOR,
    WEIGHTS,
    WR_GREAT,
)

router = APIRouter(prefix="/api/setup-factor", tags=["setup-factor"])


@router.get("")
async def list_states(session: AsyncSession = Depends(get_session)):
    setups = (await session.execute(select(SetupModel))).scalars().all()
    out = []
    for s in setups:
        for side in ("pooled", "long", "short"):
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
async def get_model():
    """The health formula (fixed constants) and the live min_trades knob."""
    return {
        "formula": "health = 0.30·min(1, WR/0.60) + 0.40·min(1, PF/2.0) + 0.30·(1 − min(1, maxDD_R/10)); factor = clamp(health × 1.2, 0, 1)",
        "wr_great": WR_GREAT,
        "pf_great": PF_GREAT,
        "dd_terrible_r": DD_TERRIBLE_R,
        "weights": WEIGHTS,
        "score_to_factor": SCORE_TO_FACTOR,
        "min_trades": monitor.setup_factor_engine.min_trades,
    }


@router.post("/recompute")
async def recompute():
    states = await monitor.setup_factor_engine.recompute_all()
    return {"recomputed": len(states)}
