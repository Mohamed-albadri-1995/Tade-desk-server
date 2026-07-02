"""
STAGE 3 — Mathematical Foundation.

Rolling operations + slope + linear regression + change / ROC.
Nothing in here knows what "close" or "volume" is. It all works on 1-D
arrays. That's the whole point — you should be able to compute
`slope(vwap)`, `slope(ema)`, `slope(bb_middle)`, `slope(atr)` with
one function.
"""

from qp.math_foundation.rolling import (
    rolling_mean,
    rolling_sum,
    rolling_std,
    rolling_variance,
    rolling_max,
    rolling_min,
    rolling_median,
)
from qp.math_foundation.basic import (
    change,
    roc,
    pct_change,
    difference,
    normalize,
    linear_regression,
    slope,
    angle_deg,
    acceleration,
)

__all__ = [
    'rolling_mean', 'rolling_sum', 'rolling_std', 'rolling_variance',
    'rolling_max', 'rolling_min', 'rolling_median',
    'change', 'roc', 'pct_change', 'difference', 'normalize',
    'linear_regression', 'slope', 'angle_deg', 'acceleration',
]
