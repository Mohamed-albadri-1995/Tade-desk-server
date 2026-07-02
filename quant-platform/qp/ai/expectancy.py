"""
Per-setup expectancy model — PCA-decorrelate features, then Ridge-fit
against r_multiple. Isolated per setup so features that matter to
"9:30 breakout" don't contaminate "VWAP reject".

Pipeline:
    features: (n_trades × n_features) numeric matrix.
    targets:  (n_trades,) r_multiple values.

    1. Standardise: (X - mean) / std   (avoid PCA being dominated by
       high-variance features that happen to be on larger scales).
    2. PCA to `n_components` (default: keep enough for 95% variance).
    3. Ridge on the components.
    4. Feature importance = |components^T · ridge_coef|, scaled by the
       original feature std so it's expressed in "impact per one
       standard deviation of raw feature".

`predict(model, features)` gives an expected r_multiple.

`importance(model)` gives a per-feature score for UI display / the
Node-side feature importance panel.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from qp.ai.pca import PCAModel, pca_fit, pca_transform
from qp.ai.ridge import RidgeModel, ridge_fit, ridge_predict


@dataclass(frozen=True)
class ExpectancyModel:
    feature_names: List[str]
    feature_mean:  np.ndarray
    feature_std:   np.ndarray
    pca:           PCAModel
    ridge:         RidgeModel
    n_trades:      int


def _standardise(X: np.ndarray) -> tuple:
    mean = X.mean(axis=0)
    std  = X.std(axis=0, ddof=0)
    std_safe = np.where(std > 1e-12, std, 1.0)  # avoid /0 on constant cols.
    return (X - mean) / std_safe, mean, std_safe


def fit_expectancy(features: np.ndarray, r_multiples: np.ndarray,
                   feature_names: List[str],
                   n_components: Optional[int] = None,
                   alpha: float = 1.0) -> ExpectancyModel:
    X = np.asarray(features, dtype=float)
    y = np.asarray(r_multiples, dtype=float)
    if X.ndim != 2:
        raise ValueError(f'features must be 2-D, got {X.shape}')
    if y.shape != (X.shape[0],):
        raise ValueError(f'r_multiples must have shape ({X.shape[0]},), '
                         f'got {y.shape}')
    if len(feature_names) != X.shape[1]:
        raise ValueError(f'feature_names must have length {X.shape[1]}, '
                         f'got {len(feature_names)}')

    Xs, mean, std = _standardise(X)
    pca = pca_fit(Xs, n_components=n_components)
    Z = pca_transform(pca, Xs)
    ridge = ridge_fit(Z, y, alpha=alpha)
    return ExpectancyModel(
        feature_names=list(feature_names),
        feature_mean=mean, feature_std=std,
        pca=pca, ridge=ridge,
        n_trades=int(X.shape[0]),
    )


def predict_expectancy(model: ExpectancyModel, features: np.ndarray) -> np.ndarray:
    X = np.asarray(features, dtype=float)
    if X.ndim == 1:
        X = X.reshape(1, -1)
    Xs = (X - model.feature_mean) / np.where(model.feature_std > 1e-12,
                                             model.feature_std, 1.0)
    Z = pca_transform(model.pca, Xs)
    return ridge_predict(model.ridge, Z)


def feature_importance(model: ExpectancyModel) -> dict:
    """Per-feature importance: sum |PC loading · ridge coefficient| for
    each raw feature, expressed in impact-per-standard-deviation.

    Returns {feature_name: score} sorted descending.
    """
    # components_: (n_components, n_features_raw)
    # ridge.coef_: (n_components,)
    # importance in standardised space = |components_.T · coef|
    raw_impact = np.abs(model.pca.components_.T @ model.ridge.coef_)
    # Scaled by feature_std to express in original-units impact — but
    # since features are heterogeneous, we present the standardised
    # score which is what the UI actually uses to compare features
    # apples-to-apples.
    ordered = sorted(zip(model.feature_names, raw_impact.tolist()),
                     key=lambda kv: kv[1], reverse=True)
    return {name: float(score) for name, score in ordered}
