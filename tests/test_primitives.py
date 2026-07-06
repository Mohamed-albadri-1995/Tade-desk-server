import math

import qp


def test_registry_populated():
    assert len(qp.REGISTRY) >= 15
    for key in ("sma", "ema", "rsi", "atr", "vwap", "bollinger", "macd"):
        assert key in qp.REGISTRY
        assert callable(qp.REGISTRY[key].fn)


def test_sma(bars):
    expected = sum(b["close"] for b in bars[-9:]) / 9
    assert math.isclose(qp.REGISTRY["sma"].fn(bars, length=9), expected)


def test_rsi_uptrend_is_high(bars):
    assert qp.REGISTRY["rsi"].fn(bars, length=14) > 90  # monotonic uptrend


def test_atr_positive(bars):
    assert qp.REGISTRY["atr"].fn(bars, length=14) > 0


def test_vwap_within_range(bars):
    v = qp.REGISTRY["vwap"].fn(bars)
    lows = min(b["low"] for b in bars)
    highs = max(b["high"] for b in bars)
    assert lows <= v <= highs


def test_bollinger_ordering(bars):
    bb = qp.REGISTRY["bollinger"].fn(bars, length=20, mult=2.0)
    assert bb["lower"] < bb["middle"] < bb["upper"]
    assert 0.0 <= bb["percent_b"] <= 1.5


def test_insufficient_bars_raises(bars):
    import pytest

    with pytest.raises(ValueError):
        qp.REGISTRY["sma"].fn(bars[:3], length=9)
