"""
Principal Component Analysis via SVD — no sklearn needed.

Given a feature matrix X (n_samples × n_features):
    1. Centre X: X_c = X - mean(X, axis=0)
    2. SVD: X_c = U · diag(s) · V^T
    3. Components = V (each row is a component, ordered by singular
       value descending — same convention as sklearn).
    4. Explained variance for component k = s[k]² / (n - 1).
    5. Transform: Z = X_c · V^T.T = X_c · V (n_samples × n_components).

Handles the common "more features than samples" case gracefully
(SVD works on rectangular matrices).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass(frozen=True)
class PCAModel:
    mean_: np.ndarray             # (n_features,)
    components_: np.ndarray       # (n_components, n_features)
    explained_variance_: np.ndarray  # (n_components,)
    n_components: int


def pca_fit(X, n_components: Optional[int] = None) -> PCAModel:
    """Fit a PCA model. If `n_components` is None, keep all components
    that have non-negligible variance."""
    X = np.asarray(X, dtype=float)
    if X.ndim != 2:
        raise ValueError(f'X must be 2-D, got shape {X.shape}')
    n_samples, n_features = X.shape
    if n_samples < 2:
        raise ValueError('PCA needs at least 2 samples')

    mean = X.mean(axis=0)
    Xc = X - mean
    # full_matrices=False → V has shape (min(n,d), d).
    U, s, Vt = np.linalg.svd(Xc, full_matrices=False)
    explained = (s ** 2) / (n_samples - 1)
    max_c = Vt.shape[0]
    if n_components is None:
        n_components = max_c
    n_components = min(n_components, max_c)
    return PCAModel(
        mean_=mean,
        components_=Vt[:n_components],
        explained_variance_=explained[:n_components],
        n_components=n_components,
    )


def pca_transform(model: PCAModel, X) -> np.ndarray:
    """Project X onto the model's components."""
    X = np.asarray(X, dtype=float)
    Xc = X - model.mean_
    return Xc @ model.components_.T
