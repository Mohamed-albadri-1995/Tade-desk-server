"""ScreenerDataService (spec 3.2).

Asynchronous loop fetching from ``SCREENER_URL/api/registry``, parsing
each record into a ``TickerContext`` dataclass and updating
``screener_cache[stock]`` every ``screener_refresh_interval`` seconds
(default 15).
"""

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class TickerContext:
    stock: str
    regime: Optional[str] = None
    secBias: Optional[str] = None
    secHot: Optional[bool] = None
    secScore: Optional[float] = None
    sector: Optional[str] = None
    themes: List[str] = field(default_factory=list)
    score: Optional[float] = None
    rvol: Optional[float] = None
    gapPct: Optional[float] = None
    catalyst: Optional[str] = None
    updated_at: Optional[str] = None
    raw: dict = field(default_factory=dict)  # full registry record for the gate snapshot

    def snapshot(self) -> dict:
        data = asdict(self)
        return data


def _parse_record(record: dict) -> Optional[TickerContext]:
    stock = record.get("ticker") or record.get("stock") or record.get("symbol")
    if not stock:
        return None
    context = record.get("context") or {}
    stock_fields = record.get("stock") if isinstance(record.get("stock"), dict) else {}

    def pick(*keys):
        for source in (record, context, stock_fields or {}):
            for key in keys:
                if isinstance(source, dict) and source.get(key) is not None:
                    return source.get(key)
        return None

    return TickerContext(
        stock=str(stock).upper(),
        regime=pick("regime"),
        secBias=pick("secBias", "sectorBias"),
        secHot=pick("secHot", "sectorHot"),
        secScore=pick("secScore", "sectorScore"),
        sector=pick("sector"),
        themes=pick("themes") or [],
        score=pick("score", "totalScore"),
        rvol=pick("rvol"),
        gapPct=pick("gapPct", "gap_pct"),
        catalyst=pick("catalyst", "catalystLabel"),
        updated_at=datetime.utcnow().isoformat() + "Z",
        raw=record,
    )


class ScreenerDataService:
    def __init__(self, screener_cache: Dict[str, TickerContext]):
        self.screener_cache = screener_cache
        self.refresh_interval = 15
        self._task: Optional[asyncio.Task] = None
        self._symbols: List[str] = []
        self._client: Optional[httpx.AsyncClient] = None

    async def start(self, symbols: List[str]) -> None:
        await self.stop()
        self._symbols = [s.upper() for s in symbols]
        self._client = httpx.AsyncClient(timeout=15.0)
        self._task = asyncio.create_task(self._run(), name="screener-data-loop")
        logger.info("ScreenerDataService started (%s)", settings.screener_url)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._client:
            await self._client.aclose()
            self._client = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def _run(self) -> None:
        while True:
            try:
                await self._refresh()
            except Exception as exc:
                logger.warning("screener fetch failed: %s", exc)
            await asyncio.sleep(self.refresh_interval)

    async def _refresh(self) -> None:
        url = f"{settings.screener_url.rstrip('/')}/api/registry"
        resp = await self._client.get(url)
        resp.raise_for_status()
        payload = resp.json()
        records = payload if isinstance(payload, list) else (
            payload.get("registry") or payload.get("rows") or payload.get("data") or []
        )
        watch = set(self._symbols)
        for record in records:
            if not isinstance(record, dict):
                continue
            ctx = _parse_record(record)
            if ctx is None:
                continue
            if watch and ctx.stock not in watch:
                continue
            self.screener_cache[ctx.stock] = ctx
