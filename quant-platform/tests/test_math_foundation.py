"""Unit tests for qp.math_foundation — the layer downstream of nothing."""

import numpy as np
import pandas as pd
import pytest

from qp.math_foundation import (
    rolling_mean, rolling_sum, rolling_std, rolling_variance,
    rolling_max, rolling_min, rolling_median,
    change, roc, pct_change, difference, normalize,
    linear_regression, slope, angle_deg, acceleration,
)


class TestRolling:
    def test_rolling_mean_matches_pandas(self):
        x = np.arange(10, dtype=float)
        r = rolling_mean(x, 3)
        # First two positions NaN.
        assert np.isnan(r[:2]).all()
        # Third onward: mean of the last 3.
        np.testing.assert_allclose(r[2:], [1., 2., 3., 4., 5., 6., 7., 8.])

    def test_rolling_sum(self):
        x = np.array([1., 2., 3., 4., 5.])
        r = rolling_sum(x, 2)
        assert np.isnan(r[0])
        np.testing.assert_allclose(r[1:], [3., 5., 7., 9.])

    def test_rolling_std_population(self):
        x = np.array([2., 4., 4., 4., 5., 5., 7., 9.])
        r = rolling_std(x, 8, ddof=0)
        # Population std of x = 2.
        assert np.isnan(r[:7]).all()
        np.testing.assert_allclose(r[7], 2.0)

    def test_rolling_variance(self):
        x = np.array([1., 2., 3., 4.])
        r = rolling_variance(x, 4, ddof=0)
        # Population var of [1,2,3,4] = 1.25.
        assert np.isnan(r[:3]).all()
        np.testing.assert_allclose(r[3], 1.25)

    def test_rolling_max_min(self):
        x = np.array([3., 1., 4., 1., 5., 9., 2., 6.])
        assert rolling_max(x, 3)[-1] == 9.0
        assert rolling_min(x, 3)[-1] == 2.0

    def test_rolling_median(self):
        x = np.array([1., 2., 3., 4., 5.])
        r = rolling_median(x, 3)
        np.testing.assert_allclose(r[2:], [2., 3., 4.])

    def test_accepts_pandas_series(self):
        s = pd.Series([1., 2., 3., 4., 5.])
        r = rolling_mean(s, 2)
        assert isinstance(r, np.ndarray)
        np.testing.assert_allclose(r[1:], [1.5, 2.5, 3.5, 4.5])

    def test_invalid_length(self):
        with pytest.raises(ValueError):
            rolling_mean([1., 2., 3.], 0)


class TestBasic:
    def test_change(self):
        r = change([1., 3., 6., 10.])
        assert np.isnan(r[0])
        np.testing.assert_allclose(r[1:], [2., 3., 4.])

    def test_change_offset(self):
        r = change([1., 2., 4., 8.], offset=2)
        assert np.isnan(r[:2]).all()
        np.testing.assert_allclose(r[2:], [3., 6.])

    def test_difference_is_alias(self):
        np.testing.assert_allclose(difference([1., 5., 10.]), change([1., 5., 10.]))

    def test_roc(self):
        r = roc([100., 110., 121.], 1)
        assert np.isnan(r[0])
        np.testing.assert_allclose(r[1:], [10.0, 10.0], rtol=1e-6)

    def test_pct_change_is_roc_over_100(self):
        a = pct_change([100., 110.], 1)
        b = roc([100., 110.], 1) / 100.0
        assert np.isnan(a[0])
        np.testing.assert_allclose(a[1:], b[1:])

    def test_normalize_minmax(self):
        r = normalize([0., 5., 10.], method='minmax')
        np.testing.assert_allclose(r, [0., 0.5, 1.])

    def test_normalize_zscore(self):
        r = normalize([1., 2., 3.], method='zscore')
        np.testing.assert_allclose(r.mean(), 0.0, atol=1e-9)
        np.testing.assert_allclose(r.std(), 1.0, atol=1e-9)

    def test_normalize_constant(self):
        # Constant input → all zeros, no divide-by-zero.
        np.testing.assert_allclose(normalize([5., 5., 5.], 'minmax'), [0., 0., 0.])
        np.testing.assert_allclose(normalize([5., 5., 5.], 'zscore'), [0., 0., 0.])

    def test_slope_of_line(self):
        # A line y = 2x + 1 → slope 2 everywhere the window is full.
        x = np.array([1., 3., 5., 7., 9., 11.])
        m = slope(x, 4)
        assert np.isnan(m[:3]).all()
        np.testing.assert_allclose(m[3:], [2., 2., 2.])

    def test_linear_regression_returns_slope_and_intercept(self):
        # y = 3x + 5 evaluated at x=[5,8,11,14,17,20]. Window length 4
        # takes the last 4: values [11,14,17,20], fitted against internal
        # x-axis [0,1,2,3]. Slope stays 3; intercept is 11 (y at
        # position 0 within the window = the value at original x=2 = 11).
        x = np.array([5., 8., 11., 14., 17., 20.])
        m, b = linear_regression(x, 4)
        np.testing.assert_allclose(m[-1], 3.0)
        np.testing.assert_allclose(b[-1], 11.0)

    def test_angle_deg(self):
        # Slope 1 → 45°.
        x = np.array([1., 2., 3., 4., 5.])
        a = angle_deg(x, 5)
        np.testing.assert_allclose(a[-1], 45.0)

    def test_acceleration(self):
        # Constant-slope input → acceleration 0 once both windows exist.
        x = np.array([1., 2., 3., 4., 5., 6., 7., 8.])
        acc = acceleration(x, 3)
        # First non-NaN acceleration should be ~0.
        finite = acc[~np.isnan(acc)]
        np.testing.assert_allclose(finite, 0.0, atol=1e-9)
