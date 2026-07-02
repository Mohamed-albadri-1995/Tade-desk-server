"""
STAGE 19 — AI Analysis.

Per-setup expectancy models — PCA-decorrelate features, then Ridge-fit
against R multiple. Isolated per setup so features that matter to
'9:30 breakout' don't contaminate 'VWAP reject'.

  pca_fit(X, n_components?) → PCAModel
    Zero-mean SVD-based PCA. Kept lightweight — pure numpy, no sklearn.
  pca_transform(model, X) → projected coordinates.

  ridge_fit(X, y, alpha=1.0) → RidgeModel
    Closed-form Ridge with intercept fit via centring.
  ridge_predict(model, X) → predictions.

  fit_expectancy(features, r_multiples, feature_names,
                 n_components?, alpha=1.0) → ExpectancyModel
    Standardise → PCA → Ridge, pipeline captured in one dataclass.
  predict_expectancy(model, features) → expected R multiple.
  feature_importance(model) → {name: score} descending.
    Maps each raw feature's contribution through PCA loadings and Ridge
    coefficients to a single interpretable score.
"""

from qp.ai.pca import pca_fit, pca_transform, PCAModel
from qp.ai.ridge import ridge_fit, ridge_predict, RidgeModel
from qp.ai.expectancy import (
    fit_expectancy,
    predict_expectancy,
    feature_importance,
    ExpectancyModel,
)

__all__ = [
    'pca_fit', 'pca_transform', 'PCAModel',
    'ridge_fit', 'ridge_predict', 'RidgeModel',
    'fit_expectancy', 'predict_expectancy', 'feature_importance',
    'ExpectancyModel',
]
