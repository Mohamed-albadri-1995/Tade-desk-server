"""Tests for qp.ma — every MA compared against a manual reference."""

import math

import numpy as np
import pytest

from qp.ma import sma, ema, rma, wma, vwma, hma


class TestSMA:
    def test_matches_manual_mean(self):
        x = np.arange(20, dtype=float)
        r = sma(x, 5)
        assert np.isnan(r[:4]).all()
        np.testing.assert_allclose(r[4], np.mean([0., 1., 2., 3., 4.]))
        np.testing.assert_allclose(r[-1], np.mean([15., 16., 17., 18., 19.]))


class TestEMA:
    def test_seeded_with_first_sample(self):
        x = np.array([10., 20., 30., 40., 50.])
        r = ema(x, length=3)
        np.testing.assert_allclose(r[0], 10.0)

    def test_matches_manual_recursion(self):
        length = 5
        k = 2.0 / (length + 1)
        x = np.array([100., 102., 101., 103., 105., 107., 109.])
        expected = np.zeros_like(x)
        expected[0] = x[0]
        for i in range(1, len(x)):
            expected[i] = k * x[i] + (1 - k) * expected[i - 1]
        np.testing.assert_allclose(ema(x, length), expected, rtol=1e-12)

    def test_constant_input_converges_to_constant(self):
        r = ema(np.array([5., 5., 5., 5., 5.]), 3)
        np.testing.assert_allclose(r, [5., 5., 5., 5., 5.])

    def test_invalid_length(self):
        with pytest.raises(ValueError):
            ema([1., 2., 3.], 0)


class TestRMA:
    def test_seeded_with_sma_of_first_length(self):
        x = np.array([1., 2., 3., 4., 5., 6., 7.])
        r = rma(x, 3)
        assert np.isnan(r[:2]).all()
        # Seed at index 2 = mean([1,2,3]) = 2.
        np.testing.assert_allclose(r[2], 2.0)

    def test_matches_manual_recursion(self):
        length = 4
        x = np.array([1., 2., 3., 4., 5., 6., 7., 8.])
        alpha = 1.0 / length
        expected = np.full_like(x, np.nan)
        expected[length - 1] = x[:length].mean()
        for i in range(length, len(x)):
            expected[i] = alpha * x[i] + (1 - alpha) * expected[i - 1]
        np.testing.assert_allclose(rma(x, length), expected, rtol=1e-12)

    def test_slower_than_ema_of_same_length(self):
        length = 5
        x = np.concatenate([np.ones(20) * 100., np.ones(20) * 200.])
        e = ema(x, length)
        r = rma(x, length)
        # 3 bars after the jump, EMA is closer to 200 than RMA.
        idx = 22
        assert (200 - e[idx]) < (200 - r[idx])


class TestWMA:
    def test_matches_manual(self):
        x = np.array([1., 2., 3., 4., 5.])
        length = 3
        r = wma(x, length)
        assert np.isnan(r[:length - 1]).all()
        np.testing.assert_allclose(r[2],  (1*1 + 2*2 + 3*3) / 6)
        np.testing.assert_allclose(r[-1], (1*3 + 2*4 + 3*5) / 6)


class TestVWMA:
    def test_matches_manual(self):
        price  = np.array([10., 20., 30., 40.])
        volume = np.array([1.,   2.,  3.,  4.])
        r = vwma(price, volume, 2)
        assert np.isnan(r[0])
        np.testing.assert_allclose(r[1],  (10*1 + 20*2) / (1 + 2))
        np.testing.assert_allclose(r[-1], (30*3 + 40*4) / (3 + 4))

    def test_zero_volume_window_returns_nan(self):
        r = vwma(np.array([10., 20., 30.]), np.array([0., 0., 0.]), 2)
        assert np.isnan(r[1])
        assert np.isnan(r[2])

    def test_shape_mismatch_raises(self):
        with pytest.raises(ValueError):
            vwma(np.arange(5), np.arange(4), 2)


class TestHMA:
    def test_matches_manual(self):
        x = np.linspace(10.0, 30.0, 20)
        length = 9
        half   = int(round(length / 2))
        root   = int(round(math.sqrt(length)))
        expected = wma(2 * wma(x, half) - wma(x, length), root)
        np.testing.assert_allclose(hma(x, length), expected, rtol=1e-12)

    def test_length_too_small(self):
        with pytest.raises(ValueError):
            hma(np.arange(10), 1)
