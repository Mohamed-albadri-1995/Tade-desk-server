"""Shared helpers for primitives (internal, not registered)."""

from typing import List


def closes(bars: List[dict]) -> List[float]:
    return [float(b["close"]) for b in bars]


def highs(bars: List[dict]) -> List[float]:
    return [float(b["high"]) for b in bars]


def lows(bars: List[dict]) -> List[float]:
    return [float(b["low"]) for b in bars]


def volumes(bars: List[dict]) -> List[float]:
    return [float(b.get("volume", 0.0)) for b in bars]


def require_bars(bars: List[dict], n: int, name: str) -> None:
    if len(bars) < n:
        raise ValueError(f"{name} requires at least {n} bars, got {len(bars)}")


def rolling_mean(values: List[float], length: int) -> float:
    if len(values) < length:
        raise ValueError(f"need {length} values, got {len(values)}")
    window = values[-length:]
    return sum(window) / length


def ema_series(values: List[float], length: int) -> List[float]:
    if len(values) < length:
        raise ValueError(f"need {length} values, got {len(values)}")
    k = 2.0 / (length + 1.0)
    seed = sum(values[:length]) / length
    out = [seed]
    for v in values[length:]:
        out.append(v * k + out[-1] * (1.0 - k))
    return out


def true_ranges(bars: List[dict]) -> List[float]:
    trs: List[float] = []
    prev_close = None
    for b in bars:
        h, l, c = float(b["high"]), float(b["low"]), float(b["close"])
        if prev_close is None:
            trs.append(h - l)
        else:
            trs.append(max(h - l, abs(h - prev_close), abs(l - prev_close)))
        prev_close = c
    return trs
