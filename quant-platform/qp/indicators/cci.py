"""
CCI — Commodity Channel Index.

TradingView `ta.cci(source, length)`:

    tp   = source                              (usually HLC3)
    ma   = sma(tp, length)
    dev  = mean(abs(tp - ma) over last length) = mean-absolute-deviation
    cci  = (tp - ma) / (0.015 * dev)

`source` defaults to HLC3. Uses rolling arithmetic — no re-implementation
of a MAD calculator here; we use pandas' rolling apply for the mean
absolute deviation.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from qp.ma import sma
from qp.price import hlc3


def cci(bars: pd.DataFrame, length: int = 20,
        source: Optional[np.ndarray] = None) -> np.ndarray:
    if length < 1:
        raise ValueError(f'length must be >= 1, got {length!r}')
    tp = np.asarray(source if source is not None else hlc3(bars), dtype=float)
    ma = sma(tp, length)
    # Mean absolute deviation from the rolling mean.
    dev = (pd.Series(tp)
           .rolling(window=length, min_periods=length)
           .apply(lambda w: np.mean(np.abs(w - w.mean())), raw=True)
           .to_numpy())
    with np.errstate(divide='ignore', invalid='ignore'):
        out = np.where(dev > 0, (tp - ma) / (0.015 * dev), 0.0)
    out[np.isnan(ma) | np.isnan(dev)] = np.nan
    return out
