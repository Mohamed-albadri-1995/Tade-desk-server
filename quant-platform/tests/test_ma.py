"""Tests for qp.ma — SMA and EMA parity with TradingView."""

import numpy as np
import pytest

from qp.ma import sma, ema


class TestSMA:
    def test_matches_manual_mean(self):
        x = np.arange(20, dtype=float)
        r = sma(x, 5)
        assert np.isnan(r[:4]).all()
        np.testing.assert_allclose(r[4], np.mean([0., 1., 2., 3., 4.]))
        np.testing.assert_allclose(r[-1], np.mean([15., 16., 17., 18., 19.]))


class TestEMA:
    def test_seeded_with_first_sample(self):
        """TradingView's ta.ema seeds with the first observation, not
        the mean of the first `length`. Verify that."""
        x = np.array([10., 20., 30., 40., 50.])
        r = ema(x, length=3)
        # First value == first sample.
        np.testing.assert_allclose(r[0], 10.0)

    def test_matches_manual_recursion(self):
        """Compare against a manual recursion of the TradingView formula."""
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
