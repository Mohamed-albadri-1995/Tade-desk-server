"""MarketDataService (spec 3.1).

Asynchronous loop fetching RAW OHLCV bars from Alpaca, with Polygon and
Yahoo Finance fallbacks. Updates::

    market_cache[stock] = {"bars": [...], "price": float, "timestamp": datetime}

every ``market_refresh_interval`` seconds (default 5).
Bars are dicts: {timestamp, open, high, low, close, volume}.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class MarketDataService:
    def __init__(self, market_cache: Dict[str, dict]):
        self.market_cache = market_cache
        self.refresh_interval = 5
        self.lookback_bars = 5000
        self._task: Optional[asyncio.Task] = None
        self._symbols: List[str] = []
        self._client: Optional[httpx.AsyncClient] = None

    # ------------------------------------------------------------------ API

    async def start(self, symbols: List[str]) -> None:
        await self.stop()
        self._symbols = [s.upper() for s in symbols]
        if not self._symbols:
            return
        self._client = httpx.AsyncClient(timeout=15.0)
        self._task = asyncio.create_task(self._run(), name="market-data-loop")
        logger.info("MarketDataService started for %d symbols", len(self._symbols))

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

    @property
    def symbols(self) -> List[str]:
        return list(self._symbols)

    # ----------------------------------------------------------------- loop

    async def _run(self) -> None:
        # Bounded fan-out: sequential fetching cannot keep a large
        # screener-fed watchlist fresh at a 5s interval.
        semaphore = asyncio.Semaphore(8)

        async def fetch_one(symbol: str) -> None:
            async with semaphore:
                try:
                    bars = await self._fetch_bars(symbol)
                    if bars:
                        self.market_cache[symbol] = {
                            "bars": bars[-self.lookback_bars:],
                            "price": bars[-1]["close"],
                            "timestamp": datetime.utcnow(),
                        }
                except Exception as exc:
                    logger.warning("market data fetch failed for %s: %s", symbol, exc)

        while True:
            started = asyncio.get_event_loop().time()
            await asyncio.gather(*(fetch_one(s) for s in self._symbols))
            elapsed = asyncio.get_event_loop().time() - started
            await asyncio.sleep(max(0.5, self.refresh_interval - elapsed))

    # ------------------------------------------------------------- fetchers

    async def _fetch_bars(self, symbol: str) -> List[dict]:
        for fetcher in (self._fetch_alpaca, self._fetch_polygon, self._fetch_yahoo):
            try:
                bars = await fetcher(symbol)
                if bars:
                    return bars
            except Exception as exc:
                logger.debug("%s failed for %s: %s", fetcher.__name__, symbol, exc)
        return []

    async def _fetch_alpaca(self, symbol: str) -> List[dict]:
        if not settings.alpaca_api_key:
            return []
        url = f"{settings.alpaca_data_url}/v2/stocks/{symbol}/bars"
        params = {
            "timeframe": "1Min",
            "limit": min(self.lookback_bars, 10000),
            "adjustment": "raw",
            "feed": "iex",
        }
        headers = {
            "APCA-API-KEY-ID": settings.alpaca_api_key,
            "APCA-API-SECRET-KEY": settings.alpaca_secret_key,
        }
        resp = await self._client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        raw = resp.json().get("bars") or []
        return [
            {
                "timestamp": b["t"],
                "open": float(b["o"]),
                "high": float(b["h"]),
                "low": float(b["l"]),
                "close": float(b["c"]),
                "volume": float(b["v"]),
            }
            for b in raw
        ]

    async def _fetch_polygon(self, symbol: str) -> List[dict]:
        if not settings.polygon_api_key:
            return []
        end = datetime.utcnow()
        start = end - timedelta(days=10)
        url = (
            f"https://api.polygon.io/v2/aggs/ticker/{symbol}/range/1/minute/"
            f"{start.date()}/{end.date()}"
        )
        params = {"limit": 50000, "sort": "asc", "apiKey": settings.polygon_api_key}
        resp = await self._client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json().get("results") or []
        return [
            {
                "timestamp": datetime.utcfromtimestamp(b["t"] / 1000).isoformat() + "Z",
                "open": float(b["o"]),
                "high": float(b["h"]),
                "low": float(b["l"]),
                "close": float(b["c"]),
                "volume": float(b.get("v", 0)),
            }
            for b in raw
        ]

    async def _fetch_yahoo(self, symbol: str) -> List[dict]:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        params = {"interval": "1m", "range": "5d", "includePrePost": "true"}
        headers = {"User-Agent": "Mozilla/5.0 (trade-desk)"}
        resp = await self._client.get(url, params=params, headers=headers)
        resp.raise_for_status()
        result = (resp.json().get("chart") or {}).get("result") or []
        if not result:
            return []
        data = result[0]
        timestamps = data.get("timestamp") or []
        quote = ((data.get("indicators") or {}).get("quote") or [{}])[0]
        opens = quote.get("open") or []
        highs = quote.get("high") or []
        lows = quote.get("low") or []
        closes = quote.get("close") or []
        volumes = quote.get("volume") or []

        def at(arr, i):
            return arr[i] if i < len(arr) else None

        bars = []
        for i, ts in enumerate(timestamps):
            o, h, l, c = at(opens, i), at(highs, i), at(lows, i), at(closes, i)
            if None in (o, h, l, c):
                continue
            v = at(volumes, i) or 0
            bars.append(
                {
                    "timestamp": datetime.utcfromtimestamp(ts).isoformat() + "Z",
                    "open": float(o),
                    "high": float(h),
                    "low": float(l),
                    "close": float(c),
                    "volume": float(v),
                }
            )
        return bars
