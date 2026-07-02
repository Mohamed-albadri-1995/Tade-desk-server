"""
Sequence classifier — walks the confirmed pivot chain and labels each
new pivot as:

    HH  higher high         LH  lower high
    HL  higher low          LL  lower low

Take pivot_highs / pivot_lows outputs (bar-aligned, NaN elsewhere),
extract the non-NaN pivots in bar order, and compare each pivot to the
most recent SAME-side pivot. That's the whole classifier.

Returns a `pd.DataFrame` with columns:
    - bar_index (int)
    - price     (float)
    - kind      ('high' | 'low')
    - label     ('HH' | 'HL' | 'LH' | 'LL' | 'first_high' | 'first_low')

Order is bar-chronological, deduped (a bar can only host one pivot).
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd


def label_pivots(pivot_high_series, pivot_low_series) -> pd.DataFrame:
    ph = np.asarray(pivot_high_series, dtype=float)
    pl = np.asarray(pivot_low_series, dtype=float)
    if ph.shape != pl.shape:
        raise ValueError('pivot_high and pivot_low series must have the same length')

    rows = []
    for i in range(ph.size):
        if not np.isnan(ph[i]):
            rows.append((i, ph[i], 'high'))
        if not np.isnan(pl[i]):
            rows.append((i, pl[i], 'low'))
    rows.sort(key=lambda r: r[0])

    last_high: Optional[float] = None
    last_low:  Optional[float] = None
    labeled = []
    for idx, price, kind in rows:
        if kind == 'high':
            if last_high is None:
                lbl = 'first_high'
            else:
                lbl = 'HH' if price > last_high else 'LH'
            last_high = price
        else:
            if last_low is None:
                lbl = 'first_low'
            else:
                lbl = 'HL' if price > last_low else 'LL'
            last_low = price
        labeled.append((idx, price, kind, lbl))

    return pd.DataFrame(labeled,
                        columns=['bar_index', 'price', 'kind', 'label'])
