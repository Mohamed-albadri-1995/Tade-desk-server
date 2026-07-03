"""
TradingView Pine-parity 5-Day SMA.

Matches this Pine expression exactly:
    request.security(syminfo.tickerid, "1", ta.sma(close, 1950),
                     lookahead=barmerge.lookahead_off)

Algorithm: SMA over the last 1,950 one-minute closes (= 5 US-equity
RTH sessions × 390 min/session), value projected onto the current
chart's timeframe by looking up the most recent 1-minute bar whose
timestamp is at or before each display bar.

Because the underlying series is always 1-minute, the value at
Tuesday 10:00 is identical whether the chart shows 1m, 5m, 15m, or
1h — it's the same SMA(1950) on the same 1-minute stream. This is
NOT the same as `qp.ma.n_session_sma`, which uses the current TF's
own bars and produces a different number when the TF changes.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.ma.sma import sma


PINE_5DAY_MIN_BARS = 1950
PINE_5DAY_LENGTH = 1950


def pine_5day_sma(bars_1m: pd.DataFrame,
                  display_ts: np.ndarray) -> np.ndarray:
    """Compute `ta.sma(close_1m, 1950)` and project onto `display_ts`.

    `bars_1m` must be 1-minute OHLCV bars from the same session and
    symbol as the display bars. `display_ts` is a 1-D array of Unix
    seconds — one per display bar. Returns an array of the same length.

    For each display timestamp T, returns the SMA(1950) value at the
    largest 1-minute bar whose timestamp is <= T (Pine's
    `lookahead=barmerge.lookahead_off` semantic).
    """
    if len(bars_1m) < PINE_5DAY_MIN_BARS:
        raise ValueError(
            f'pine_5day_sma needs at least {PINE_5DAY_MIN_BARS} 1-minute bars '
            f'for warm-up; got {len(bars_1m)}. Fetch a wider window.'
        )
    closes_1m = bars_1m['close'].to_numpy(dtype=float)
    sma_1m = sma(closes_1m, PINE_5DAY_LENGTH)

    ts_1m = (bars_1m.index.view('int64') // 1_000_000_000).astype('int64')
    display_ts_i = np.asarray(display_ts, dtype='int64')

    # For each display T, index = last 1m timestamp with ts_1m <= T.
    # searchsorted right = insertion point s.t. everything before it is <= T.
    idxs = np.searchsorted(ts_1m, display_ts_i, side='right') - 1
    idxs = np.clip(idxs, 0, len(sma_1m) - 1)
    out = sma_1m[idxs]

    # If a display bar is BEFORE any 1m bar we have, the projection is
    # meaningless — mark NaN.
    invalid = display_ts_i < ts_1m[0]
    out = out.copy()
    out[invalid] = np.nan
    return out
