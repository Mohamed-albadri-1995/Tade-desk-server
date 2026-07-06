"""qp - Verified quantitative primitives library.

All mathematical/indicator logic for the trading tool lives here.
Every primitive is registered in ``qp.REGISTRY`` and exposed to sandboxed
scripts through dynamic methods on the injected ``market_data`` object
(e.g. ``market_data.sma(stock, length=9)``), which routes to
``qp.REGISTRY[key].fn``.
"""

from qp.registry import REGISTRY, Primitive, register

# Importing the primitives package populates the REGISTRY.
import qp.primitives  # noqa: F401  (side-effect import)

__all__ = ["REGISTRY", "Primitive", "register"]
