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
_TF_MIN = {'1m': 1, '2m': 2, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': _RTH_MIN}


def feed_ok(feed: str) -> bool:
    import os
    if feed == 'alpaca':
        return bool(os.environ.get('APCA_API_KEY_ID') and os.environ.get('APCA_API_SECRET_KEY'))
    if feed == 'polygon':
        return bool(os.environ.get('POLYGON_API_KEY'))
    if feed == 'hybrid':
        return feed_ok('alpaca') and feed_ok('polygon')
    return False


# A multi-session VWAP / level needs its history in CALENDAR days, not bars:
# a 1-month VWAP wants ~a month of history whether the chart is 1m or 1h. So
# these groups get a flat calendar-day floor, timeframe-independent. 40 days
# covers 1-month VWAP/levels, 1-week VWAP, 5-day MA, prior-week/prior-month —
# the things the user said must never be silently wrong. (Yearly / prior-year
# anchors would need ~365d; those are intentionally NOT force-covered — a stray
# yearly level is acceptable, a wrong 1-month VWAP is not.)
_HISTORY_GROUPS = {'vwap', 'levels', 'pivots', 'structure', 'dynamic_sr'}
_HISTORY_FLOOR_DAYS = 40

# Ceiling per timeframe so a heavy combo can't fetch a pathological window and
# OOM a small box. Comfortably above the 40-day floor for the ones that matter.
_MAX_DAYS = {'1m': 60, '2m': 90, '5m': 120, '15m': 250, '30m': 400, '1h': 500, '1d': 800}


def _bars_to_days(bars: int, tf: str, buffer: int = 2) -> int:
    """A bar-count lookback (e.g. a 200-bar EMA) → calendar days for `tf`,
    +40% for weekends/holidays."""
    tf_min = _TF_MIN.get(tf, 5)
    return math.ceil(bars * tf_min / _RTH_MIN * 1.4) + buffer


def required_days(overlays: list, tf: str, base_days: int) -> int:
    """Bump `base_days` up so the heaviest indicator has enough warm-up.

    Works in calendar days so it's timeframe-invariant: multi-session
    VWAPs / levels get a flat 40-day floor; N-session windows (N-day VWAP)
    scale by their session count; pure bar-count lookbacks (EMA length,
    pivot left/right) convert bars→days. Capped per timeframe to protect the
    host from an unbounded fetch."""
    try:
        from qp.registry import REGISTRY
    except Exception:
        return int(base_days)
    need_days = 0
    for ov in overlays or []:
        m = REGISTRY.get(ov.get('key'))
        if not m:
            continue
        # PARAM DEFAULTS: the picker sends only what the user typed, so a
        # primitive left on its defaults (ma.pine_5day length=1950 = 5 RTH
        # days) arrived here as {} and got NO warm-up bump at all. Fill the
        # registry defaults in first, then size the window.
        params = dict(ov.get('params') or {})
        for prm in (m.params or ()):
            params.setdefault(prm.name, prm.default)
        # bar-count lookbacks must be converted on the timeframe the primitive
        # is actually COMPUTED on: pine_5day's 1950 bars are 1-MINUTE bars
        # (compute_tf='1m') = 5 sessions, whether you view 1m, 5m or 15m.
        # Using the chart tf turned that into a 107-day fetch on a 15m chart.
        btf = getattr(m, 'compute_tf', None) or tf
        # 1) explicit SESSION-count window (N-day VWAP, N-session lookbacks).
        #    These count trading days → ~1.7x calendar + a week of buffer.
        for pname in ('n_days', 'sessions', 'days', 'lookback_days'):
            if pname in params:
                try:
                    need_days = max(need_days, math.ceil(int(params[pname]) * 1.7) + 7)
                except (TypeError, ValueError):
                    pass
        # 2) multi-session VWAP / levels / structure / pivots: flat calendar floor.
        if m.group in _HISTORY_GROUPS:
            need_days = max(need_days, _HISTORY_FLOOR_DAYS)
        # 3) dynamic_sr's ~300-bar range window can exceed the floor on coarse TFs.
        if m.name == 'dynamic_sr':
            need_days = max(need_days, _bars_to_days(320, btf))
        # 4) pure bar-count lookbacks (EMA/SMA length, pivot left/right, swing).
        for pname in ('length', 'period', 'len', 'pivot_period', 'atr_length',
                      'left', 'right', 'lookback'):
            if pname in params:
                try:
                    need_days = max(need_days, _bars_to_days(int(params[pname]), btf))
                except (TypeError, ValueError):
                    pass
    if need_days <= 0:
        return int(base_days)
    # The ceiling bounds the WARM-UP BUMP, never the caller's own request:
    # capping the max() would let ADDING an indicator SHRINK the window
    # (a 200-day 5m request came back as 120 days the moment any overlay was
    # attached). Cap the bump, then honour whichever is larger.
    return max(int(base_days), min(need_days, _MAX_DAYS.get(tf, 400)))


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
