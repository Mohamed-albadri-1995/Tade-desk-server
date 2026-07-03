"""Rolling N-session VWAP and rolling N-session SMA.

These pin the "smooth line, not sawtooth" contract that distinguishes
rolling from anchored/reset VWAPs, plus the timeframe-adaptive window
that makes the same n_sessions produce different bar counts on 1m vs 5m
vs daily data.
"""

import numpy as np
import pandas as pd

from qp.ma import n_session_sma
from qp.vwap import rolling_n_day_vwap


def _bars(index, price, volume):
    df = pd.DataFrame({
        'open':  price, 'high': price, 'low': price, 'close': price,
        'volume': volume,
    }, index=index)
    return df


def _et(*times):
    return pd.DatetimeIndex([pd.Timestamp(t, tz='America/New_York') for t in times])


class TestRollingNDayVWAP:
    def test_two_day_window_covers_previous_and_current_session(self):
        # 3 sessions, 2 bars each. Rolling 2-day VWAP at each bar covers
        # sessions [i-1, i], so no sawtooth reset between them.
        idx = _et(
            '2025-01-06 09:30', '2025-01-06 09:31',
            '2025-01-07 09:30', '2025-01-07 09:31',
            '2025-01-08 09:30', '2025-01-08 09:31',
        )
        bars = _bars(idx, [10, 20, 30, 40, 50, 60], [1]*6)
        r = rolling_n_day_vwap(bars, 2)
        # Bar 4 (session 2 open): window covers sessions 1..2 = bars 2..4
        # → mean(30, 40, 50) = 40. If this returned 50 (reset behaviour),
        # the function would be a period VWAP, not rolling.
        np.testing.assert_allclose(r, [10.0, 15.0, 20.0, 25.0, 40.0, 45.0])

    def test_n_larger_than_history_uses_all_data(self):
        # 30-day VWAP with only 2 sessions of data — no reset, uses whole
        # window from bar 0 to current bar.
        idx = _et('2025-01-06 09:30', '2025-01-06 09:31',
                  '2025-01-07 09:30', '2025-01-07 09:31')
        bars = _bars(idx, [10, 20, 30, 40], [1, 1, 1, 1])
        r = rolling_n_day_vwap(bars, 30)
        # Cumulative from bar 0 onwards.
        np.testing.assert_allclose(r, [10.0, 15.0, 20.0, 25.0])

    def test_n_1_matches_session_vwap(self):
        # Rolling 1-day == daily session VWAP — window is only the current
        # session, so both must produce identical values.
        from qp.vwap import session_vwap
        idx = _et('2025-01-06 09:30', '2025-01-06 09:31',
                  '2025-01-07 09:30', '2025-01-07 09:31')
        bars = _bars(idx, [10, 20, 100, 200], [1, 1, 1, 1])
        np.testing.assert_allclose(rolling_n_day_vwap(bars, 1),
                                   session_vwap(bars))


class TestNSessionSMA:
    def test_daily_bars_gives_bar_count_equal_to_n_sessions(self):
        # 5 daily bars, n_sessions=3 → each SMA point averages last 3
        # daily closes (or fewer near the front).
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-07 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-08 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-09 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-10 09:30', tz='America/New_York'),
        ])
        bars = _bars(idx, [10, 20, 30, 40, 50], [1]*5)
        r = n_session_sma(bars, 3)
        # Session 0: mean(10) = 10
        # Session 1: mean(10, 20) = 15
        # Session 2: mean(10, 20, 30) = 20
        # Session 3: mean(20, 30, 40) = 30
        # Session 4: mean(30, 40, 50) = 40
        np.testing.assert_allclose(r, [10.0, 15.0, 20.0, 30.0, 40.0])

    def test_intraday_window_scales_with_bars_per_session(self):
        # 2 sessions × 3 intraday bars = 6 bars. n_sessions=2 means the
        # window is BOTH sessions' bars combined — 6 bars total by the
        # last one. Verifies the window is session-anchored, not fixed-N.
        idx = _et(
            '2025-01-06 09:30', '2025-01-06 09:31', '2025-01-06 09:32',
            '2025-01-07 09:30', '2025-01-07 09:31', '2025-01-07 09:32',
        )
        bars = _bars(idx, [10, 20, 30, 40, 50, 60], [1]*6)
        r = n_session_sma(bars, 2)
        # Bar 5: mean of all 6 = 35.
        assert abs(r[5] - 35.0) < 1e-9
