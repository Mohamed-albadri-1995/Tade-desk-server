"""CRUD API for setups. Scripts are stored as raw Python text.

The Python script is the single source of truth: on save it is
validated in the sandbox and the derived fields (mandatory condition
names, entry method/price) are read from the script's own methods —
never typed by hand."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import SetupModel
from app.schemas import SetupCreate, SetupOut, SetupUpdate
from app.services.monitor import monitor
from app.services.sandbox import SandboxError, instantiate

router = APIRouter(prefix="/api/setups", tags=["setups"])

REQUIRED_METHODS = (
    "get_mandatory_conditions",
    "evaluate_mandatory",
    "check_signal",
    "get_sl_tp",
    "get_entry_params",
)


def derive_setup_fields(script_content: str) -> dict:
    """Validate the script and derive config from it (Python-first).

    Raises HTTPException(422) with the exact Python error if the script
    doesn't load, is missing interface methods, or its no-argument
    methods fail."""
    try:
        instance = instantiate(script_content, "SetupIndicator")
    except SandboxError as exc:
        raise HTTPException(422, f"setup script error: {exc}")
    missing = [m for m in REQUIRED_METHODS if not callable(instance.__class__.__dict__.get(m))]
    if missing:
        raise HTTPException(
            422, f"setup script: SetupIndicator is missing methods: {', '.join(missing)}"
        )
    try:
        mandatory = list(instance.get_mandatory_conditions() or [])
        entry_method, entry_price = instance.get_entry_params()
    except Exception as exc:
        raise HTTPException(422, f"setup script error calling interface methods: {exc}")
    return {
        "mandatory_conditions": [str(name) for name in mandatory],
        "entry_method": str(entry_method or "market"),
        "entry_price": float(entry_price) if entry_price is not None else None,
    }


@router.get("", response_model=list[SetupOut])
async def list_setups(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(SetupModel).order_by(SetupModel.id))
    return result.scalars().all()


@router.post("", response_model=SetupOut, status_code=201)
async def create_setup(payload: SetupCreate, session: AsyncSession = Depends(get_session)):
    data = payload.model_dump()
    data.update(derive_setup_fields(payload.script_content))  # script wins
    setup = SetupModel(**data)
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
    data = payload.model_dump(exclude_unset=True)
    if "script_content" in data:
        data.update(derive_setup_fields(data["script_content"]))  # script wins
    for key, value in data.items():
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
