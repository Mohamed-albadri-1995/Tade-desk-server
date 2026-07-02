"""Tests for qp.indicators — RSI, MACD, Stochastic, CCI."""

import numpy as np
import pandas as pd
import pytest

from qp.indicators import rsi, macd, stochastic, cci
from qp.ma import ema, rma, sma


def _bars(high, low, close, open_=None, volume=None):
    n = len(close)
    if open_ is None:
        open_ = close
    if volume is None:
        volume = np.ones(n)
    return pd.DataFrame({'open': open_, 'high': high, 'low': low,
                         'close': close, 'volume': volume})


class TestRSI:
    def test_matches_manual_wilder(self):
        # 15 samples, length=14 → one meaningful RSI at end.
        x = np.array([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
                      45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28],
                     dtype=float)
        r = rsi(x, length=14)
        # Manual Wilder reference (from J. Welles Wilder's original book).
        change = x[1:] - x[:-1]
        gains  = np.where(change > 0, change, 0.0)
        losses = np.where(change < 0, -change, 0.0)
        avg_gain = gains.mean()
        avg_loss = losses.mean()
        expected_rs = avg_gain / avg_loss
        expected_rsi = 100 - 100 / (1 + expected_rs)
        # This is the "seed" RSI at bar 14. Compare loosely because our
        # rma uses SMA seed which is the same convention here.
        np.testing.assert_allclose(r[14], expected_rsi, rtol=1e-6)

    def test_all_gains_returns_100(self):
        x = np.arange(1, 20, dtype=float)  # strictly increasing.
        r = rsi(x, length=5)
        # After the seed window, RSI should be 100 (no losses ever).
        assert np.all(r[np.isfinite(r)] == 100.0)

    def test_all_losses_returns_0(self):
        x = np.arange(20, 1, -1, dtype=float)
        r = rsi(x, length=5)
        # No gains → all losses → RSI = 0.
        finite = r[np.isfinite(r)]
        np.testing.assert_allclose(finite, 0.0)

    def test_flat_input_returns_50(self):
        x = np.full(20, 100.0)
        r = rsi(x, length=5)
        finite = r[np.isfinite(r)]
        np.testing.assert_allclose(finite, 50.0)

    def test_invalid_length(self):
        with pytest.raises(ValueError):
            rsi(np.arange(5), length=0)


class TestMACD:
    def test_matches_manual_composition(self):
        x = np.linspace(100.0, 200.0, 100)
        r = macd(x, fast=12, slow=26, signal=9)
        expected_macd = ema(x, 12) - ema(x, 26)
        expected_signal = ema(expected_macd, 9)
        np.testing.assert_allclose(r.macd, expected_macd, rtol=1e-12)
        np.testing.assert_allclose(r.signal, expected_signal, rtol=1e-12)
        np.testing.assert_allclose(r.hist, expected_macd - expected_signal,
                                   rtol=1e-12)

    def test_fast_ge_slow_raises(self):
        with pytest.raises(ValueError):
            macd(np.arange(30, dtype=float), fast=26, slow=12, signal=9)


class TestStochastic:
    def test_at_range_top_k_is_100(self):
        # Close at the top of the window's range.
        bars = _bars(
            high=[10, 11, 12, 13, 14],
            low=[5,  5,  5,  5,  5],
            close=[6, 7, 8, 9, 14],
        )
        r = stochastic(bars, length=3, smooth_k=1, smooth_d=1)
        # Last bar: ll=5, hh=14, close=14 → raw K = 100.
        assert r.k[-1] == 100.0

    def test_at_range_bottom_k_is_0(self):
        bars = _bars(
            high=[10, 11, 12, 13, 14],
            low=[5,  5,  5,  5,  5],
            close=[6, 7, 8, 9, 5],
        )
        r = stochastic(bars, length=3, smooth_k=1, smooth_d=1)
        assert r.k[-1] == 0.0

    def test_flat_window_returns_50(self):
        bars = _bars(
            high=[10, 10, 10, 10],
            low=[10, 10, 10, 10],
            close=[10, 10, 10, 10],
        )
        r = stochastic(bars, length=3, smooth_k=1, smooth_d=1)
        # Non-NaN entries should be 50 (neutral).
        finite = r.k[np.isfinite(r.k)]
        np.testing.assert_allclose(finite, 50.0)

    def test_d_is_sma_of_k(self):
        # Enough bars for length=3 stochastic + smooth_d=2.
        bars = _bars(
            high=np.arange(10.0, 20.0),
            low=np.arange(5.0, 15.0),
            close=np.arange(7.0, 17.0),
        )
        r = stochastic(bars, length=3, smooth_k=1, smooth_d=2)
        expected_d = sma(r.k, 2)
        np.testing.assert_allclose(r.d, expected_d, equal_nan=True)


class TestCCI:
    def test_zero_when_price_equals_ma(self):
        # Flat then a step — need window of 3.
        bars = _bars(
            high=[10, 10, 10, 20, 20, 20],
            low=[10, 10, 10, 20, 20, 20],
            close=[10, 10, 10, 20, 20, 20],
        )
        # After the flat, tp == ma → cci = 0 or NaN if MAD zero.
        r = cci(bars, length=3)
        # In the flat regions, MAD=0 so we set output to 0 (guarded).
        assert r[2] == 0.0 or np.isnan(r[2])

    def test_positive_when_price_above_ma(self):
        bars = _bars(
            high=np.arange(10.0, 30.0),
            low=np.arange(5.0, 25.0),
            close=np.arange(7.0, 27.0),
        )
        r = cci(bars, length=5)
        # In an uptrend, the LATEST TP is above the mean → CCI > 0.
        assert r[-1] > 0

    def test_negative_when_price_below_ma(self):
        bars = _bars(
            high=np.arange(30.0, 10.0, -1),
            low=np.arange(25.0, 5.0, -1),
            close=np.arange(27.0, 7.0, -1),
        )
        r = cci(bars, length=5)
        assert r[-1] < 0
