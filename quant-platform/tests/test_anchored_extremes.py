"""Anchored (running) and rolling-session HH/LL levels.

Same principles as the rolling / anchored VWAP and SMA tests: the
window must reset at RTH open (not calendar midnight) for anchored
variants, and the rolling variant must adapt to the input bar count
without any timeframe-specific parameter.
"""

import numpy as np
import pandas as pd

from qp.levels import (
    today_high, today_low,
    week_high, week_low,
    month_high, month_low,
    rolling_n_day_high, rolling_n_day_low,
)


def _bars(index, high, low, close=None, volume=None):
    close = high if close is None else close
    volume = [1] * len(index) if volume is None else volume
    return pd.DataFrame({
        'open': close, 'high': high, 'low': low, 'close': close,
        'volume': volume,
    }, index=index)


def _et(*times):
    return pd.DatetimeIndex([pd.Timestamp(t, tz='America/New_York') for t in times])


class TestTodayHighLow:
    def test_running_high_grows_and_resets_at_rth_open(self):
        # Two sessions. Premarket bar on Tuesday belongs to Monday's
        # session; Tuesday's HH only starts fresh at Tuesday 09:30.
        idx = _et(
            '2025-01-06 09:30',   # Mon RTH open
            '2025-01-06 10:00',   # Mon RTH
            '2025-01-06 14:00',   # Mon RTH (new high)
            '2025-01-07 08:00',   # Tue premarket — belongs to Mon session
            '2025-01-07 09:30',   # Tue RTH open — RESET
            '2025-01-07 09:35',   # Tue RTH
        )
        bars = _bars(idx,
                     high=[100, 105,  120, 115, 110, 108],
                     low=[100, 105,  120, 115, 110, 108])
        r_h = today_high(bars)
        r_l = today_low(bars)
        # Session 1 (bars 0..3): running max 100, 105, 120, 120
        # Session 2 (bars 4..5): running max 110, 110
        np.testing.assert_allclose(r_h, [100, 105, 120, 120, 110, 110])
        # Running min for the same bars
        np.testing.assert_allclose(r_l, [100, 100, 100, 100, 110, 108])


class TestWeekMonthAnchoredHL:
    def test_week_high_holds_across_days_within_week(self):
        # Mon and Tue same ISO week → week_high should carry Mon's peak
        # into Tue until a new high prints. New Monday resets.
        idx = _et(
            '2025-01-06 09:30',   # Mon of week 2
            '2025-01-07 09:30',   # Tue of week 2
            '2025-01-13 09:30',   # Mon of week 3 — RESET
        )
        bars = _bars(idx, high=[100, 90, 80], low=[100, 90, 80])
        r_h = week_high(bars)
        r_l = week_low(bars)
        np.testing.assert_allclose(r_h, [100, 100, 80])  # week 2 peak held; week 3 fresh
        np.testing.assert_allclose(r_l, [100, 90, 80])   # week 2 min tightens; week 3 fresh

    def test_month_high_reset_at_first_of_month(self):
        # Jan 31 vs Feb 3 — different months.
        idx = _et('2025-01-31 09:30', '2025-02-03 09:30')
        bars = _bars(idx, high=[100, 50], low=[100, 50])
        r_h = month_high(bars)
        np.testing.assert_allclose(r_h, [100, 50])  # RESET at Feb, doesn't carry Jan


class TestRollingNDayHL:
    def test_5_day_window_covers_previous_sessions(self):
        # 6 sessions × 1 bar each. Rolling 5-day HH at bar i covers
        # sessions [max(0,i-4), i]. So bar 5 (session 5) sees sessions
        # 1..5 = highs [90, 110, 100, 105, 120] → 120.
        idx = _et(
            '2025-01-06 09:30', '2025-01-07 09:30', '2025-01-08 09:30',
            '2025-01-09 09:30', '2025-01-10 09:30', '2025-01-13 09:30',
        )
        bars = _bars(idx,
                     high=[100, 90, 110, 100, 105, 120],
                     low=[100, 90, 110, 100, 105, 120])
        r = rolling_n_day_high(bars, 5)
        # Bar 0: window [100] → 100
        # Bar 1: [100, 90] → 100
        # Bar 2: [100, 90, 110] → 110
        # Bar 3: [100, 90, 110, 100] → 110
        # Bar 4: [100, 90, 110, 100, 105] → 110
        # Bar 5: [90, 110, 100, 105, 120] → 120 (bar 0's 100 dropped out)
        np.testing.assert_allclose(r, [100, 100, 110, 110, 110, 120])
        r_low = rolling_n_day_low(bars, 5)
        # Same window, min. Bar 5: min([90, 110, 100, 105, 120]) = 90
        np.testing.assert_allclose(r_low, [100, 90, 90, 90, 90, 90])

    def test_window_scales_with_bars_per_session(self):
        # 2 sessions × 3 bars each. n=2 → both sessions included at bar 5.
        idx = _et(
            '2025-01-06 09:30', '2025-01-06 09:31', '2025-01-06 09:32',
            '2025-01-07 09:30', '2025-01-07 09:31', '2025-01-07 09:32',
        )
        bars = _bars(idx,
                     high=[10, 20, 30, 40, 50, 60],
                     low=[10, 20, 30, 40, 50, 60])
        r_h = rolling_n_day_high(bars, 2)
        # Bar 5 sees all 6 bars → 60. Confirms window scales with per-session bar count.
        assert r_h[5] == 60.0
