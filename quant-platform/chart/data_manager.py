"""
Data Manager — fetch + cache OHLCV, auto-extend history for indicator warm-up,
and serve incremental "tail" bars for live streaming.

Wraps the same tools/data loaders (alpaca / polygon / hybrid) the compare
tool uses, so the chart, the compare tool, backtests and live all pull bars
from one place.
"""

from __future__ import annotations

import math

import pandas as pd

from tools.data import alpaca, polygon, hybrid

LOADERS = {'alpaca': alpaca, 'polygon': polygon, 'hybrid': hybrid}

# RTH minutes per trading day (09:30-16:00). Used to translate an indicator's
# bar-lookback into how many calendar days of history to fetch.
_RTH_MIN = 390
_TF_MIN = {'1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': _RTH_MIN}


def feed_ok(feed: str) -> bool:
    import os
    if feed == 'alpaca':
        return bool(os.environ.get('APCA_API_KEY_ID') and os.environ.get('APCA_API_SECRET_KEY'))
    if feed == 'polygon':
        return bool(os.environ.get('POLYGON_API_KEY'))
    if feed == 'hybrid':
        return feed_ok('alpaca') and feed_ok('polygon')
    return False


def required_days(overlays: list, tf: str, base_days: int) -> int:
    """Bump `base_days` up so the heaviest indicator has enough history.

    Looks at each overlay's length/period param (or a known floor for
    history-hungry bars-primitives), converts the bar-lookback into calendar
    days for the chart timeframe, and returns max(base_days, needed)."""
    try:
        from qp.registry import REGISTRY
    except Exception:
        return int(base_days)
    tf_min = _TF_MIN.get(tf, 5)
    need_bars = 0
    for ov in overlays or []:
        key = ov.get('key')
        m = REGISTRY.get(key)
        if not m:
            continue
        params = ov.get('params') or {}
        # explicit length-like params
        for pname in ('length', 'period', 'len', 'pivot_period', 'atr_length'):
            if pname in params:
                try:
                    need_bars = max(need_bars, int(params[pname]))
                except (TypeError, ValueError):
                    pass
        # history-hungry engines with an implicit floor
        floor = {'dynamic_sr': 320, 'gap': 60}.get(m.name, 0)
        # multi-session vwap / levels want several days regardless of length
        if m.group in ('vwap', 'levels') and m.name not in ('session',):
            floor = max(floor, 3 * _RTH_MIN)
        need_bars = max(need_bars, floor)
    if need_bars <= 0:
        return int(base_days)
    # bars -> RTH days (+40% buffer for weekends/holidays), min 1
    need_days = math.ceil(need_bars * tf_min / _RTH_MIN * 1.4) + 1
    return max(int(base_days), need_days)


def load_bars(symbol: str, tf: str, days: int, feed: str,
              end: pd.Timestamp | None = None) -> pd.DataFrame:
    """Fetch OHLCV bars, honoring the Alpaca 1m history cap."""
    loader = LOADERS.get(feed)
    if loader is None:
        raise ValueError(f'unknown feed {feed!r} (have {sorted(LOADERS)})')
    end = end or pd.Timestamp.now(tz='UTC').floor('min')
    days = int(days)
    if tf == '1m' and feed == 'alpaca':
        days = min(days, 7)                 # Alpaca IEX 1m cap
    start = end - pd.Timedelta(days=days)
    return loader.load(symbol, tf, start, end)


def latest_tail(symbol: str, tf: str, feed: str, lookback_days: int = 2) -> pd.DataFrame:
    """A short recent window for live polling — cheap to refetch each tick."""
    return load_bars(symbol, tf, lookback_days, feed)
