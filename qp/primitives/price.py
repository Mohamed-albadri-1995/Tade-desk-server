"""Price-structure primitives: highs, lows, ranges, changes."""

from typing import List

from qp.registry import register
from qp.primitives._utils import closes, highs, lows, require_bars


@register("highest_high", "Highest high over length bars", length=20)
def highest_high(bars: List[dict], length: int = 20) -> float:
    require_bars(bars, length, "highest_high")
    return max(highs(bars)[-length:])


@register("lowest_low", "Lowest low over length bars", length=20)
def lowest_low(bars: List[dict], length: int = 20) -> float:
    require_bars(bars, length, "lowest_low")
    return min(lows(bars)[-length:])


@register("last_close", "Close of the most recent bar")
def last_close(bars: List[dict]) -> float:
    require_bars(bars, 1, "last_close")
    return closes(bars)[-1]


@register("prev_close", "Close of the bar before the most recent")
def prev_close(bars: List[dict]) -> float:
    require_bars(bars, 2, "prev_close")
    return closes(bars)[-2]


@register("change_pct", "Percent change between the last two closes")
def change_pct(bars: List[dict]) -> float:
    require_bars(bars, 2, "change_pct")
    values = closes(bars)
    if values[-2] == 0:
        return 0.0
    return (values[-1] - values[-2]) / values[-2] * 100.0


@register("range_position", "Position of last close within the high/low range (0..1)", length=20)
def range_position(bars: List[dict], length: int = 20) -> float:
    require_bars(bars, length, "range_position")
    hi = max(highs(bars)[-length:])
    lo = min(lows(bars)[-length:])
    span = hi - lo
    if span == 0:
        return 0.5
    return (closes(bars)[-1] - lo) / span
