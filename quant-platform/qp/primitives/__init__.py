"""
STAGE 10 — Primitive Library.

The boolean vocabulary of price action. Every strategy in the platform
should be expressible as a boolean composition of these primitives
against series produced by earlier stages.

  compare:
    - above / below / above_equal / below_equal
      Element-wise comparison; NaN either side → False.

  cross:
    - crossover(a, b) — a[i] > b[i] AND a[i-1] <= b[i-1]
    - crossunder(a, b) — a[i] < b[i] AND a[i-1] >= b[i-1]
    - cross(a, b) — either direction. TradingView `ta.cross`.

  interaction:
    - touch(bars, level, tol)     — bar range contains level ± tol.
    - touch_pct(bars, level, %)   — tolerance as a fraction of level.
    - reject_high(bars, level, tol) — touched AND close < level.
    - reject_low(bars, level, tol)  — touched AND close > level.
"""

from qp.primitives.compare import above, below, above_equal, below_equal
from qp.primitives.cross import crossover, crossunder, cross
from qp.primitives.interaction import (
    touch, touch_pct,
    reject_high, reject_low,
)

__all__ = [
    'above', 'below', 'above_equal', 'below_equal',
    'crossover', 'crossunder', 'cross',
    'touch', 'touch_pct',
    'reject_high', 'reject_low',
]
