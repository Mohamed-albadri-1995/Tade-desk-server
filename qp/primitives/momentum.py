"""Momentum primitives: RSI, ROC, stochastic."""

from typing import List

from qp.registry import register
from qp.primitives._utils import closes, highs, lows, require_bars


@register("rsi", "Relative Strength Index (Wilder smoothing)", length=14)
def rsi(bars: List[dict], length: int = 14) -> float:
    require_bars(bars, length + 1, "rsi")
    values = closes(bars)
    gains, losses = [], []
    for prev, cur in zip(values, values[1:]):
        change = cur - prev
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains[:length]) / length
    avg_loss = sum(losses[:length]) / length
    for g, l in zip(gains[length:], losses[length:]):
        avg_gain = (avg_gain * (length - 1) + g) / length
        avg_loss = (avg_loss * (length - 1) + l) / length
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


@register("roc", "Rate of change (percent) over length bars", length=10)
def roc(bars: List[dict], length: int = 10) -> float:
    require_bars(bars, length + 1, "roc")
    values = closes(bars)
    past = values[-(length + 1)]
    if past == 0:
        return 0.0
    return (values[-1] - past) / past * 100.0


@register("momentum", "Close difference over length bars", length=10)
def momentum(bars: List[dict], length: int = 10) -> float:
    require_bars(bars, length + 1, "momentum")
    values = closes(bars)
    return values[-1] - values[-(length + 1)]


@register("stochastic", "Stochastic oscillator %K and %D", k_length=14, d_length=3)
def stochastic(bars: List[dict], k_length: int = 14, d_length: int = 3) -> dict:
    require_bars(bars, k_length + d_length - 1, "stochastic")
    values = closes(bars)
    hs = highs(bars)
    ls = lows(bars)
    k_values: List[float] = []
    for i in range(len(bars) - d_length + 1, len(bars) + 1):
        window_high = max(hs[i - k_length:i])
        window_low = min(ls[i - k_length:i])
        span = window_high - window_low
        k_values.append(0.0 if span == 0 else (values[i - 1] - window_low) / span * 100.0)
    return {"k": k_values[-1], "d": sum(k_values) / len(k_values)}
