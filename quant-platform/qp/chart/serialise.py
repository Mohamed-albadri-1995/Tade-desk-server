"""
Serialise a `ChartFrame` to a JSON-safe dict that any front-end (this
repo's UI, a notebook, a static site) can consume.

Bar timestamps become ISO-8601 strings (millisecond precision) so a
JS chart library can `new Date(...)` directly. NaNs in series values
become `None` so JSON encoding preserves gaps.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

import numpy as np
import pandas as pd

from qp.chart.spec import ChartFrame


def to_dict(frame: ChartFrame) -> Dict[str, Any]:
    bars = frame.bars
    if not isinstance(bars.index, pd.DatetimeIndex):
        raise TypeError('ChartFrame.bars must have a DatetimeIndex')

    bar_records = []
    for i in range(len(bars)):
        bar_records.append({
            'ts':     bars.index[i].isoformat(),
            'open':   _num(bars['open'].iloc[i]),
            'high':   _num(bars['high'].iloc[i]),
            'low':    _num(bars['low'].iloc[i]),
            'close':  _num(bars['close'].iloc[i]),
            'volume': _num(bars['volume'].iloc[i]),
        })

    series = []
    for s in frame.series:
        if s.values.shape != (len(bars),):
            raise ValueError(f'series {s.name!r} length mismatch: '
                             f'{s.values.shape} vs {(len(bars),)}')
        series.append({
            'name':   s.name,
            'pane':   s.pane,
            'color':  s.color,
            'style':  s.style,
            'values': [_num(v) for v in s.values],
        })

    markers = []
    for m in frame.markers:
        markers.append({
            'label':      m.label,
            'bar_index':  int(m.bar_index),
            'price':      float(m.price),
            'kind':       m.kind,
            'color':      m.color,
        })

    return {
        'title':   frame.title,
        'bars':    bar_records,
        'series':  series,
        'markers': markers,
    }


def _num(v):
    """Convert to a JSON-safe scalar; NaN → None; numpy → python type."""
    if v is None:
        return None
    if isinstance(v, (float, np.floating)):
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    if isinstance(v, (int, np.integer)):
        return int(v)
    return v
