"""
Shared session helpers. Underscore-prefixed module — the primitives
auto-importer skips it, so nothing here registers as a primitive.

Session definitions (America/New_York):
  RTH        09:30 - 16:00
  Premarket  04:00 - 09:30

Daily-and-coarser frames get special treatment: each bar already IS the
session aggregate, so session predicates return True for every bar
instead of matching wall-clock hours (a daily bar stamped at midnight ET
would otherwise never pass an RTH check).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

ET = 'America/New_York'


def in_rth(ts) -> bool:
    return ((ts.hour > 9 or (ts.hour == 9 and ts.minute >= 30))
            and ts.hour < 16)


def in_premarket(ts) -> bool:
    return ts.hour >= 4 and (ts.hour < 9 or (ts.hour == 9 and ts.minute < 30))


def is_daily(df: pd.DataFrame) -> bool:
    """True when bars are daily or coarser (median spacing >= 12h)."""
    if len(df) < 3:
        return False
    deltas = pd.Series(df.index).diff().dt.total_seconds().dropna()
    return float(deltas.median()) >= 12 * 3600


def rth_pred(df: pd.DataFrame):
    """Per-timestamp RTH predicate appropriate for this frame."""
    if is_daily(df):
        return lambda ts: True
    return in_rth


def rth_positions(df: pd.DataFrame) -> np.ndarray:
    """Integer positions of RTH bars (all positions on daily+ frames)."""
    if is_daily(df):
        return np.arange(len(df))
    et = df.index.tz_convert(ET)
    mask = np.fromiter((in_rth(t) for t in et), dtype=bool, count=len(df))
    return np.nonzero(mask)[0]
