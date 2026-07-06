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

try:  # optional SDK
    import alpaca_trade_api  # type: ignore

    HAS_ALPACA_SDK = True
except Exception:  # pragma: no cover - environment dependent
    alpaca_trade_api = None
    HAS_ALPACA_SDK = False


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

    async def dispatch(self, journal_entry: JournalModel) -> List[dict]:
        alert = format_alert(journal_entry)
        results = []
        for broker in await self._active_brokers():
            try:
                if broker.type == "alpaca":
                    await self._dispatch_alpaca(broker, alert)
                elif broker.type == "signalstack":
                    await self._dispatch_signalstack(broker, alert)
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
        if HAS_ALPACA_SDK:
            api = alpaca_trade_api.REST(api_key, secret, base_url=settings.alpaca_trading_url)
            api.submit_order(**order)
            return
        headers = {"APCA-API-KEY-ID": api_key, "APCA-API-SECRET-KEY": secret}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{settings.alpaca_trading_url}/v2/orders", json=order, headers=headers
            )
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
