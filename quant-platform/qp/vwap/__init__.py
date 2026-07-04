"""
STAGE 6 — VWAP Library.

One implementation. Every downstream VWAP flavour (session, 2-day, week,
month, quarter, year, anchored) is expressed as a **reset-mask** fed
into a single accumulator. Reset the cum-price×volume / cum-volume
running totals on new-day / new-week / new-month; that's it.

`anchored_vwap(bars, mask)` is the primitive. Everything else is a mask
generator.

Uses `qp.price.hlc3` for the price series — never re-derives.
Uses `qp.session.session_for_bars` for time-aware anchors.
"""

from qp.vwap.core import anchored_vwap
from qp.vwap.sessional import (
    session_vwap,
    n_day_vwap,
    weekly_vwap,
    monthly_vwap,
    quarterly_vwap,
    yearly_vwap,
)
from qp.vwap.rolling import rolling_n_day_vwap
from qp.vwap.anchored import (
    today_hh_vwap, today_ll_vwap,
    week_hh_vwap, week_ll_vwap,
    gap_vwap,
    last_hour_ll_vwap, last_hour_hh_vwap,
    earnings_vwap,
)
from qp.vwap.pivot_anchored import pivot_ll_vwap, pivot_hh_vwap
from qp.vwap.stdev_bands import vwap_stdev_bands, VwapBands

__all__ = [
    'anchored_vwap',
    'session_vwap', 'n_day_vwap', 'rolling_n_day_vwap',
    'weekly_vwap', 'monthly_vwap', 'quarterly_vwap', 'yearly_vwap',
    'today_hh_vwap', 'today_ll_vwap',
    'week_hh_vwap', 'week_ll_vwap',
    'gap_vwap',
    'last_hour_ll_vwap', 'last_hour_hh_vwap',
    'earnings_vwap',
    'pivot_ll_vwap', 'pivot_hh_vwap',
    'vwap_stdev_bands', 'VwapBands',
]
