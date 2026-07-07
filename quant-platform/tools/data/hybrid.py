"""
Hybrid feed: Polygon history + Alpaca gap-fill.

Polygon (free tier) is end-of-day delayed, so its most recent bar is
usually yesterday's close — but it has deep history and full premarket.
Alpaca IEX is live but shallow. This feed takes Polygon for everything up
to its last available bar, then appends Alpaca bars *after* that point to
fill the gap up to now. Result: deep history + premarket from Polygon,
today's live NY session from Alpaca.

⚠️ VOLUME SEAM. Polygon volume is consolidated (all exchanges); Alpaca
IEX volume is IEX-only — a small fraction. At the Polygon→Alpaca seam the
volume column drops sharply. This is harmless for PRICE primitives (moving
averages, RSI, ATR, levels, pivots, structure) but DISTORTS the
volume-weighted ones (any vwap.*, ma.vwma) in the Alpaca portion, and
that portion will not match TradingView (which uses consolidated volume).
→ Verify VWAPs on the 'polygon' feed on a completed prior day; use
'hybrid' for price primitives and for seeing today with full history.

Requires BOTH POLYGON_API_KEY and the Alpaca creds. Falls back to
whichever single source is reachable if the other fails.
"""

from __future__ import annotations

import pandas as pd

from tools.data import alpaca, polygon


def load(symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp,
         feed: str = 'hybrid') -> pd.DataFrame:
    """Return a tz-aware UTC OHLCV DataFrame: Polygon up to its last bar,
    Alpaca appended for the remaining gap to `end`."""
    poly_df = None
    alp_df = None
    poly_err = alp_err = None

    try:
        poly_df = polygon.load(symbol, timeframe, start, end)
    except Exception as e:                       # deep history source
        poly_err = e

    if poly_df is not None and len(poly_df):
        gap_start = poly_df.index[-1]            # append strictly after this
    else:
        gap_start = start

    try:
        alp_df = alpaca.load(symbol, timeframe, gap_start, end)
    except Exception as e:                        # live gap-fill source
        alp_err = e

    frames = []
    if poly_df is not None and len(poly_df):
        frames.append(poly_df)
    if alp_df is not None and len(alp_df):
        # keep only Alpaca bars newer than Polygon's last (the gap)
        if poly_df is not None and len(poly_df):
            alp_df = alp_df[alp_df.index > poly_df.index[-1]]
        frames.append(alp_df)

    if not frames:
        raise RuntimeError(
            f'hybrid: neither source returned bars for {symbol} {timeframe} '
            f'(polygon: {poly_err}; alpaca: {alp_err})')

    df = pd.concat(frames)
    df = df[~df.index.duplicated(keep='first')].sort_index()   # Polygon wins ties
    return df[['open', 'high', 'low', 'close', 'volume']].astype(float)
