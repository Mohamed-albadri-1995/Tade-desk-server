"""
EMA-based Bollinger Bands with 25% top/bottom zones.

Matches the L3 script's ("Healthy Pullback L3 + BB Zone MA Touch")
`bb_ema / bb_upper / bb_lower / top_zone_bot / bot_zone_top` block:

    basis        = ta.ema(close, 21)
    std          = ta.stdev(close, 21)
    upper        = basis + 2 × std
    lower        = basis − 2 × std
    top_zone_bot = upper − (upper − lower) × zone_pct
    bot_zone_top = lower + (upper − lower) × zone_pct

Contrast with the SMA-basis Bollinger in `qp.volatility.bollinger`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from qp.ma import ema
from qp.volatility.stdev import stdev


@dataclass
class BollingerZones:
    basis:        np.ndarray  # EMA(length) on close
    upper:        np.ndarray
    lower:        np.ndarray
    top_zone_bot: np.ndarray  # upper − range × zone_pct/100
    bot_zone_top: np.ndarray  # lower + range × zone_pct/100


def bollinger_ema(source,
                  length: int = 21,
                  mult: float = 2.0,
                  zone_pct: float = 25.0) -> BollingerZones:
    """EMA-based Bollinger Bands + top/bottom "zone" boundaries."""
    x = np.asarray(source, dtype=float)
    basis = ema(x, length)
    std   = stdev(x, length)
    upper = basis + mult * std
    lower = basis - mult * std
    band_range = upper - lower
    top_zone_bot = upper - band_range * (zone_pct / 100.0)
    bot_zone_top = lower + band_range * (zone_pct / 100.0)
    return BollingerZones(
        basis=basis, upper=upper, lower=lower,
        top_zone_bot=top_zone_bot, bot_zone_top=bot_zone_top,
    )
