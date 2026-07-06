"""Journal API: entry cards are immutable; only the exit snapshot can be
filled. Closing a trade triggers exit enrichment, a setup-factor
recompute and a capital refresh."""

import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import JournalModel
from app.schemas import ExitCardUpdate
from app.services.event_bus import event_bus
from app.services.journal_service import journal_to_dict
from app.services.monitor import monitor

router = APIRouter(prefix="/api/journal", tags=["journal"])


def _bars_for(stock: str):
    entry = monitor.market_cache.get(stock.upper())
    return entry.get("bars") if entry else None


async def _after_close() -> None:
    await monitor.setup_factor_engine.recompute_all()
    await monitor.capital_service.refresh()


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
    entry = await monitor.journal_service.update_exit_card(
        journal_id, payload.model_dump(exclude_unset=True), bars=None
    )
    if entry is None:
        raise HTTPException(404, "journal entry not found")
    if entry.exit_price is not None:
        # Re-run with bars for MAE/MFE/capture if we have them cached.
        bars = _bars_for(entry.stock)
        if bars:
            entry = await monitor.journal_service.update_exit_card(journal_id, {}, bars=bars)
        await _after_close()
    data = journal_to_dict(entry)
    await event_bus.publish({"type": "new_entry", "entry": data})
    return data


@router.post("/import-exits")
async def import_exits(file: UploadFile):
    """CSV import of exits: columns journal_id, exit_price, and optionally
    exit_time (ISO), exit_reason."""
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    required = {"journal_id", "exit_price"}
    if not reader.fieldnames or not required.issubset({f.strip() for f in reader.fieldnames}):
        raise HTTPException(422, "CSV must have journal_id and exit_price columns")
    results = {"updated": 0, "errors": []}
    closed_any = False
    for i, row in enumerate(reader, start=2):
        try:
            journal_id = int(row["journal_id"])
            exit_data = {"exit_price": float(row["exit_price"])}
            if row.get("exit_time"):
                exit_data["exit_time"] = datetime.fromisoformat(row["exit_time"].replace("Z", ""))
            if row.get("exit_reason"):
                exit_data["exit_reason"] = row["exit_reason"]
            entry = await monitor.journal_service.update_exit_card(journal_id, exit_data, bars=None)
            if entry is None:
                results["errors"].append(f"line {i}: journal {journal_id} not found")
                continue
            bars = _bars_for(entry.stock)
            if bars:
                await monitor.journal_service.update_exit_card(journal_id, {}, bars=bars)
            results["updated"] += 1
            closed_any = True
        except Exception as exc:
            results["errors"].append(f"line {i}: {exc}")
    if closed_any:
        await _after_close()
    return results
