"""Tests for qp.levels — daily / week / month / rolling anchors."""

import numpy as np
import pandas as pd
import pytest

from qp.levels import (
    prev_day_high, prev_day_low,
    premarket_high, premarket_low,
    prev_week_high, prev_week_low,
    prev_month_high, prev_month_low,
    rolling_high, rolling_low,
    bars_high, bars_low,
)


def _bars(index, high, low, close=None, volume=None, open_=None):
    n = len(index)
    if close is None:
        close = high
    if open_ is None:
        open_ = close
    if volume is None:
        volume = np.ones(n)
    return pd.DataFrame({
        'open':  open_, 'high': high, 'low': low,
        'close': close, 'volume': volume,
    }, index=index)


def _et(*timestamps):
    return pd.DatetimeIndex([pd.Timestamp(t, tz='America/New_York')
                             for t in timestamps])


class TestPrevDayHigh:
    def test_first_day_has_nan(self):
        idx = _et('2025-01-06 09:30', '2025-01-06 09:31')
        bars = _bars(idx, high=[10, 11], low=[9, 10])
        r = prev_day_high(bars)
        assert np.isnan(r).all()

    def test_second_day_projects_first_day_high(self):
        # Day 1 regular session: high peaks at 15.
        idx = _et('2025-01-06 09:30', '2025-01-06 10:00',
                  '2025-01-07 09:30', '2025-01-07 09:31')
        bars = _bars(idx,
                     high=[12, 15, 20, 25],
                     low=[10, 11, 18, 20])
        r = prev_day_high(bars)
        np.testing.assert_allclose(r[:2], [np.nan, np.nan], equal_nan=True)
        np.testing.assert_allclose(r[2:], [15.0, 15.0])

    def test_prev_day_low_projects_first_day_low(self):
        idx = _et('2025-01-06 09:30', '2025-01-06 10:00',
                  '2025-01-07 09:30')
        bars = _bars(idx,
                     high=[12, 15, 20],
                     low=[8, 11, 18])
        r = prev_day_low(bars)
        assert r[2] == 8.0

    def test_ignores_premarket_and_after_hours(self):
        # Premarket high shouldn't leak into "prev day regular high".
        idx = _et('2025-01-06 08:00', '2025-01-06 09:30', '2025-01-06 10:00',
                  '2025-01-07 09:30')
        bars = _bars(idx,
                     high=[999, 12, 15, 20],
                     low=[500, 10, 11, 18])
        r = prev_day_high(bars)
        assert r[3] == 15.0


class TestPremarket:
    def test_high_carries_through_regular_session(self):
        idx = _et('2025-01-06 08:00', '2025-01-06 09:00',
                  '2025-01-06 09:30', '2025-01-06 10:00')
        bars = _bars(idx,
                     high=[10, 12, 20, 25],
                     low=[9,  11, 18, 22])
        r = premarket_high(bars)
        # Premarket bars: 10, then max(10,12)=12. Regular carries 12.
        np.testing.assert_allclose(r, [10, 12, 12, 12])

    def test_low_carries_through(self):
        idx = _et('2025-01-06 08:00', '2025-01-06 09:00',
                  '2025-01-06 09:30')
        bars = _bars(idx,
                     high=[10, 12, 20],
                     low=[9,  8, 18])
        r = premarket_low(bars)
        np.testing.assert_allclose(r, [9, 8, 8])

    def test_new_day_resets(self):
        idx = _et('2025-01-06 08:00', '2025-01-06 09:30',
                  '2025-01-07 08:00', '2025-01-07 09:30')
        bars = _bars(idx,
                     high=[10, 20, 30, 40],
                     low=[9, 18, 25, 35])
        r = premarket_high(bars)
        # Day 1 premarket high = 10 (only one PM bar); day 2 resets to 30.
        np.testing.assert_allclose(r, [10, 10, 30, 30])

    def test_regular_only_day_has_nan_premarket(self):
        idx = _et('2025-01-06 09:30', '2025-01-06 10:00')
        bars = _bars(idx, high=[10, 12], low=[9, 11])
        r = premarket_high(bars)
        assert np.isnan(r).all()


class TestPrevWeek:
    def test_projects_prior_iso_week(self):
        # Week 2: Jan 6 (Mon) → Jan 12. Week 3: Jan 13 onwards.
        idx = _et('2025-01-06 09:30', '2025-01-07 09:30',
                  '2025-01-13 09:30')
        bars = _bars(idx, high=[10, 20, 100], low=[8, 15, 90])
        assert np.isnan(prev_week_high(bars)[:2]).all()
        assert prev_week_high(bars)[2] == 20.0
        assert prev_week_low(bars)[2] == 8.0


class TestPrevMonth:
    def test_projects_prior_month_extremes(self):
        idx = _et('2025-01-31 09:30', '2025-02-03 09:30')
        bars = _bars(idx, high=[50, 100], low=[40, 90])
        assert np.isnan(prev_month_high(bars)[0])
        assert prev_month_high(bars)[1] == 50.0
        assert prev_month_low(bars)[1] == 40.0


class TestRollingExtremes:
    def test_rolling_high_matches_manual(self):
        x = np.array([1., 3., 2., 5., 4.])
        r = rolling_high(x, 3)
        assert np.isnan(r[:2]).all()
        np.testing.assert_allclose(r[2:], [3., 5., 5.])

    def test_rolling_low(self):
        x = np.array([5., 3., 4., 2., 1.])
        r = rolling_low(x, 3)
        np.testing.assert_allclose(r[2:], [3., 2., 1.])

    def test_bars_high_low(self):
        idx = _et('2025-01-06 09:30', '2025-01-06 09:31',
                  '2025-01-06 09:32', '2025-01-06 09:33')
        bars = _bars(idx, high=[10, 12, 11, 15], low=[8, 10, 9, 13])
        np.testing.assert_allclose(bars_high(bars, 2)[1:], [12, 12, 15])
        np.testing.assert_allclose(bars_low(bars, 2)[1:], [8, 9, 9])
