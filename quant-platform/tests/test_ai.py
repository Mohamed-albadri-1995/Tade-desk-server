"""Tests for qp.ai — PCA, Ridge, per-setup expectancy pipeline."""

import numpy as np
import pandas as pd
import pytest

from qp.ai import (
    pca_fit, pca_transform,
    ridge_fit, ridge_predict,
    fit_expectancy, predict_expectancy, feature_importance,
)


class TestPCA:
    def test_2d_correlated_first_component_aligns(self):
        # Two features that are perfectly correlated along y=x direction.
        rng = np.random.default_rng(42)
        base = rng.normal(size=50)
        X = np.stack([base, base + 0.01 * rng.normal(size=50)], axis=1)
        m = pca_fit(X, n_components=2)
        # First component should point along (1, 1) / sqrt(2) direction
        # — check by aligning to +ve first coord.
        comp0 = m.components_[0]
        # sign can flip; align
        if comp0[0] < 0:
            comp0 = -comp0
        np.testing.assert_allclose(comp0[0], comp0[1], rtol=0.05)

    def test_explained_variance_sums_to_total(self):
        rng = np.random.default_rng(1)
        X = rng.normal(size=(100, 5))
        m = pca_fit(X)
        total_var = X.var(axis=0, ddof=1).sum()
        np.testing.assert_allclose(m.explained_variance_.sum(),
                                   total_var, rtol=1e-6)

    def test_transform_shape(self):
        X = np.arange(20, dtype=float).reshape(10, 2)
        m = pca_fit(X, n_components=1)
        Z = pca_transform(m, X)
        assert Z.shape == (10, 1)


class TestRidge:
    def test_recovers_linear_relation(self):
        rng = np.random.default_rng(0)
        X = rng.normal(size=(100, 3))
        true_coef = np.array([2.0, -1.0, 0.5])
        y = X @ true_coef + 1.0 + 0.001 * rng.normal(size=100)
        m = ridge_fit(X, y, alpha=0.001)
        np.testing.assert_allclose(m.coef_, true_coef, atol=1e-2)
        np.testing.assert_allclose(m.intercept_, 1.0, atol=1e-2)

    def test_zero_alpha_matches_ols(self):
        rng = np.random.default_rng(2)
        X = rng.normal(size=(50, 2))
        y = 3 * X[:, 0] - 2 * X[:, 1] + 5.0
        m = ridge_fit(X, y, alpha=0.0)
        np.testing.assert_allclose(m.coef_, [3.0, -2.0], atol=1e-6)
        np.testing.assert_allclose(m.intercept_, 5.0, atol=1e-6)

    def test_predict_roundtrip(self):
        X = np.array([[1., 2.], [3., 4.], [5., 6.]])
        y = np.array([1., 2., 3.])
        m = ridge_fit(X, y, alpha=0.01)
        p = ridge_predict(m, X)
        # Rough correlation with y
        assert np.corrcoef(p, y)[0, 1] > 0.99

    def test_negative_alpha_raises(self):
        with pytest.raises(ValueError):
            ridge_fit(np.array([[1.], [2.]]), np.array([1., 2.]), alpha=-1.0)


class TestExpectancyPipeline:
    def _synthetic(self, seed=0):
        rng = np.random.default_rng(seed)
        # 3 features: only feature[0] matters.
        n = 200
        X = rng.normal(size=(n, 3))
        y = 0.5 * X[:, 0] + 0.05 * rng.normal(size=n)
        return X, y

    def test_end_to_end_predicts_direction(self):
        X, y = self._synthetic(seed=1)
        m = fit_expectancy(X, y, feature_names=['f0', 'f1', 'f2'], alpha=0.1)
        preds = predict_expectancy(m, X)
        # High predicted r should correspond to high actual r on average.
        top10 = np.argsort(preds)[-20:]
        bot10 = np.argsort(preds)[:20]
        assert y[top10].mean() > y[bot10].mean()

    def test_feature_importance_flags_the_driver(self):
        X, y = self._synthetic(seed=2)
        m = fit_expectancy(X, y, feature_names=['driver', 'noise1', 'noise2'],
                           alpha=0.1)
        imp = feature_importance(m)
        assert list(imp.keys())[0] == 'driver'

    def test_predict_single_row(self):
        X, y = self._synthetic(seed=3)
        m = fit_expectancy(X, y, feature_names=['a', 'b', 'c'])
        one = predict_expectancy(m, X[0])
        assert one.shape == (1,)

    def test_bad_shapes_raise(self):
        with pytest.raises(ValueError):
            fit_expectancy(np.arange(6).reshape(2, 3),
                           np.array([1.0, 2.0, 3.0]),
                           feature_names=['a', 'b', 'c'])
        with pytest.raises(ValueError):
            fit_expectancy(np.arange(6).reshape(2, 3),
                           np.array([1.0, 2.0]),
                           feature_names=['a', 'b'])
