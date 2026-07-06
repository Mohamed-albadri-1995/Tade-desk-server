"""Volume primitives: VWAP, OBV, average/relative volume."""

from typing import List

from qp.registry import register
from qp.primitives._utils import closes, require_bars, volumes


@register("vwap", "Volume-weighted average price over the given bars", length=0)
def vwap(bars: List[dict], length: int = 0) -> float:
    """VWAP over the last ``length`` bars (0 = all provided bars)."""
    require_bars(bars, 1, "vwap")
    window = bars[-length:] if length else bars
    total_pv = 0.0
    total_v = 0.0
    for b in window:
        typical = (float(b["high"]) + float(b["low"]) + float(b["close"])) / 3.0
        vol = float(b.get("volume", 0.0))
        total_pv += typical * vol
        total_v += vol
    if total_v == 0:
        return float(window[-1]["close"])
    return total_pv / total_v


@register("obv", "On-balance volume over the provided bars")
def obv(bars: List[dict]) -> float:
    require_bars(bars, 2, "obv")
    values = closes(bars)
    vols = volumes(bars)
    total = 0.0
    for i in range(1, len(values)):
        if values[i] > values[i - 1]:
            total += vols[i]
        elif values[i] < values[i - 1]:
            total -= vols[i]
    return total


@register("avg_volume", "Simple average volume", length=20)
def avg_volume(bars: List[dict], length: int = 20) -> float:
    require_bars(bars, length, "avg_volume")
    window = volumes(bars)[-length:]
    return sum(window) / length


@register("rel_volume", "Last bar volume relative to average volume", length=20)
def rel_volume(bars: List[dict], length: int = 20) -> float:
    require_bars(bars, length + 1, "rel_volume")
    avg = sum(volumes(bars)[-(length + 1):-1]) / length
    if avg == 0:
        return 0.0
    return volumes(bars)[-1] / avg
