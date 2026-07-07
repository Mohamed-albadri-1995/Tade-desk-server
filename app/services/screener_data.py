"""ScreenerDataService (spec 3.2).

Asynchronous loop fetching the screener registry, parsing each r0 record
into a ``TickerContext`` dataclass and updating ``screener_cache[stock]``
every ``screener_refresh_interval`` seconds (default 15).

The screener tool (Market Tab spec §9) serves ``/api/registry/today``
(today's r0 rows) and ``/api/registry/all``; the v11 trading-tool spec
referenced ``/api/registry``. We try them in that order and stick with
the first path that answers.
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
    bias: Optional[str] = None  # user's manual override in the screener (auto|long|short)
    inShortlist: Optional[bool] = None
    updated_at: Optional[str] = None
    raw: dict = field(default_factory=dict)  # full registry record for the gate snapshot

    def snapshot(self) -> dict:
        data = asdict(self)
        return data


def _parse_record(record: dict) -> Optional[TickerContext]:
    """Parse one screener r0 row: ticker at top level, indicator fields in
    the ``stock`` dict, market context in ``context``, score in ``_score``
    (Market Tab spec §1). Falls back to flat keys for older payloads."""
    ticker = record.get("ticker") or record.get("symbol")
    if not ticker and not isinstance(record.get("stock"), dict):
        ticker = record.get("stock")
    if not ticker:
        return None
    context = record.get("context") if isinstance(record.get("context"), dict) else {}
    stock_fields = record.get("stock") if isinstance(record.get("stock"), dict) else {}

    def pick(*keys):
        for source in (record, context, stock_fields):
            for key in keys:
                if isinstance(source, dict) and source.get(key) is not None:
                    return source.get(key)
        return None

    catalyst = pick("catalyst", "catalystLabel")
    if isinstance(catalyst, dict):  # r0 catalyst is an object with a label
        catalyst = catalyst.get("label") or catalyst.get("type")

    return TickerContext(
        stock=str(ticker).upper(),
        regime=pick("regime"),
        secBias=pick("secBias", "sectorBias"),
        secHot=pick("secHot", "sectorHot"),
        secScore=pick("secScore", "sectorScore"),
        sector=pick("sector", "broadResolved"),
        themes=pick("themes") or [],
        score=record.get("_score") if record.get("_score") is not None else pick("score", "score_at_entry", "totalScore"),
        rvol=pick("rvol"),
        gapPct=pick("gapPct", "gap_pct"),
        catalyst=catalyst,
        bias=record.get("bias"),
        inShortlist=record.get("inShortlist"),
        updated_at=datetime.utcnow().isoformat() + "Z",
        raw=record,
    )


# Tried in order; the first path that answers is kept for the session.
REGISTRY_PATHS = ("/api/registry/today", "/api/registry", "/api/registry/all")


class ScreenerDataService:
    def __init__(self, screener_cache: Dict[str, TickerContext]):
        self.screener_cache = screener_cache
        self.refresh_interval = 15
        self._task: Optional[asyncio.Task] = None
        self._symbols: List[str] = []
        self._client: Optional[httpx.AsyncClient] = None
        self._registry_path: Optional[str] = None  # discovered working path
        self.include_shortlist = False  # set when the watchlist source is 'shortlist'
        self.shortlist: List[str] = []  # tickers from /api/shortlist/today

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

    async def _fetch_registry(self):
        base = settings.screener_url.rstrip("/")
        paths = (self._registry_path,) if self._registry_path else REGISTRY_PATHS
        last_error = None
        for path in paths:
            try:
                resp = await self._client.get(f"{base}{path}")
                resp.raise_for_status()
                if self._registry_path != path:
                    logger.info("screener registry found at %s%s", base, path)
                    self._registry_path = path
                return resp.json()
            except Exception as exc:
                last_error = exc
        self._registry_path = None  # rediscover next cycle
        raise last_error if last_error else RuntimeError("no registry path configured")

    async def _refresh(self) -> None:
        payload = await self._fetch_registry()
        records = payload if isinstance(payload, list) else (
            payload.get("registry")
            or payload.get("rows")
            or payload.get("r0")
            or payload.get("items")
            or payload.get("data")
            or []
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

        if self.include_shortlist:
            await self._refresh_shortlist()

    async def _refresh_shortlist(self) -> None:
        """Today's shortlist — the user's curated watchlist in the screener
        (/api/shortlist/today -> {date, items: [{ticker, ...}]})."""
        try:
            base = settings.screener_url.rstrip("/")
            resp = await self._client.get(f"{base}/api/shortlist/today")
            resp.raise_for_status()
            payload = resp.json() or {}
            items = payload.get("items") or []
            self.shortlist = [
                str(item["ticker"]).upper()
                for item in items
                if isinstance(item, dict) and item.get("ticker")
            ]
        except Exception as exc:
            logger.warning("shortlist fetch failed (keeping previous): %s", exc)
