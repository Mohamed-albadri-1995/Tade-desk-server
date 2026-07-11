"""BrokerEngine (spec 3.8) — standard-order fan-out.

The pipeline sizes ONE canonical "standard order" against the standard
account (the primary account, default $100k): symbol, side, standard
qty, order type, SL, TP. Every active broker then customises it:

* ``scale``    — that broker's account size relative to the standard
                 account (0.25 = quarter, 2.0 = double). Applied to
                 entry AND exit quantities, floored (never rounds
                 exposure up); a qty that floors to 0 skips the broker.
* ``exit_mode``— 'bracket': SL/TP legs ride with the entry order
                 (broker-side protection that survives this server);
                 'at_exit': plain entry, the tool sends the exit order
                 when its own monitor triggers.
* ``type``     — 'alpaca' (REST orders), 'signalstack' (webhook JSON),
                 'paper' (no external call; the journal is the fill —
                 the always-on baseline track the learning engine
                 trains on).

Dispatch failures are logged per broker and never break the pipeline.
"""

import logging
import math
from typing import List, Optional

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import async_session_factory
from app.models import BrokerModel, JournalModel
from app.security import decrypt

logger = logging.getLogger(__name__)

VALID_BROKER_TYPES = ("alpaca", "signalstack", "paper")
VALID_EXIT_MODES = ("bracket", "at_exit")


def standard_order_from_entry(journal_entry: JournalModel) -> dict:
    """The canonical order the pipeline produced, sized for the standard
    account. Stored on the card in entry_factors.standard_order too."""
    factors = journal_entry.entry_factors or {}
    return factors.get("standard_order") or {
        "symbol": journal_entry.stock,
        "side": "buy" if journal_entry.signal_side == "long" else "sell",
        "qty": int(journal_entry.entry_shares or 0),
        "order_type": "market",
        "limit_price": None,
        "stop_loss": journal_entry.entry_sl_price,
        "take_profit": journal_entry.entry_tp_price,
        "time_in_force": "day",
    }


def scaled_qty(standard_qty: int, scale: float) -> int:
    """Floor — a broker never gets MORE exposure than its scale allows."""
    return max(0, int(math.floor((standard_qty or 0) * (scale or 0.0))))


def build_entry_order(standard: dict, scale: float, exit_mode: str) -> Optional[dict]:
    """Translate the standard order for one broker (pure function)."""
    qty = scaled_qty(standard["qty"], scale)
    if qty <= 0:
        return None
    order = {
        "symbol": standard["symbol"],
        "qty": qty,
        "side": standard["side"],
        "type": standard.get("order_type") or "market",
        "time_in_force": standard.get("time_in_force") or "day",
    }
    if order["type"] == "limit" and standard.get("limit_price") is not None:
        order["limit_price"] = round(float(standard["limit_price"]), 2)
    else:
        order["type"] = "market"
    if exit_mode == "bracket":
        sl, tp = standard.get("stop_loss"), standard.get("take_profit")
        if sl is not None and tp is not None:
            order["order_class"] = "bracket"
            order["stop_loss"] = {"stop_price": round(float(sl), 2)}
            order["take_profit"] = {"limit_price": round(float(tp), 2)}
        elif sl is not None:
            order["order_class"] = "oto"
            order["stop_loss"] = {"stop_price": round(float(sl), 2)}
    return order


