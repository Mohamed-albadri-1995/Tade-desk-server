"""
Live engine events — the messages the engine emits so callers
(execution router, notification system, journal) can react.

Frozen dataclasses so consumers can pattern-match on type without
worrying about mutation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional


Side = Literal['long', 'short']
CloseReason = Literal['stop', 'target', 'manual', 'eod']


@dataclass(frozen=True)
class OpenEvent:
    setup:     str
    symbol:    str
    side:      Side
    bar_index: int
    timestamp: str            # ISO-8601
    entry_px:  float
    stop_px:   float
    target_px: float
    qty:       float          # shares / contracts, from sizer


@dataclass(frozen=True)
class CloseEvent:
    setup:     str
    symbol:    str
    side:      Side
    entry_bar: int
    exit_bar:  int
    timestamp: str
    entry_px:  float
    exit_px:   float
    stop_px:   float
    target_px: float
    qty:       float
    reason:    CloseReason
    r_multiple: float
