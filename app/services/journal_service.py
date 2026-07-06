"""JournalService (spec 3.9): immutable Entry Cards and exit snapshots."""

from datetime import datetime
from typing import Optional

from sqlalchemy import select

from app.database import async_session_factory
from app.models import JournalModel


def journal_to_dict(entry: JournalModel) -> dict:
    return {
        "id": entry.id,
        "stock": entry.stock,
        "setup_id": entry.setup_id,
        "signal_side": entry.signal_side,
        "status": entry.status,
        "entry_signal_time": entry.entry_signal_time.isoformat()
        if entry.entry_signal_time
        else None,
        "entry_mandatory_results": entry.entry_mandatory_results,
        "entry_default_results": entry.entry_default_results,
        "entry_additional_results": entry.entry_additional_results,
        "entry_price": entry.entry_price,
        "entry_sl_price": entry.entry_sl_price,
        "entry_tp_price": entry.entry_tp_price,
        "entry_shares": entry.entry_shares,
        "entry_factors": entry.entry_factors,
        "entry_grade": entry.entry_grade,
        "entry_gate_allowed": entry.entry_gate_allowed,
        "entry_gate_screener_snapshot": entry.entry_gate_screener_snapshot,
        "exit_time": entry.exit_time.isoformat() if entry.exit_time else None,
        "exit_price": entry.exit_price,
        "exit_pnl": entry.exit_pnl,
        "exit_reason": entry.exit_reason,
        "r_multiple": entry.r_multiple,
        "planned_rr": entry.planned_rr,
        "mae_pct": entry.mae_pct,
        "mfe_pct": entry.mfe_pct,
        "capture_pct": entry.capture_pct,
        "hold_minutes": entry.hold_minutes,
        "exit_verdict": entry.exit_verdict,
    }


class JournalService:
    async def create_entry_card(self, card_data: dict) -> JournalModel:
        """Write the immutable Entry Card snapshot."""
        entry = JournalModel(**card_data)
        async with async_session_factory() as session:
            session.add(entry)
            await session.commit()
            await session.refresh(entry)
        return entry

    async def update_exit_card(
        self, journal_id: int, exit_data: dict, bars: Optional[list] = None
    ) -> Optional[JournalModel]:
        """Fill the exit snapshot and compute exit enrichment.
        Entry fields are never modified."""
        from app.services.exit_enrichment import compute_exit_enrichment

        allowed = {"exit_time", "exit_price", "exit_pnl", "exit_reason", "status"}
        async with async_session_factory() as session:
            entry = (
                await session.execute(select(JournalModel).where(JournalModel.id == journal_id))
            ).scalar_one_or_none()
            if entry is None:
                return None
            for key, value in exit_data.items():
                if key in allowed:
                    setattr(entry, key, value)
            if entry.exit_time is None and any(
                k in exit_data for k in ("exit_price", "exit_pnl", "exit_reason")
            ):
                entry.exit_time = datetime.utcnow()
            if entry.exit_price is not None:
                if entry.exit_pnl is None and entry.entry_price is not None and entry.entry_shares:
                    direction = 1.0 if entry.signal_side == "long" else -1.0
                    entry.exit_pnl = round(
                        (float(entry.exit_price) - float(entry.entry_price))
                        * direction
                        * float(entry.entry_shares),
                        2,
                    )
                if entry.status not in ("rejected",):
                    entry.status = exit_data.get("status") or "closed"
                for key, value in compute_exit_enrichment(entry, bars).items():
                    setattr(entry, key, value)
            await session.commit()
            await session.refresh(entry)
        return entry

    async def set_status(self, journal_id: int, status: str) -> None:
        async with async_session_factory() as session:
            entry = (
                await session.execute(select(JournalModel).where(JournalModel.id == journal_id))
            ).scalar_one_or_none()
            if entry is not None:
                entry.status = status
                await session.commit()
