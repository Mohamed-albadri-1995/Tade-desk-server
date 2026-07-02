"""
Trend state classifier — walks the pivot label sequence and outputs a
per-bar trend state:

    'up'       most recent structure is HH after HL
    'down'     most recent structure is LL after LH
    'range'    mixed / neither uptrend nor downtrend confirmed
    'unknown'  not enough pivots yet

The classifier updates state whenever a new pivot is confirmed (i.e.
`right` bars after the actual peak, matching `qp.structure.pivots`).
For every bar between two pivots, we forward-fill the state of the
most recently confirmed pivot chain.

State transitions:
    - Seeing an HH followed by an HL (or HL followed by HH) → 'up'
    - Seeing an LL followed by an LH (or LH followed by LL) → 'down'
    - Any other pair → 'range'
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd


def trend_state(pivot_labels: pd.DataFrame, n_bars: int) -> np.ndarray:
    """Given the labelled pivot DataFrame from `label_pivots` and the
    total bar count, return an array of length `n_bars` with the
    forward-filled trend state for each bar.
    """
    out = np.full(n_bars, 'unknown', dtype=object)
    if len(pivot_labels) == 0:
        return out

    current = 'unknown'
    last_label: Optional[str] = None
    cursor_bar = 0
    for _, row in pivot_labels.iterrows():
        bar = int(row['bar_index'])
        label = row['label']
        # Fill everything from cursor_bar up to (but not including) this
        # pivot's confirmation bar with the previous state.
        out[cursor_bar:bar + 1] = current
        cursor_bar = bar + 1

        if label in ('first_high', 'first_low'):
            last_label = label
            continue

        new_state = _classify_pair(last_label, label)
        current = new_state
        last_label = label

    out[cursor_bar:] = current
    return out


def _classify_pair(prev: Optional[str], curr: str) -> str:
    if prev is None or prev.startswith('first'):
        return 'range'
    pair = frozenset([prev, curr])
    if pair == frozenset(['HH', 'HL']):
        return 'up'
    if pair == frozenset(['LL', 'LH']):
        return 'down'
    # An HH followed by an LH (or an HL followed by an LL) marks the
    # first structure break — still 'range' until the opposite side
    # confirms.
    return 'range'
