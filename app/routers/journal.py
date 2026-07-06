"""Journal API: entry cards are immutable; only the exit snapshot can be filled."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import JournalModel
from app.schemas import ExitCardUpdate
from app.services.event_bus import event_bus
from app.services.journal_service import JournalService, journal_to_dict

router = APIRouter(prefix="/api/journal", tags=["journal"])
journal_service = JournalService()


@router.get("")
async def list_journal(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(JournalModel).order_by(JournalModel.id.desc()))
    return [journal_to_dict(e) for e in result.scalars().all()]


@router.get("/{journal_id}")
async def get_journal_entry(journal_id: int, session: AsyncSession = Depends(get_session)):
    entry = await session.get(JournalModel, journal_id)
    if entry is None:
        raise HTTPException(404, "journal entry not found")
    return journal_to_dict(entry)


@router.put("/{journal_id}/exit")
async def update_exit(journal_id: int, payload: ExitCardUpdate):
    entry = await journal_service.update_exit_card(
        journal_id, payload.model_dump(exclude_unset=True)
    )
    if entry is None:
        raise HTTPException(404, "journal entry not found")
    data = journal_to_dict(entry)
    await event_bus.publish({"type": "new_entry", "entry": data})
    return data
