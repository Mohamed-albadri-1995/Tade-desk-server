"""Tests for qp.volatility — TR, ATR, stdev, Bollinger, Keltner."""

import numpy as np
import pandas as pd
import pytest

from qp.volatility import (
    true_range,
    atr,
    stdev,
    bollinger,
    keltner,
)
from qp.ma import rma, ema, sma


def _bars(high, low, close, open_=None, volume=None):
    n = len(close)
    df = pd.DataFrame({
        'open':  open_  if open_  is not None else close,
        'high':  high,
        'low':   low,
        'close': close,
        'volume': volume if volume is not None else np.ones(n),
    })
    return df


class TestTrueRange:
    def test_first_bar_degenerates_to_high_low(self):
        bars = _bars(high=[10, 12, 11], low=[8, 9, 10], close=[9, 11, 10])
        tr = true_range(bars)
        assert tr[0] == 2  # 10 - 8

    def test_subsequent_bars_use_max_of_three(self):
        # Bar 1: high=12, low=9, close_prev=9
        #   hl=3, hc=|12-9|=3, lc=|9-9|=0  → max = 3
        # Bar 2: high=11, low=10, close_prev=11
        #   hl=1, hc=|11-11|=0, lc=|10-11|=1  → max = 1
        bars = _bars(high=[10, 12, 11], low=[8, 9, 10], close=[9, 11, 10])
        tr = true_range(bars)
        np.testing.assert_allclose(tr, [2., 3., 1.])

    def test_gap_up_captures_gap(self):
        # Prev close = 10, next bar high=20, low=15 → hc = 10 wins.
        bars = _bars(high=[11, 20], low=[9, 15], close=[10, 18])
        tr = true_range(bars)
        assert tr[1] == 10  # |20 - 10|

    def test_missing_columns_raises(self):
        bars = pd.DataFrame({'high': [1], 'low': [1]})
        with pytest.raises(ValueError):
            true_range(bars)


class TestATR:
    def test_default_method_is_rma(self):
        bars = _bars(
            high=[10, 12, 11, 13, 14, 15, 16, 17],
            low=[9, 10, 10, 11, 12, 13, 14, 15],
            close=[9, 11, 10, 12, 13, 14, 15, 16],
        )
        tr = true_range(bars)
        np.testing.assert_allclose(atr(bars, 4), rma(tr, 4))

    def test_ema_method(self):
        bars = _bars(
            high=[10, 12, 11, 13, 14],
            low=[9, 10, 10, 11, 12],
            close=[9, 11, 10, 12, 13],
        )
        tr = true_range(bars)
        np.testing.assert_allclose(atr(bars, 3, method='ema'), ema(tr, 3))

    def test_sma_method(self):
        bars = _bars(
            high=[10, 12, 11, 13, 14],
            low=[9, 10, 10, 11, 12],
            close=[9, 11, 10, 12, 13],
        )
        tr = true_range(bars)
        np.testing.assert_allclose(atr(bars, 3, method='sma'), sma(tr, 3))

    def test_unknown_method_raises(self):
        bars = _bars(high=[1, 2], low=[1, 1], close=[1, 2])
        with pytest.raises(ValueError):
            atr(bars, 2, method='wilder')


class TestStdev:
    def test_matches_population_variance(self):
        x = np.array([1., 2., 3., 4., 5.])
        r = stdev(x, 3)
        # At i=2: values [1,2,3], mean=2, var = ((1-2)^2 + 0 + 1)/3 = 2/3
        np.testing.assert_allclose(r[2], np.sqrt(2/3))

    def test_ddof_1_matches_sample(self):
        x = np.array([1., 2., 3., 4., 5.])
        r = stdev(x, 3, ddof=1)
        # sample var = 2/2 = 1
        np.testing.assert_allclose(r[2], 1.0)


class TestBollinger:
    def test_basis_is_sma(self):
        x = np.array([10., 11., 12., 13., 14., 15.])
        bb = bollinger(x, length=3, mult=2.0)
        np.testing.assert_allclose(bb.basis, sma(x, 3))

    def test_upper_lower_are_mult_stdev(self):
        x = np.array([10., 11., 12., 13., 14., 15.])
        bb = bollinger(x, length=3, mult=2.0)
        expected_dev = 2.0 * stdev(x, 3)
        np.testing.assert_allclose(bb.upper - bb.basis, expected_dev,
                                   equal_nan=True)
        np.testing.assert_allclose(bb.basis - bb.lower, expected_dev,
                                   equal_nan=True)

    def test_leading_positions_are_nan(self):
        bb = bollinger(np.arange(10, dtype=float), length=5, mult=2.0)
        assert np.isnan(bb.basis[:4]).all()
        assert np.isnan(bb.upper[:4]).all()
        assert np.isnan(bb.lower[:4]).all()


class TestKeltner:
    def test_basis_is_ema_of_close(self):
        bars = _bars(
            high=[10, 11, 12, 13, 14, 15],
            low=[9, 10, 11, 12, 13, 14],
            close=[10, 11, 12, 13, 14, 15],
        )
        kc = keltner(bars, length=3, mult=2.0)
        np.testing.assert_allclose(kc.basis, ema(bars['close'].to_numpy(float), 3))

    def test_width_is_mult_atr(self):
        bars = _bars(
            high=[10, 12, 11, 13, 14, 15],
            low=[9, 10, 10, 11, 12, 13],
            close=[9, 11, 10, 12, 13, 14],
        )
        kc = keltner(bars, length=3, mult=2.0)
        expected_band = 2.0 * atr(bars, 3)
        np.testing.assert_allclose(kc.upper - kc.basis, expected_band,
                                   equal_nan=True)
        np.testing.assert_allclose(kc.basis - kc.lower, expected_band,
                                   equal_nan=True)

    def test_custom_source(self):
        bars = _bars(
            high=[10, 11, 12, 13, 14, 15],
            low=[9, 10, 11, 12, 13, 14],
            close=[10, 11, 12, 13, 14, 15],
        )
        source = np.array([100., 200., 300., 400., 500., 600.])
        kc = keltner(bars, length=3, mult=1.0, source=source)
        np.testing.assert_allclose(kc.basis, ema(source, 3))

    def test_custom_atr_length(self):
        bars = _bars(
            high=[10, 12, 11, 13, 14, 15, 16],
            low=[9, 10, 10, 11, 12, 13, 14],
            close=[9, 11, 10, 12, 13, 14, 15],
        )
        kc = keltner(bars, length=5, mult=1.0, atr_length=2)
        expected = 1.0 * atr(bars, 2)
        np.testing.assert_allclose(kc.upper - kc.basis, expected,
                                   equal_nan=True)
