"""
Chart data specification — pure data model, framework-agnostic.

A `ChartFrame` bundles:
    - the OHLCV bars (with tz-aware index).
    - one or more `Series` overlays (indicators, VWAPs, MAs, levels).
    - zero or more `Marker` sets (trade entries, signal fires, pivots).

Consumers (frontend charts, matplotlib, TradingView export, tests)
receive the same object and render it their own way. Nothing here
depends on a plotting library.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

import numpy as np
import pandas as pd


PaneRole = Literal['price', 'oscillator', 'volume', 'custom']


@dataclass(frozen=True)
class Series:
    """A single overlay line — timestamps + values + a display hint."""
    name: str
    values: np.ndarray             # length == len(bars)
    pane: PaneRole = 'price'       # which pane to draw on
    color: Optional[str] = None    # optional hint; front-end may override
    style: str = 'line'            # 'line' | 'dashed' | 'dotted' | 'histogram'


@dataclass(frozen=True)
class Marker:
    """A point-marker on a specific bar. Trade entries, signal fires,
    pivot points all become markers."""
    label: str
    bar_index: int
    price: float
    kind: Literal['buy', 'sell', 'stop', 'target', 'pivot_high',
                  'pivot_low', 'note'] = 'note'
    color: Optional[str] = None


@dataclass(frozen=True)
class ChartFrame:
    bars: pd.DataFrame
    series: List[Series] = field(default_factory=list)
    markers: List[Marker] = field(default_factory=list)
    title: str = ''
