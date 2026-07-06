"""Trend primitives: moving averages and MACD."""

from typing import List

from qp.registry import register
from qp.primitives._utils import closes, ema_series, rolling_mean, require_bars


@register("sma", "Simple moving average of closes", length=9)
def sma(bars: List[dict], length: int = 9) -> float:
    require_bars(bars, length, "sma")
    return rolling_mean(closes(bars), length)


@register("ema", "Exponential moving average of closes", length=9)
def ema(bars: List[dict], length: int = 9) -> float:
    require_bars(bars, length, "ema")
    return ema_series(closes(bars), length)[-1]


@register("wma", "Weighted moving average of closes", length=9)
def wma(bars: List[dict], length: int = 9) -> float:
    require_bars(bars, length, "wma")
    window = closes(bars)[-length:]
    weights = list(range(1, length + 1))
    return sum(v * w for v, w in zip(window, weights)) / sum(weights)


@register("macd", "MACD line, signal line and histogram", fast=12, slow=26, signal=9)
def macd(bars: List[dict], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    require_bars(bars, slow + signal, "macd")
    values = closes(bars)
    fast_series = ema_series(values, fast)
    slow_series = ema_series(values, slow)
    # Align the two series on their tails.
    n = min(len(fast_series), len(slow_series))
    macd_line = [f - s for f, s in zip(fast_series[-n:], slow_series[-n:])]
    signal_series = ema_series(macd_line, signal)
    return {
        "macd": macd_line[-1],
        "signal": signal_series[-1],
        "histogram": macd_line[-1] - signal_series[-1],
    }


@register("slope", "Linear-regression slope of closes over the window", length=10)
def slope(bars: List[dict], length: int = 10) -> float:
    require_bars(bars, length, "slope")
    ys = closes(bars)[-length:]
    xs = list(range(length))
    mean_x = sum(xs) / length
    mean_y = sum(ys) / length
    denom = sum((x - mean_x) ** 2 for x in xs)
    return sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / denom