class BrokerEngine:
    async def _active_brokers(self) -> List[BrokerModel]:
        async with async_session_factory() as session:
            result = await session.execute(select(BrokerModel).where(BrokerModel.is_active == True))  # noqa: E712
            return list(result.scalars().all())

    # -------------------------------------------------------------- entries

    async def dispatch(self, journal_entry: JournalModel) -> List[dict]:
        standard = standard_order_from_entry(journal_entry)
        results = []
        for broker in await self._active_brokers():
            order = build_entry_order(standard, broker.scale, broker.exit_mode or "bracket")
            if order is None:
                results.append({"broker": broker.name, "ok": True, "skipped": "zero shares at scale"})
                continue
            try:
                if broker.type == "alpaca":
                    await self._alpaca_submit(broker, order)
                elif broker.type == "signalstack":
                    await self._signalstack_post(broker, {
                        "action": order["side"], "ticker": order["symbol"],
                        "quantity": order["qty"], "order_type": order["type"],
                        "limit_price": order.get("limit_price"),
                        "stop_loss": standard.get("stop_loss") if broker.exit_mode == "bracket" else None,
                        "take_profit": standard.get("take_profit") if broker.exit_mode == "bracket" else None,
                        "meta": {"journal_id": journal_entry.id, "setup_id": journal_entry.setup_id,
                                 "exit_mode": broker.exit_mode, "scale": broker.scale},
                    })
                elif broker.type == "paper":
                    logger.info("paper broker %s: %s %s x%s (scale %s)", broker.name,
                                order["side"], order["symbol"], order["qty"], broker.scale)
                else:
                    raise ValueError(f"unknown broker type: {broker.type}")
                results.append({"broker": broker.name, "ok": True, "qty": order["qty"],
                                "exit_mode": broker.exit_mode})
            except Exception as exc:
                logger.warning("broker dispatch failed (%s): %s", broker.name, exc)
                results.append({"broker": broker.name, "ok": False, "error": str(exc)})
        return results

    # ---------------------------------------------------------------- exits

    async def dispatch_close(self, journal_entry: JournalModel, reason: str) -> List[dict]:
        """Send the closing order per broker, scaled the same way as the
        entry. For 'bracket' brokers an SL/TP close is usually already
        filled broker-side (404 position-already-flat = success); for
        'at_exit' brokers this IS the exit order for every reason."""
        standard = standard_order_from_entry(journal_entry)
        results = []
        for broker in await self._active_brokers():
            qty = scaled_qty(standard["qty"], broker.scale)
            if qty <= 0:
                results.append({"broker": broker.name, "ok": True, "skipped": "zero shares"})
                continue
            try:
                if broker.type == "alpaca":
                    await self._alpaca_close(broker, journal_entry.stock, qty)
                elif broker.type == "signalstack":
                    await self._signalstack_post(broker, {
                        "action": "sell" if journal_entry.signal_side == "long" else "buy",
                        "ticker": journal_entry.stock, "quantity": qty,
                        "meta": {"journal_id": journal_entry.id, "close_reason": reason},
                    })
                elif broker.type == "paper":
                    logger.info("paper broker %s: close %s x%s (%s)", broker.name,
                                journal_entry.stock, qty, reason)
                results.append({"broker": broker.name, "ok": True, "qty": qty})
            except Exception as exc:
                logger.warning("broker close failed (%s): %s", broker.name, exc)
                results.append({"broker": broker.name, "ok": False, "error": str(exc)})
        return results

    # ------------------------------------------------------------- adapters

    def _alpaca_headers(self, broker: BrokerModel) -> dict:
        return {
            "APCA-API-KEY-ID": decrypt(broker.api_key),
            "APCA-API-SECRET-KEY": decrypt(broker.secret),
        }

    async def _alpaca_submit(self, broker: BrokerModel, order: dict) -> None:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{settings.alpaca_trading_url}/v2/orders",
                json=order, headers=self._alpaca_headers(broker),
            )
            resp.raise_for_status()

    async def _alpaca_close(self, broker: BrokerModel, symbol: str, qty: int) -> None:
        headers = self._alpaca_headers(broker)
        async with httpx.AsyncClient(timeout=15.0) as client:
            # Cancel resting bracket legs first so the close can't double-fill.
            resp = await client.get(
                f"{settings.alpaca_trading_url}/v2/orders",
                params={"status": "open", "symbols": symbol}, headers=headers,
            )
            if resp.status_code == 200:
                for open_order in resp.json():
                    await client.delete(
                        f"{settings.alpaca_trading_url}/v2/orders/{open_order['id']}",
                        headers=headers,
                    )
            resp = await client.delete(
                f"{settings.alpaca_trading_url}/v2/positions/{symbol}",
                params={"qty": qty}, headers=headers,
            )
            if resp.status_code == 404:
                logger.info("alpaca position %s already flat (bracket leg filled)", symbol)
                return
            resp.raise_for_status()

    async def _signalstack_post(self, broker: BrokerModel, payload: dict) -> None:
        webhook_url = decrypt(broker.api_key)
        if not webhook_url:
            raise ValueError("signalstack webhook URL not configured")
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(webhook_url, json=payload)
            resp.raise_for_status()
