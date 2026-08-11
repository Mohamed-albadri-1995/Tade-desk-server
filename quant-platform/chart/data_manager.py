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

from tools.data import alpaca, polygon, hybrid, yahoo

LOADERS = {'alpaca': alpaca, 'polygon': polygon, 'hybrid': hybrid,
           # The only feed here that can serve a decision taken DURING the
           # session: polygon is a day behind on the free plan and alpaca's free
           # tier is IEX. Consolidated tape, and measured against polygon on the
           # same morning the two agree on VWAP to within 0.06%.
           'yahoo': yahoo}

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
    # No key to check — which is the point of having it as the live fallback.
    if feed == 'yahoo':
        return True
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

# Primitives whose real warm-up the generic rules CANNOT infer, measured
# empirically (recompute over shrinking histories until today's value stops
# changing — see logic_audit30). Without these the line is drawn from the
# wrong anchor and looks perfectly plausible:
#   prev_month_open  the previous month's FIRST session is up to two calendar
#                    months back (31 + 31), beyond the 40-day group floor.
#   yearly / prev_year anchors need a year or two. They cannot be met on 1m
#   (capped at 60 days) — _snapshot warns rather than drawing a wrong level.
_WARMUP_DAYS = {
    'levels.prev_month_open': 70,
    'levels.monthly_open': 45,
    'levels.monthly_high': 45,
    'levels.monthly_low': 45,
    'levels.yearly_open': 400,
    'levels.prev_year_open': 750,
}

# Primitives whose `length` counts SESSIONS, not bars. rel_volume's default
# length=20 means twenty prior RTH sessions (~28 calendar days); read as bars
# it asked for 3 days, so the rvol on screen was computed against a handful of
# days instead of twenty — the number the In-Play filter and the register
# cards are built on.
_SESSION_LENGTH_KEYS = {'volume.rel_volume'}

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
        # 0) measured requirement for the anchors the generic rules get wrong
        if ov.get('key') in _WARMUP_DAYS:
            need_days = max(need_days, _WARMUP_DAYS[ov['key']])
        # 1) explicit SESSION-count window (N-day VWAP, N-session lookbacks).
        #    These count trading days → ~1.7x calendar + a week of buffer.
        sess_names = ['n_days', 'sessions', 'days', 'lookback_days']
        if ov.get('key') in _SESSION_LENGTH_KEYS:
            sess_names.append('length')
        for pname in sess_names:
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
            if pname in params and not (pname == 'length'
                                        and ov.get('key') in _SESSION_LENGTH_KEYS):
                try:
                    need_days = max(need_days, _bars_to_days(int(params[pname]), btf))
                except (TypeError, ValueError):
                    pass
    # Even a single-bar primitive (candle.body, true_range) needs the bar
    # BEFORE the window starts, or its very first visible value is blank.
    if overlays and need_days <= 0:
        need_days = 1
    if need_days <= 0:
        return int(base_days)
    # WARM-UP IS EXTRA HISTORY, NOT A MINIMUM WINDOW. `need_days` is how much
    # history an indicator must chew through BEFORE its first value exists, so
    # it has to sit BEFORE the window the user asked to see — otherwise the
    # indicator is blank across the early part of that window. max() got this
    # wrong: a 20-day request with a 5-day MA (≈9 days of warm-up) fetched 20
    # days, and the MA only appeared a third of the way in.
    #     want: [ warm-up ][ the window you asked for ]
    #     was:  [ ........ the window you asked for ...]
    # The ceiling still bounds the total so a heavy combo cannot OOM the box;
    # the caller's own request is never reduced by it.
    total = int(base_days) + int(need_days)
    return max(int(base_days), min(total, _MAX_DAYS.get(tf, 400)))


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
