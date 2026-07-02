"""
Prior-week / prior-month extremes on intraday bars.

Same pattern as `session_daily`: bucket by (ISO year, week) or (year,
month), take the max/min per bucket, then project the most recent
prior bucket's value onto each bar.

Weekly bucket is ISO — Monday-first, matching TradingView's `time('W')`.
Monthly bucket is calendar month in the session's local timezone.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES


def _local(bars: pd.DataFrame, spec: SessionSpec) -> pd.DatetimeIndex:
    if bars.index.tz is None:
        raise ValueError('bars.index must be tz-aware')
    return bars.index.tz_convert(spec.tz)


def _iso_week_keys(local: pd.DatetimeIndex):
    iso = local.isocalendar()
    return list(zip(iso.year.tolist(), iso.week.tolist()))


def _month_keys(local: pd.DatetimeIndex):
    return list(zip(local.year.tolist(), local.month.tolist()))


def _project_prior(bars, key_func, side: str, spec: SessionSpec) -> np.ndarray:
    local = _local(bars, spec)
    keys = key_func(local)
    values = bars['high' if side == 'high' else 'low'].to_numpy(dtype=float)

    # Aggregate per-key extreme.
    per_key: dict = {}
    for k, v in zip(keys, values):
        if k not in per_key:
            per_key[k] = v
        elif side == 'high':
            if v > per_key[k]:
                per_key[k] = v
        else:
            if v < per_key[k]:
                per_key[k] = v

    ordered_keys = sorted(per_key.keys())
    out = np.full(len(bars), np.nan, dtype=float)
    cursor = 0
    for i, k in enumerate(keys):
        while cursor < len(ordered_keys) and ordered_keys[cursor] < k:
            cursor += 1
        idx = cursor - 1
        if idx >= 0:
            out[i] = per_key[ordered_keys[idx]]
    return out


def prev_week_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _project_prior(bars, _iso_week_keys, 'high', spec)


def prev_week_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _project_prior(bars, _iso_week_keys, 'low', spec)


def prev_month_high(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _project_prior(bars, _month_keys, 'high', spec)


def prev_month_low(bars: pd.DataFrame, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _project_prior(bars, _month_keys, 'low', spec)
