"""EventBus (spec 3.10): fan-out JSON payloads to all WebSocket clients."""

import asyncio
import json
import logging
from datetime import date, datetime
from typing import List

from fastapi import WebSocket

logger = logging.getLogger(__name__)


def _json_default(obj):
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    return str(obj)


class EventBus:
    def __init__(self):
        self._connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.append(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self._connections:
                self._connections.remove(websocket)

    async def publish(self, message: dict) -> None:
        payload = json.dumps(message, default=_json_default)
        async with self._lock:
            connections = list(self._connections)
        dead = []
        for ws in connections:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    if ws in self._connections:
                        self._connections.remove(ws)


event_bus = EventBus()
