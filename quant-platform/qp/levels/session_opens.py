"""
Session opens as projected series — Script 2's DO / WO / MO / YO
(and previous-period opens PDO / PWO / PMO / PYO).

For each session boundary, the "session open" is the first bar's open
of that session (regular-session, matches TradingView's daily bar).
The value is projected forward across every bar of that session.

Previous-period opens are the same series shifted by one period —
e.g. PWO for bars in week N is the WO of week N-1.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES, session_for_bars


def _local_key(bars: pd.DataFrame, spec: SessionSpec, freq: str):
    if bars.index.tz is None:
        raise ValueError('bars.index must be tz-aware')
    local = bars.index.tz_convert(spec.tz)
    if freq == 'D':
        return pd.Index(local.date)
    if freq == 'W':
        # ISO week key
        return pd.Index([(t.isocalendar().year, t.isocalendar().week) for t in local])
    if freq == 'M':
        return pd.Index([(t.year, t.month) for t in local])
    if freq == 'Y':
        return pd.Index([t.year for t in local])
    raise ValueError(f'unknown freq {freq!r}')


def _open_series(bars: pd.DataFrame,
                 freq: str,
                 spec: SessionSpec,
                 shift_periods: int = 0) -> np.ndarray:
    labels = session_for_bars(bars, spec).to_numpy()
    reg = bars[labels == 'regular']
    if len(reg) == 0:
        return np.full(len(bars), np.nan, dtype=float)

    reg_keys = _local_key(reg, spec, freq)
    reg_open = reg['open'].to_numpy(dtype=float)
    first_open = {}
    for k, o in zip(reg_keys, reg_open):
        if k not in first_open:
            first_open[k] = o

    keys_in_order = list(first_open.keys())
    if shift_periods:
        # Map each key to the key `shift_periods` slots earlier in
        # the observed order (skipping missing sessions).
        pos = {k: i for i, k in enumerate(keys_in_order)}
        remap = {}
        for k in keys_in_order:
            j = pos[k] - shift_periods
            if j >= 0:
                remap[k] = first_open[keys_in_order[j]]
        lookup = remap
    else:
        lookup = first_open

    all_keys = _local_key(bars, spec, freq)
    out = np.full(len(bars), np.nan, dtype=float)
    for i, k in enumerate(all_keys):
        v = lookup.get(k)
        if v is not None and np.isfinite(v):
            out[i] = v
    return out


def daily_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'D', spec, 0)

def weekly_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'W', spec, 0)

def monthly_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'M', spec, 0)

def yearly_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'Y', spec, 0)

def prev_daily_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'D', spec, 1)

def prev_weekly_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'W', spec, 1)

def prev_monthly_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'M', spec, 1)

def prev_yearly_open(bars, spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    return _open_series(bars, 'Y', spec, 1)
