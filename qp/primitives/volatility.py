"""Volatility primitives: ATR, standard deviation, Bollinger Bands."""

import math
from typing import List

from qp.registry import register
from qp.primitives._utils import closes, require_bars, rolling_mean, true_ranges


@register("atr", "Average True Range (Wilder smoothing)", length=14)
def atr(bars: List[dict], length: int = 14) -> float:
    require_bars(bars, length + 1, "atr")
    trs = true_ranges(bars)[1:]  # first TR lacks a previous close
    value = sum(trs[:length]) / length
    for tr in trs[length:]:
        value = (value * (length - 1) + tr) / length
    return value


@register("true_range", "True range of the most recent bar")
def true_range(bars: List[dict]) -> float:
    require_bars(bars, 1, "true_range")
    return true_ranges(bars)[-1]


@register("stddev", "Population standard deviation of closes", length=20)
def stddev(bars: List[dict], length: int = 20) -> float:
    require_bars(bars, length, "stddev")
    window = closes(bars)[-length:]
    mean = sum(window) / length
    return math.sqrt(sum((v - mean) ** 2 for v in window) / length)


@register("bollinger", "Bollinger Bands (middle, upper, lower, percent_b)", length=20, mult=2.0)
def bollinger(bars: List[dict], length: int = 20, mult: float = 2.0) -> dict:
    require_bars(bars, length, "bollinger")
    middle = rolling_mean(closes(bars), length)
    dev = stddev(bars, length=length) * mult
    upper = middle + dev
    lower = middle - dev
    last = closes(bars)[-1]
    span = upper - lower
    percent_b = 0.5 if span == 0 else (last - lower) / span
    return {"middle": middle, "upper": upper, "lower": lower, "percent_b": percent_b}
