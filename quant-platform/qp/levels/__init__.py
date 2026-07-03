"""
STAGE 8 — Level Library.

Historical anchor levels — every "yesterday's high", "prior-week low",
"20-day highest close" a strategy needs, expressed once.

Categories:
    - session_daily   → prev_day_high / prev_day_low
                        premarket_high / premarket_low
    - session_week_month → prev_week_high / prev_week_low
                            prev_month_high / prev_month_low
    - rolling_extremes → rolling_high / rolling_low (bar-count)
                          bars_high / bars_low (convenience over OHLC)

All session-scoped levels use a `SessionSpec` for tz-aware bucketing so
DST and after-hours don't produce false boundaries.
"""

from qp.levels.session_daily import (
    prev_day_high,
    prev_day_low,
    premarket_high,
    premarket_low,
)
from qp.levels.session_week_month import (
    prev_week_high,
    prev_week_low,
    prev_month_high,
    prev_month_low,
)
from qp.levels.rolling_extremes import (
    rolling_high,
    rolling_low,
    bars_high,
    bars_low,
)
from qp.levels.anchored_extremes import (
    today_high, today_low,
    week_high, week_low,
    month_high, month_low,
    quarter_high, quarter_low,
    year_high, year_low,
)
from qp.levels.rolling_session_extremes import (
    rolling_n_day_high, rolling_n_day_low,
)

__all__ = [
    'prev_day_high', 'prev_day_low',
    'premarket_high', 'premarket_low',
    'prev_week_high', 'prev_week_low',
    'prev_month_high', 'prev_month_low',
    'rolling_high', 'rolling_low',
    'bars_high', 'bars_low',
    'today_high', 'today_low',
    'week_high', 'week_low',
    'month_high', 'month_low',
    'quarter_high', 'quarter_low',
    'year_high', 'year_low',
    'rolling_n_day_high', 'rolling_n_day_low',
]
