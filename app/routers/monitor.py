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


@router.get("/api/config")
async def app_config():
    from app.config import settings

    return {"screener_url": settings.screener_url}


@router.get("/api/screener/market")
async def screener_market():
    """Live market context from the screener's Market engine
    (/api/market/snapshot), refreshed every screener cycle."""
    return monitor.screener_service.market_snapshot or {}


@router.get("/api/screener/registry")
async def screener_registry():
    """The screener registry as this tool sees it (from the cache the
    ScreenerDataService maintains) — rendered natively in the Screener
    tab, since the screener app refuses iframe embedding."""
    rows = []
    for ctx in monitor.screener_cache.values():
        raw_stock = (ctx.raw or {}).get("stock") if isinstance(ctx.raw, dict) else {}
        if not isinstance(raw_stock, dict):
            raw_stock = {}
        rows.append(
            {
                "ticker": ctx.stock,
                "inShortlist": ctx.inShortlist,
                "bias": ctx.bias,
                "score": ctx.score,
                "price": raw_stock.get("price"),
                "change": raw_stock.get("change"),
                "rvol": ctx.rvol,
                "gapPct": ctx.gapPct,
                "sector": ctx.sector,
                "regime": ctx.regime,
                "secBias": ctx.secBias,
                "secHot": ctx.secHot,
                "secScore": ctx.secScore,
                "themes": ctx.themes,
                "catalyst": ctx.catalyst,
                "updated_at": ctx.updated_at,
            }
        )
    rows.sort(key=lambda r: -(r["score"] or 0))
    return rows


@router.get("/api/primitives")
async def list_primitives():
    from app import qp_loader
    import qp

    if qp_loader.VERIFIED:
        return [
            {
                "key": meta.key,
                "name": meta.name,
                "group": meta.group,
                "description": meta.description,
                "inputs": list(meta.inputs),
                "outputs": list(meta.outputs),
                "params": [
                    {"name": p.name, "kind": p.kind, "default": p.default,
                     "min": p.min, "max": p.max, "description": p.description}
                    for p in meta.params
                ],
                "source": "verified",
            }
            for meta in qp.approved_primitives().values()
        ]
    return [
        {"key": p.key, "description": p.description, "params": p.params,
         "source": "placeholder-unverified"}
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
