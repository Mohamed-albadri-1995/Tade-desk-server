"""Monitor control + status API, plus the WebSocket endpoint."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.event_bus import event_bus
from app.services.monitor import monitor

router = APIRouter(tags=["monitor"])


@router.get("/api/monitor/status")
async def monitor_status():
    return monitor.status()


@router.post("/api/monitor/start")
async def monitor_start():
    await monitor.start()
    return monitor.status()


@router.post("/api/monitor/stop")
async def monitor_stop():
    await monitor.stop()
    return monitor.status()


@router.get("/api/primitives")
async def list_primitives():
    import qp

    return [
        {"key": p.key, "description": p.description, "params": p.params}
        for p in qp.REGISTRY.values()
    ]


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await event_bus.connect(websocket)
    try:
        while True:
            # Clients are consumers; incoming messages are ignored keep-alives.
            await websocket.receive_text()
    except WebSocketDisconnect:
        await event_bus.disconnect(websocket)
    except Exception:
        await event_bus.disconnect(websocket)
