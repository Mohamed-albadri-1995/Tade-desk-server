"""
Validation export — writes bar-aligned CSV of any indicator series so
you can paste them next to TradingView's output for parity checks.

    export_series(bars, {'ema_20': ema20, 'rsi_14': rsi14}, path='out.csv')

Produces a CSV with the timestamp + close (as an anchor) + every named
series column. NaNs are written as empty cells so TradingView's CSV
importer sees them as "no data" the same way as its native output.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Union

import numpy as np
import pandas as pd


def export_series(bars: pd.DataFrame,
                  series: Dict[str, np.ndarray],
                  path: Union[str, Path]) -> Path:
    """Export a bar-aligned CSV of `series` for TradingView comparison."""
    if not isinstance(bars.index, pd.DatetimeIndex):
        raise TypeError('bars must have a DatetimeIndex')
    n = len(bars)
    for name, arr in series.items():
        if np.asarray(arr).shape != (n,):
            raise ValueError(f'series {name!r} length mismatch: '
                             f'{np.asarray(arr).shape} vs ({n},)')
    out = pd.DataFrame(index=bars.index)
    out['close'] = bars['close'].to_numpy(dtype=float)
    for name, arr in series.items():
        out[name] = np.asarray(arr, dtype=float)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(p, index_label='timestamp', float_format='%.10g')
    return p
