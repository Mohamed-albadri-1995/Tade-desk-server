"""
Ridge regression — closed-form solution, no sklearn needed.

    minimise ||X β - y||² + alpha ||β||²

Closed-form:
    β = (X^T X + alpha I)⁻¹ X^T y

Intercept is fit by centring X and y before the solve, then recovering
`intercept = y_mean - X_mean · β`. This matches sklearn's default
`fit_intercept=True`.

The regulariser only applies to the coefficients β, never the intercept
— same convention as sklearn.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class RidgeModel:
    coef_:      np.ndarray  # (n_features,)
    intercept_: float
    alpha:      float


def ridge_fit(X, y, alpha: float = 1.0) -> RidgeModel:
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    if X.ndim != 2:
        raise ValueError(f'X must be 2-D, got shape {X.shape}')
    if y.shape != (X.shape[0],):
        raise ValueError(f'y must have shape ({X.shape[0]},), got {y.shape}')
    if alpha < 0:
        raise ValueError(f'alpha must be >= 0, got {alpha!r}')

    x_mean = X.mean(axis=0)
    y_mean = y.mean()
    Xc = X - x_mean
    yc = y - y_mean

    n_features = X.shape[1]
    A = Xc.T @ Xc + alpha * np.eye(n_features)
    b = Xc.T @ yc
    coef = np.linalg.solve(A, b)
    intercept = float(y_mean - x_mean @ coef)
    return RidgeModel(coef_=coef, intercept_=intercept, alpha=alpha)


def ridge_predict(model: RidgeModel, X) -> np.ndarray:
    X = np.asarray(X, dtype=float)
    return X @ model.coef_ + model.intercept_
