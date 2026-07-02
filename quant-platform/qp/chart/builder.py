"""
ChartFrame builder — a small fluent-style helper so callers can
construct a chart in a few lines instead of assembling dataclasses
manually.

    frame = (ChartBuilder(bars, title='SPY 5m')
             .add_series('EMA(20)', ema20, pane='price', color='blue')
             .add_series('RSI(14)', rsi_vals, pane='oscillator')
             .add_marker('long entry', bar_index=42, price=442.10, kind='buy')
             .build())
"""

from __future__ import annotations

from typing import List, Optional

import numpy as np
import pandas as pd

from qp.chart.spec import ChartFrame, Series, Marker, PaneRole


class ChartBuilder:
    def __init__(self, bars: pd.DataFrame, title: str = ''):
        self._bars = bars
        self._title = title
        self._series: List[Series] = []
        self._markers: List[Marker] = []

    def add_series(self, name: str, values,
                   pane: PaneRole = 'price',
                   color: Optional[str] = None,
                   style: str = 'line') -> 'ChartBuilder':
        arr = np.asarray(values, dtype=float)
        if arr.shape != (len(self._bars),):
            raise ValueError(f'series {name!r} length mismatch: '
                             f'{arr.shape} vs {(len(self._bars),)}')
        self._series.append(Series(name=name, values=arr, pane=pane,
                                   color=color, style=style))
        return self

    def add_marker(self, label: str, bar_index: int, price: float,
                   kind: str = 'note',
                   color: Optional[str] = None) -> 'ChartBuilder':
        if not 0 <= bar_index < len(self._bars):
            raise ValueError(f'bar_index {bar_index} out of range')
        self._markers.append(Marker(label=label, bar_index=bar_index,
                                    price=float(price), kind=kind, color=color))
        return self

    def build(self) -> ChartFrame:
        return ChartFrame(bars=self._bars, series=list(self._series),
                          markers=list(self._markers), title=self._title)
