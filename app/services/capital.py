"""CapitalService (plan Phase E) — per-account available capital
"at the moment".

For each active account it maintains a cached view:

    available_capital = capital_base − open_allocation

* ``capital_base``: live buying power synced from the Alpaca account API
  on an interval when the account is linked to an alpaca broker;
  otherwise the manually configured ``account_size``.
* ``open_allocation``: Σ (entry_price × shares) of this account's open
  entry cards (status pending/alerted, no exit yet).

The pipeline reads only the cached values — zero network I/O at signal
time. The cap itself is applied in SizerEngine.calculate_multi.
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import async_session_factory
from app.models import AccountModel, BrokerModel, JournalModel
from app.security import decrypt

logger = logging.getLogger(__name__)

OPEN_STATUSES = ("pending", "alerted")


class CapitalService:
    def __init__(self):
        self.accounts: List[dict] = []  # cached account rows
        self.state: Dict[int, dict] = {}  # account_id -> {capital_base, open_allocation, ...}
        self._task: Optional[asyncio.Task] = None
        self.broker_sync_interval = 30  # seconds between live buying-power syncs

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        await self.stop()
        await self.refresh()
        self._task = asyncio.create_task(self._broker_sync_loop(), name="capital-sync-loop")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    # -------------------------------------------------------------- refresh

    async def refresh(self) -> None:
        """Reload accounts and recompute open allocations from the journal."""
        async with async_session_factory() as session:
            rows = (
                await session.execute(
                    select(AccountModel).where(AccountModel.is_active == True)  # noqa: E712
                )
            ).scalars().all()
            self.accounts = [
                {
                    "id": r.id,
                    "name": r.name,
                    "account_size": r.account_size,
                    "risk_per_trade": r.risk_per_trade,
                    "broker_id": r.broker_id,
                    "is_primary": r.is_primary,
                }
                for r in rows
            ]
            open_entries = (
                await session.execute(
                    select(JournalModel).where(
                        JournalModel.status.in_(OPEN_STATUSES),
                        JournalModel.exit_pnl == None,  # noqa: E711
                    )
                )
            ).scalars().all()

        allocations: Dict[int, float] = {a["id"]: 0.0 for a in self.accounts}
        for entry in open_entries:
            per_account = ((entry.entry_factors or {}).get("accounts")) or {}
            for account in self.accounts:
                account_alloc = per_account.get(str(account["id"])) or per_account.get(
                    account["name"]
                )
                if account_alloc is not None:
                    shares = float(account_alloc.get("final_shares") or 0)
                elif account["is_primary"]:
                    shares = float(entry.entry_shares or 0)  # legacy single-account cards
                else:
                    shares = 0.0
                if shares and entry.entry_price:
                    allocations[account["id"]] += shares * float(entry.entry_price)

        for account in self.accounts:
            state = self.state.setdefault(account["id"], {})
            state["open_allocation"] = round(allocations.get(account["id"], 0.0), 2)
            if "capital_base" not in state or state.get("source") == "manual":
                state["capital_base"] = float(account["account_size"])
                state["source"] = "manual"
            state["updated_at"] = datetime.utcnow().isoformat()

    async def _broker_sync_loop(self) -> None:
        while True:
            try:
                await self._sync_broker_capital()
            except Exception as exc:
                logger.warning("capital sync failed: %s", exc)
            await asyncio.sleep(self.broker_sync_interval)

    async def _sync_broker_capital(self) -> None:
        linked = [a for a in self.accounts if a.get("broker_id")]
        if not linked:
            return
        async with async_session_factory() as session:
            brokers = {
                b.id: b
                for b in (
                    await session.execute(
                        select(BrokerModel).where(BrokerModel.type == "alpaca")
                    )
                ).scalars().all()
            }
        for account in linked:
            broker = brokers.get(account["broker_id"])
            if broker is None:
                continue
            try:
                headers = {
                    "APCA-API-KEY-ID": decrypt(broker.api_key),
                    "APCA-API-SECRET-KEY": decrypt(broker.secret),
                }
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(
                        f"{settings.alpaca_trading_url}/v2/account", headers=headers
                    )
                    resp.raise_for_status()
                    data = resp.json()
                state = self.state.setdefault(account["id"], {})
                state["capital_base"] = float(
                    data.get("buying_power") or data.get("cash") or account["account_size"]
                )
                state["source"] = "alpaca_live"
                state["updated_at"] = datetime.utcnow().isoformat()
            except Exception as exc:
                logger.warning("buying power sync failed for %s: %s", account["name"], exc)

    # ---------------------------------------------------------- signal time

    def reserve(self, per_account: dict, entry_price: float) -> None:
        """Immediately charge a new position against available capital, in
        memory. Without this, two signals firing in the same 5s tick would
        both see the same free capital and could over-allocate together;
        the next DB refresh reconciles to the same numbers."""
        for account_id_str, breakdown in (per_account or {}).items():
            shares = float(breakdown.get("final_shares") or 0)
            if shares <= 0:
                continue
            try:
                state = self.state.get(int(account_id_str))
            except (TypeError, ValueError):
                state = None
            if state is not None:
                state["open_allocation"] = round(
                    state.get("open_allocation", 0.0) + shares * float(entry_price), 2
                )

    def available(self, account_id: int) -> Optional[float]:
        state = self.state.get(account_id)
        if not state:
            return None
        return max(0.0, state["capital_base"] - state["open_allocation"])

    def snapshot(self) -> List[dict]:
        out = []
        for account in self.accounts:
            state = self.state.get(account["id"], {})
            out.append(
                {
                    **account,
                    "capital_base": state.get("capital_base"),
                    "capital_source": state.get("source"),
                    "open_allocation": state.get("open_allocation"),
                    "available_capital": self.available(account["id"]),
                    "updated_at": state.get("updated_at"),
                }
            )
        return out
