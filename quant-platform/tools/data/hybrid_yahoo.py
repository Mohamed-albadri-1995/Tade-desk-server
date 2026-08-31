"""Hybrid feed: Polygon history + Yahoo for the most recent bars.

WHY THIS EXISTS ALONGSIDE `hybrid`.

The two sources this platform can join are chosen for opposite strengths:

    Polygon   deep history, full premarket, CONSOLIDATED volume — but the
              free plan is end-of-day delayed, so its last bar is usually
              yesterday's close
    Yahoo     no key, arrives during the session, CONSOLIDATED volume — but
              at most a week of 1-minute history and a month of 5/15-minute

Neither answers "a year of history AND what is happening now". Joined, they
do, and the join is the point of this file.

THE DIFFERENCE FROM `hybrid`, AND IT IS THE WHOLE REASON THIS EXISTS.

`hybrid` fills the same gap with Alpaca, whose free tier is IEX only — a
single venue carrying a few percent of the tape. That module's own docstring
warns that at the seam "the volume column drops sharply", which is harmless
for price primitives and DISTORTS every volume-weighted one: any vwap.*, any
ma.vwma. On a desk whose entry rule is an extension from session VWAP and
whose stop IS the session VWAP, a feed that quietly changes what VWAP means
partway through the morning is not a smaller version of the right answer.

Yahoo's volume is consolidated, like Polygon's. So this seam changes the
SOURCE of the bars without changing what a bar means, and a VWAP computed
across it is the same quantity on both sides.

WHAT IS STILL A SEAM, said plainly rather than hidden:

    THE PRICES COME FROM DIFFERENT TAPES and will not agree to the cent.
    Both are consolidated, so they agree closely; they are not identical.

    YAHOO'S HISTORY IS SHALLOW, so the gap it is asked to fill must be
    small. It normally is — Polygon reaches yesterday's close and the gap is
    today — but a Polygon outage would ask Yahoo for a window it cannot
    serve, and then this returns what it has rather than pretending.

    EXTENDED HOURS. Polygon's history includes the premarket, so the Yahoo
    portion is fetched with prepost=True to match. A seam where the
    premarket simply stops existing would read as "the stock did not trade
    before the open today", which is a statement about the world rather than
    about the feed.

FALLS BACK RATHER THAN FAILING. If one source is unreachable this returns
the other, because a chart with half the window beats no chart. Which half
is reported by `seam()` so a caller can say so.
"""

from __future__ import annotations

import pandas as pd

from tools.data import polygon, yahoo

_COLS = ['open', 'high', 'low', 'close', 'volume']


def load(symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp,
         feed: str = 'hybrid_yahoo') -> pd.DataFrame:
    """Polygon up to its last bar, Yahoo appended for the gap to `end`."""
    poly_df = None
    yah_df = None
    poly_err = yah_err = None

    try:
        poly_df = polygon.load(symbol, timeframe, start, end)
    except Exception as e:                       # deep history source
        poly_err = e

    have_poly = poly_df is not None and len(poly_df)
    # Append strictly AFTER Polygon's last bar. Overlapping the two would put
    # two different tapes' versions of the same minute in the frame, and the
    # de-duplication below would pick one silently.
    gap_start = poly_df.index[-1] if have_poly else start

    try:
        # PREPOST, to match the premarket Polygon has already supplied. See the
        # module note: a seam where the premarket stops existing is a claim
        # about the stock rather than about the feed.
        yah_df = yahoo.load(symbol, timeframe, gap_start, end, prepost=True)
    except Exception as e:                       # live gap-fill source
        yah_err = e

    frames = []
    if have_poly:
        frames.append(poly_df)
    if yah_df is not None and len(yah_df):
        if have_poly:
            yah_df = yah_df[yah_df.index > poly_df.index[-1]]
        if len(yah_df):
            frames.append(yah_df)

    if not frames:
        raise RuntimeError(
            f'hybrid_yahoo: neither source returned bars for {symbol} '
            f'{timeframe} (polygon: {poly_err}; yahoo: {yah_err})')

    df = pd.concat(frames)
    # Polygon wins a tie: it is the consolidated, settled record, and Yahoo is
    # here for the minutes Polygon has not published yet.
    df = df[~df.index.duplicated(keep='first')].sort_index()
    return df[_COLS].astype(float)


def seam(symbol: str, timeframe: str, start: pd.Timestamp, end: pd.Timestamp):
    """Where the join actually fell, for anything that needs to SAY so.

    Returns {ok, seam_ts, polygon_bars, yahoo_bars, polygon_error,
    yahoo_error}. Never raises — this describes a fetch, and a description
    that can fail is not one you can put on a page.

    It re-fetches rather than being returned by load(), because load() has to
    keep the loader signature every other feed has: chart/data_manager.py
    calls them all the same way, and a feed with a different return type would
    be a special case in every caller.
    """
    out = {'ok': False, 'seam_ts': None, 'polygon_bars': 0, 'yahoo_bars': 0,
           'polygon_error': None, 'yahoo_error': None}
    try:
        p = polygon.load(symbol, timeframe, start, end)
        out['polygon_bars'] = int(len(p))
        if len(p):
            out['seam_ts'] = p.index[-1].isoformat()
    except Exception as e:                       # noqa: BLE001 — described, not raised
        out['polygon_error'] = str(e)[:200]
        p = None
    try:
        gap = p.index[-1] if (p is not None and len(p)) else start
        y = yahoo.load(symbol, timeframe, gap, end, prepost=True)
        if p is not None and len(p):
            y = y[y.index > p.index[-1]]
        out['yahoo_bars'] = int(len(y))
    except Exception as e:                       # noqa: BLE001
        out['yahoo_error'] = str(e)[:200]
    out['ok'] = bool(out['polygon_bars'] or out['yahoo_bars'])
    return out
