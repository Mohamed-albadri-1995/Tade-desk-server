"""
STAGE 15 — Validation Mode.

Tools for proving TradingView parity — the prerequisite for stamping a
`VERIFIED` header on a primitive.

Workflow:
    1. Compute the platform's series over a real bar sample.
    2. `export_series(bars, {'ema_20': ema20}, 'ema_20.csv')`.
    3. Paste TradingView's output next to it (or import into TV's UI).
    4. `compare(computed, reference)` → CompareResult with per-bar
       residuals and a pass/fail verdict.

If it passes, the primitive earns its VERIFIED header. If not, the
mismatched bars tell you exactly where to hunt.
"""

from qp.validation.export import export_series
from qp.validation.compare import compare, CompareResult

__all__ = ['export_series', 'compare', 'CompareResult']
