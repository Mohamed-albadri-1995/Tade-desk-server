"""
Setup specification — the data-only container that names a trade
setup and describes its trigger + risk envelope.

A `Setup` is:
    - a `name` (human-readable id).
    - a `side` — 'long' | 'short'.
    - a `trigger` — callable(bars) → bool ndarray. Fires True on the
      bar the setup would enter on. Can be any composition of qp
      primitives / indicators.
    - a `stop` — StopRule describing how far below (long) or above
      (short) the entry to place the initial stop. ATR-multiples or
      fixed percent supported.
    - a `target` — TargetRule describing take-profit distance.

`Setup` is a plain dataclass. Evaluation happens in
`qp.setups.evaluator` so a Setup instance stays serialisable and
inspectable without pulling in numpy at spec-time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal

import numpy as np
import pandas as pd


Side = Literal['long', 'short']
StopKind = Literal['atr', 'percent', 'level']
TargetKind = Literal['atr', 'percent', 'r_multiple', 'level']


@dataclass(frozen=True)
class StopRule:
    """How to place the initial stop.

    - kind='atr': distance = mult × ATR(atr_length) below/above entry.
    - kind='percent': distance = pct × entry_price.
    - kind='level': distance from entry to a specific level array
      (caller supplies the level via the `level` name in the setup
      context).
    """
    kind: StopKind
    mult: float = 1.0        # for 'atr'
    atr_length: int = 14     # for 'atr'
    pct: float = 0.01        # for 'percent'
    level_name: str = ''     # for 'level' — a key in the setup context


@dataclass(frozen=True)
class TargetRule:
    """How to place the take-profit.

    - kind='atr': distance = mult × ATR(atr_length) in the trade direction.
    - kind='percent': distance = pct × entry_price.
    - kind='r_multiple': distance = r × (entry - stop).
    - kind='level': distance to a named level.
    """
    kind: TargetKind
    mult: float = 2.0
    atr_length: int = 14
    pct: float = 0.02
    r: float = 2.0
    level_name: str = ''


@dataclass(frozen=True)
class Setup:
    name: str
    side: Side
    trigger: Callable[[pd.DataFrame], np.ndarray]
    stop: StopRule
    target: TargetRule
    description: str = ''
