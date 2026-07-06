"""Watchlist import (spec section 7): accepts .csv and .json uploads,
extracts the ``ticker`` field from each record and stores the symbols.
"""

import csv
import io
import json

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models import WatchlistModel
from app.schemas import WatchlistOut
from app.services.monitor import monitor

router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])


def _extract_ticker(record) -> str | None:
    if isinstance(record, str):
        return record.strip().upper() or None
    if isinstance(record, dict):
        for key in ("ticker", "Ticker", "TICKER", "symbol", "Symbol"):
            value = record.get(key)
            if value:
                return str(value).strip().upper()
    return None


def parse_watchlist_file(filename: str, content: bytes) -> list[str]:
    name = (filename or "").lower()
    text = content.decode("utf-8-sig", errors="replace")
    tickers: list[str] = []

    if name.endswith(".json"):
        data = json.loads(text)
        records = data if isinstance(data, list) else data.get("tickers") or data.get("symbols") or []
        for record in records:
            ticker = _extract_ticker(record)
            if ticker:
                tickers.append(ticker)
    elif name.endswith(".csv"):
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames and any(
            f and f.strip().lower() in ("ticker", "symbol") for f in reader.fieldnames
        ):
            for row in reader:
                ticker = _extract_ticker(row)
                if ticker:
                    tickers.append(ticker)
        else:
            # Headerless CSV: treat the first column of every row as the ticker.
            for row in csv.reader(io.StringIO(text)):
                if row and row[0].strip():
                    tickers.append(row[0].strip().upper())
    else:
        raise HTTPException(422, "watchlist file must have a .csv or .json extension")

    # De-duplicate, preserving order.
    seen = set()
    unique = []
    for t in tickers:
        if t not in seen:
            seen.add(t)
            unique.append(t)
    return unique


@router.get("", response_model=WatchlistOut | None)
async def get_watchlist(session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(WatchlistModel).order_by(WatchlistModel.uploaded_at.desc())
    )
    return result.scalars().first()


@router.post("/upload", response_model=WatchlistOut, status_code=201)
async def upload_watchlist(file: UploadFile, session: AsyncSession = Depends(get_session)):
    content = await file.read()
    symbols = parse_watchlist_file(file.filename, content)
    if not symbols:
        raise HTTPException(422, "no tickers found in the uploaded file")
    watchlist = WatchlistModel(symbols=symbols)
    session.add(watchlist)
    await session.commit()
    await session.refresh(watchlist)
    # Restart the data feeds with the new symbol list.
    await monitor.restart()
    return watchlist
