"""BrokerEngine (spec 3.8).

Formats an alert for each active broker and dispatches it:
* Alpaca — via the alpaca-trade-api SDK when installed, otherwise via
  the trading REST API using httpx.
* SignalStack — HTTP POST with a JSON placeholder payload.

Dispatch failures are logged per broker and never break the pipeline.
"""

import logging
from typing import List

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import async_session_factory
from app.models import BrokerModel, JournalModel
from app.security import decrypt

logger = logging.getLogger(__name__)

def format_alert(journal_entry: JournalModel) -> dict:
    return {
        "symbol": journal_entry.stock,
        "side": "buy" if journal_entry.signal_side == "long" else "sell",
        "signal_side": journal_entry.signal_side,
        "qty": journal_entry.entry_shares,
        "entry_price": journal_entry.entry_price,
        "stop_loss": journal_entry.entry_sl_price,
        "take_profit": journal_entry.entry_tp_price,
        "grade": journal_entry.entry_grade,
        "setup_id": journal_entry.setup_id,
        "journal_id": journal_entry.id,
        "signal_time": journal_entry.entry_signal_time.isoformat()
        if journal_entry.entry_signal_time
        else None,
    }


class BrokerEngine:
    async def _active_brokers(self) -> List[BrokerModel]:
        async with async_session_factory() as session:
            result = await session.execute(select(BrokerModel).where(BrokerModel.is_active == True))  # noqa: E712
            return list(result.scalars().all())

    @staticmethod
    def _account_shares_for_broker(journal_entry: JournalModel, broker_id: int):
        """If the entry has per-account sizing and an account is linked to
        this broker, use that account's share count for the alert."""
        accounts = (journal_entry.entry_factors or {}).get("accounts") or {}
        for account in accounts.values():
            if account.get("broker_id") == broker_id:
                return account.get("final_shares")
        return None

    async def dispatch(self, journal_entry: JournalModel) -> List[dict]:
        alert = format_alert(journal_entry)
        results = []
        for broker in await self._active_brokers():
            broker_alert = dict(alert)
            account_shares = self._account_shares_for_broker(journal_entry, broker.id)
            if account_shares is not None:
                broker_alert["qty"] = account_shares
            if not broker_alert["qty"]:
                results.append({"broker": broker.name, "ok": True, "skipped": "zero shares"})
                continue
            try:
                if broker.type == "alpaca":
                    await self._dispatch_alpaca(broker, broker_alert)
                elif broker.type == "signalstack":
                    await self._dispatch_signalstack(broker, broker_alert)
                else:
                    raise ValueError(f"unknown broker type: {broker.type}")
                results.append({"broker": broker.name, "ok": True})
            except Exception as exc:
                logger.warning("broker dispatch failed (%s): %s", broker.name, exc)
                results.append({"broker": broker.name, "ok": False, "error": str(exc)})
        return results

    async def _dispatch_alpaca(self, broker: BrokerModel, alert: dict) -> None:
        api_key = decrypt(broker.api_key)
        secret = decrypt(broker.secret)
        if not alert["qty"]:
            raise ValueError("zero shares — nothing to submit")
        order = {
            "symbol": alert["symbol"],
            "qty": int(alert["qty"]),
            "side": alert["side"],
            "type": "market",
            "time_in_force": "day",
        }
        # Attach SL/TP broker-side as a bracket order: the position stays
        # protected even if this server goes down. Alpaca brackets require
        # both legs; with only a stop we send an OTO stop leg.
        sl, tp = alert.get("stop_loss"), alert.get("take_profit")
        if sl is not None and tp is not None:
            order["order_class"] = "bracket"
            order["stop_loss"] = {"stop_price": round(float(sl), 2)}
            order["take_profit"] = {"limit_price": round(float(tp), 2)}
        elif sl is not None:
            order["order_class"] = "oto"
            order["stop_loss"] = {"stop_price": round(float(sl), 2)}
        headers = {"APCA-API-KEY-ID": api_key, "APCA-API-SECRET-KEY": secret}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{settings.alpaca_trading_url}/v2/orders", json=order, headers=headers
            )
            resp.raise_for_status()

    async def dispatch_close(self, journal_entry: JournalModel, reason: str) -> List[dict]:
        """Send the CLOSING order to every active broker when the tool exits
        a position (session-end time-stop, manual close, or as a safety net
        after an SL/TP journal close — if the broker-side bracket already
        exited, the close is a no-op 404 and is reported as such)."""
        results = []
        base_qty = int(journal_entry.entry_shares or 0)
        for broker in await self._active_brokers():
            qty = self._account_shares_for_broker(journal_entry, broker.id)
            qty = int(qty) if qty is not None else base_qty
            if qty <= 0:
                results.append({"broker": broker.name, "ok": True, "skipped": "zero shares"})
                continue
            try:
                if broker.type == "alpaca":
                    await self._close_alpaca(broker, journal_entry.stock, qty)
                elif broker.type == "signalstack":
                    await self._close_signalstack(broker, journal_entry, qty, reason)
                results.append({"broker": broker.name, "ok": True})
            except Exception as exc:
                logger.warning("broker close failed (%s): %s", broker.name, exc)
                results.append({"broker": broker.name, "ok": False, "error": str(exc)})
        return results

    async def _close_alpaca(self, broker: BrokerModel, symbol: str, qty: int) -> None:
        headers = {
            "APCA-API-KEY-ID": decrypt(broker.api_key),
            "APCA-API-SECRET-KEY": decrypt(broker.secret),
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Cancel this symbol's open orders (e.g. resting bracket legs)
            # so the market close below can't be double-filled against them.
            resp = await client.get(
                f"{settings.alpaca_trading_url}/v2/orders",
                params={"status": "open", "symbols": symbol},
                headers=headers,
            )
            if resp.status_code == 200:
                for open_order in resp.json():
                    await client.delete(
                        f"{settings.alpaca_trading_url}/v2/orders/{open_order['id']}",
                        headers=headers,
                    )
            resp = await client.delete(
                f"{settings.alpaca_trading_url}/v2/positions/{symbol}",
                params={"qty": qty},
                headers=headers,
            )
            if resp.status_code == 404:
                logger.info("alpaca position %s already flat (bracket leg filled)", symbol)
                return
            resp.raise_for_status()

    async def _close_signalstack(
        self, broker: BrokerModel, entry: JournalModel, qty: int, reason: str
    ) -> None:
        webhook_url = decrypt(broker.api_key)
        if not webhook_url:
            raise ValueError("signalstack webhook URL not configured")
        payload = {
            "action": "sell" if entry.signal_side == "long" else "buy",
            "ticker": entry.stock,
            "quantity": qty,
            "meta": {"journal_id": entry.id, "close_reason": reason},
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(webhook_url, json=payload)
            resp.raise_for_status()

    async def _dispatch_signalstack(self, broker: BrokerModel, alert: dict) -> None:
        # SignalStack: HTTP POST with JSON placeholder payload. The broker's
        # api_key field holds the SignalStack webhook URL.
        webhook_url = decrypt(broker.api_key)
        if not webhook_url:
            raise ValueError("signalstack webhook URL not configured")
        payload = {
            "action": alert["side"],
            "ticker": alert["symbol"],
            "quantity": alert["qty"],
            "price": alert["entry_price"],
            "stop_loss": alert["stop_loss"],
            "take_profit": alert["take_profit"],
            "meta": {
                "grade": alert["grade"],
                "setup_id": alert["setup_id"],
                "journal_id": alert["journal_id"],
                "signal_time": alert["signal_time"],
            },
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(webhook_url, json=payload)
            resp.raise_for_status()
