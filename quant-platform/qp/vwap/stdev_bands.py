"""
VWAP standard-deviation bands — the ±σ channel around a session VWAP.

Pine parity for Script 3's BBZ VWAP bands (`bz_vwap_stdev`):

    sh_pv  = Σ (price × volume)     — same as VWAP numerator
    sh_pv2 = Σ (price² × volume)    — for the variance term
    sh_vol = Σ volume
    vwap   = sh_pv / sh_vol
    var    = sh_pv2 / sh_vol − vwap²
    stdev  = sqrt(max(var, 0))
    upper  = vwap + k × stdev
    lower  = vwap − k × stdev

Reset boundary matches `session_vwap` (RTH-open aligned).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from qp.price import hlc3
from qp.session import SessionSpec, US_EQUITIES
from qp.vwap.sessional import _new_session_mask


@dataclass
class VwapBands:
    basis: np.ndarray
    upper: np.ndarray
    lower: np.ndarray
    stdev: np.ndarray  # raw σ per bar — lets callers build arbitrary bands


def vwap_stdev_bands(bars: pd.DataFrame,
                     mult: float = 1.0,
                     spec: SessionSpec = US_EQUITIES) -> VwapBands:
    """Session-anchored VWAP with ± mult × stdev bands. `stdev` field is
    also returned so callers can build asymmetric bands with different
    multipliers for upper vs. lower."""
    p = np.asarray(hlc3(bars), dtype=float)
    v = bars['volume'].to_numpy(dtype=float)
    reset = _new_session_mask(bars, spec)

    n = len(bars)
    basis = np.full(n, np.nan, dtype=float)
    upper = np.full(n, np.nan, dtype=float)
    lower = np.full(n, np.nan, dtype=float)
    std_out = np.full(n, np.nan, dtype=float)

    cum_pv  = 0.0
    cum_pv2 = 0.0
    cum_v   = 0.0
    started = False

    for i in range(n):
        if reset[i]:
            cum_pv = cum_pv2 = cum_v = 0.0
            started = True
        if started and np.isfinite(p[i]) and np.isfinite(v[i]):
            cum_pv  += p[i] * v[i]
            cum_pv2 += p[i] * p[i] * v[i]
            cum_v   += v[i]
        if started and cum_v > 0:
            vwap_i = cum_pv / cum_v
            var_i  = cum_pv2 / cum_v - vwap_i * vwap_i
            std_i  = np.sqrt(max(var_i, 0.0))
            basis[i]   = vwap_i
            upper[i]   = vwap_i + mult * std_i
            lower[i]   = vwap_i - mult * std_i
            std_out[i] = std_i
    return VwapBands(basis=basis, upper=upper, lower=lower, stdev=std_out)
