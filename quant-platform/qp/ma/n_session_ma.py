"""
Rolling N-session moving average.

At every bar, the average is taken over the last N sessions of bars.
Because the underlying bar count depends on timeframe (78 bars per
regular US-equity session on 5m, 390 on 1m, 1 on daily), the effective
smoothing window automatically adapts to the chart's resolution — no
need for the caller to pre-compute a length.

Session boundaries come from `qp.vwap.sessional._new_session_mask`, so
partial sessions and holidays are handled correctly.

Currently only the arithmetic (SMA) flavour is defined; recursive MAs
(EMA/RMA/WMA/HMA) need a different treatment because their smoothing
factor is derived from the fixed bar length. Add those in follow-ups
if the trade desk needs them.
"""

from __future__ import annotations

from typing import Union

import numpy as np
import pandas as pd

from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.rolling import _session_bounds


def n_session_sma(bars: pd.DataFrame,
                  n_sessions: int,
                  source: Union[str, np.ndarray] = 'close',
                  spec: SessionSpec = US_EQUITIES) -> np.ndarray:
    """Rolling SMA over the last `n_sessions` sessions of bars.

    On a 5-minute chart with n_sessions=5, that's ~390 bars per window.
    On a 1-minute chart, ~1950. On daily, exactly 5. The caller doesn't
    have to know the bar count.
    """
    if not isinstance(n_sessions, int) or n_sessions < 1:
        raise ValueError(f'n_sessions must be a positive integer, got {n_sessions!r}')
    n = len(bars)
    if n == 0:
        return np.array([], dtype=float)

    if isinstance(source, str):
        values = bars[source].to_numpy(dtype=float)
    else:
        values = np.asarray(source, dtype=float)
    if values.shape != (n,):
        raise ValueError('source length must match bars length')

    session_idx, session_starts = _session_bounds(bars, spec)

    # Prefix sum for O(1) window mean.
    vals_finite = np.where(np.isfinite(values), values, 0.0)
    cum = np.concatenate([[0.0], np.cumsum(vals_finite)])

    out = np.full(n, np.nan, dtype=float)
    for i in range(n):
        target = max(0, int(session_idx[i]) - n_sessions + 1)
        start = session_starts[target]
        count = i + 1 - start
        if count > 0:
            out[i] = (cum[i + 1] - cum[start]) / count
    return out
