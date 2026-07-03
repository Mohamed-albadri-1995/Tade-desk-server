"""Tests for qp.vwap — the anchored primitive and every session flavour.

Manual reference calculations, not lifted from the source. If the source
regresses, these fail.
"""

import numpy as np
import pandas as pd
import pytest

from qp.vwap import (
    anchored_vwap,
    session_vwap,
    n_day_vwap,
    weekly_vwap,
    monthly_vwap,
    quarterly_vwap,
    yearly_vwap,
)
from qp.price import hlc3


def _bars(index, high, low, close, volume, open_=None):
    df = pd.DataFrame({
        'open':  open_ if open_ is not None else close,
        'high':  high,
        'low':   low,
        'close': close,
        'volume': volume,
    }, index=index)
    return df


def _et_index(start='2025-01-06 09:30', periods=5, freq='1min'):
    """Timezone-aware ET index (Monday 9:30 ET default)."""
    return pd.date_range(start, periods=periods, freq=freq, tz='America/New_York')


class TestAnchoredVWAP:
    def test_matches_manual_cumulative(self):
        idx = _et_index(periods=4)
        bars = _bars(idx,
                     high=[10, 11, 12, 13],
                     low=[9, 10, 11, 12],
                     close=[10, 11, 12, 13],
                     volume=[100, 100, 100, 100])
        mask = np.array([True, False, False, False])
        r = anchored_vwap(bars, mask)
        # hlc3 = high+low+close / 3, same as close here.
        p = hlc3(bars)
        expected = np.array([
            p[0],
            (p[0]*100 + p[1]*100) / 200,
            (p[0]*100 + p[1]*100 + p[2]*100) / 300,
            (p[0]*100 + p[1]*100 + p[2]*100 + p[3]*100) / 400,
        ])
        np.testing.assert_allclose(r, expected, rtol=1e-12)

    def test_reset_zeroes_accumulator(self):
        idx = _et_index(periods=4)
        bars = _bars(idx,
                     high=[10, 20, 30, 40],
                     low=[10, 20, 30, 40],
                     close=[10, 20, 30, 40],
                     volume=[1, 1, 1, 1])
        # Reset before bar index 2.
        mask = np.array([True, False, True, False])
        r = anchored_vwap(bars, mask)
        # After reset at i=2: accumulator = (30 + 40)/2 = 35 at i=3.
        assert r[0] == 10
        assert r[1] == 15
        assert r[2] == 30
        assert r[3] == 35

    def test_zero_volume_yields_nan(self):
        idx = _et_index(periods=3)
        bars = _bars(idx,
                     high=[10, 11, 12],
                     low=[10, 11, 12],
                     close=[10, 11, 12],
                     volume=[0, 0, 0])
        mask = np.array([True, False, False])
        r = anchored_vwap(bars, mask)
        assert np.isnan(r).all()

    def test_shape_mismatch_raises(self):
        idx = _et_index(periods=3)
        bars = _bars(idx,
                     high=[1, 2, 3], low=[1, 2, 3],
                     close=[1, 2, 3], volume=[1, 1, 1])
        with pytest.raises(ValueError):
            anchored_vwap(bars, np.array([True, False]))

    def test_custom_price_series(self):
        idx = _et_index(periods=3)
        bars = _bars(idx,
                     high=[10, 20, 30], low=[10, 20, 30],
                     close=[10, 20, 30], volume=[1, 1, 1])
        mask = np.array([True, False, False])
        custom = np.array([100.0, 200.0, 300.0])
        r = anchored_vwap(bars, mask, price=custom)
        np.testing.assert_allclose(r, [100.0, 150.0, 200.0])


class TestSessionVWAP:
    def test_resets_at_calendar_day_boundary(self):
        # Two consecutive ET days, 2 bars each.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-06 09:31', tz='America/New_York'),
            pd.Timestamp('2025-01-07 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-07 09:31', tz='America/New_York'),
        ])
        bars = _bars(idx,
                     high=[10, 20, 100, 200],
                     low=[10, 20, 100, 200],
                     close=[10, 20, 100, 200],
                     volume=[1, 1, 1, 1])
        r = session_vwap(bars)
        # Day 1: [10, 15], Day 2 resets → [100, 150].
        np.testing.assert_allclose(r, [10.0, 15.0, 100.0, 150.0])

    def test_dst_boundary_utc_index_does_not_spuriously_reset(self):
        # Bars at 04:00 UTC (23:00 previous-day ET) → still same ET day.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 14:30', tz='UTC'),  # 09:30 ET
            pd.Timestamp('2025-01-06 14:31', tz='UTC'),  # 09:31 ET
        ])
        bars = _bars(idx,
                     high=[10, 20], low=[10, 20],
                     close=[10, 20], volume=[1, 1])
        r = session_vwap(bars)
        np.testing.assert_allclose(r, [10.0, 15.0])

    def test_tz_naive_raises(self):
        idx = pd.date_range('2025-01-06 09:30', periods=2, freq='1min')
        bars = _bars(idx,
                     high=[10, 20], low=[10, 20],
                     close=[10, 20], volume=[1, 1])
        with pytest.raises(ValueError):
            session_vwap(bars)

    def test_resets_at_rth_open_not_calendar_midnight(self):
        # This is the key TradingView-parity property: even when
        # premarket bars precede the RTH open, the accumulator must
        # NOT reset at 04:00 (premarket start) or at 00:00 (calendar
        # midnight). It resets at 09:30 ET.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 08:00', tz='America/New_York'),  # premarket
            pd.Timestamp('2025-01-06 09:00', tz='America/New_York'),  # premarket
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),  # RTH open — RESET here
            pd.Timestamp('2025-01-06 09:31', tz='America/New_York'),  # RTH
        ])
        bars = _bars(idx,
                     high=[50, 60, 100, 200],
                     low=[50, 60, 100, 200],
                     close=[50, 60, 100, 200],
                     volume=[1, 1, 1, 1])
        r = session_vwap(bars)
        # Premarket bars form their own accumulator until 09:30 hits.
        # Then RTH starts fresh at 100 and accumulates with 200.
        np.testing.assert_allclose(r, [50.0, 55.0, 100.0, 150.0])

    def test_premarket_next_day_extends_previous_session(self):
        # A premarket bar on Jan 7 (before 09:30) belongs to the SAME
        # session as Jan 6's RTH bars — the accumulator must continue
        # overnight until Jan 7 09:30 resets it.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),  # Jan 6 RTH open
            pd.Timestamp('2025-01-06 15:59', tz='America/New_York'),  # Jan 6 RTH close-ish
            pd.Timestamp('2025-01-07 08:00', tz='America/New_York'),  # Jan 7 premarket
            pd.Timestamp('2025-01-07 09:30', tz='America/New_York'),  # Jan 7 RTH — RESET
        ])
        bars = _bars(idx,
                     high=[10, 20, 30, 100],
                     low=[10, 20, 30, 100],
                     close=[10, 20, 30, 100],
                     volume=[1, 1, 1, 1])
        r = session_vwap(bars)
        # Session 1: [10, 15, 20]  (all Jan 6 09:30-based session)
        # Session 2 (Jan 7 09:30): [100]
        np.testing.assert_allclose(r, [10.0, 15.0, 20.0, 100.0])


class TestNDayVWAP:
    def test_n1_matches_session_vwap(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),
            pd.Timestamp('2025-01-07 09:30', tz='America/New_York'),
        ])
        bars = _bars(idx,
                     high=[10, 20], low=[10, 20],
                     close=[10, 20], volume=[1, 1])
        np.testing.assert_allclose(n_day_vwap(bars, 1), session_vwap(bars))

    def test_n2_resets_every_two_days(self):
        # 4 consecutive days, 1 bar each.
        idx = pd.DatetimeIndex([
            pd.Timestamp(f'2025-01-{d:02d} 09:30', tz='America/New_York')
            for d in (6, 7, 8, 9)
        ])
        bars = _bars(idx,
                     high=[10, 20, 30, 40],
                     low=[10, 20, 30, 40],
                     close=[10, 20, 30, 40],
                     volume=[1, 1, 1, 1])
        r = n_day_vwap(bars, 2)
        # Days 0,1 in one window; days 2,3 in next.
        np.testing.assert_allclose(r, [10.0, 15.0, 30.0, 35.0])

    def test_invalid_n_raises(self):
        idx = _et_index(periods=2)
        bars = _bars(idx, high=[10, 20], low=[10, 20],
                     close=[10, 20], volume=[1, 1])
        with pytest.raises(ValueError):
            n_day_vwap(bars, 0)
        with pytest.raises(ValueError):
            n_day_vwap(bars, 1.5)


class TestWeeklyVWAP:
    def test_premarket_monday_still_in_previous_week(self):
        # Premarket bar at 08:00 ET Monday belongs to the PREVIOUS
        # session (Friday's), so the weekly VWAP does NOT reset until
        # Monday 09:30 ET. Matches the session-anchored behaviour of
        # session_vwap — no spurious mid-morning weekly reset.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-03 09:30', tz='America/New_York'),  # Friday RTH
            pd.Timestamp('2025-01-06 08:00', tz='America/New_York'),  # Mon premarket
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),  # Mon RTH — reset
            pd.Timestamp('2025-01-06 09:31', tz='America/New_York'),  # Mon RTH
        ])
        bars = _bars(idx,
                     high=[10, 20, 100, 200], low=[10, 20, 100, 200],
                     close=[10, 20, 100, 200], volume=[1, 1, 1, 1])
        r = weekly_vwap(bars)
        # Session 1 (Fri + Mon premarket): [10, 15]
        # Session 2 (Mon RTH+): [100, 150]
        np.testing.assert_allclose(r, [10.0, 15.0, 100.0, 150.0])

    def test_resets_at_iso_week_boundary(self):
        # ISO week 2 of 2025 starts Mon 2025-01-06; week 3 starts Mon 2025-01-13.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),  # week 2
            pd.Timestamp('2025-01-07 09:30', tz='America/New_York'),  # week 2
            pd.Timestamp('2025-01-13 09:30', tz='America/New_York'),  # week 3
        ])
        bars = _bars(idx,
                     high=[10, 20, 100], low=[10, 20, 100],
                     close=[10, 20, 100], volume=[1, 1, 1])
        r = weekly_vwap(bars)
        np.testing.assert_allclose(r, [10.0, 15.0, 100.0])


class TestMonthlyVWAP:
    def test_resets_at_month_boundary(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-01-31 09:30', tz='America/New_York'),
            pd.Timestamp('2025-02-03 09:30', tz='America/New_York'),
        ])
        bars = _bars(idx,
                     high=[10, 100], low=[10, 100],
                     close=[10, 100], volume=[1, 1])
        r = monthly_vwap(bars)
        np.testing.assert_allclose(r, [10.0, 100.0])


class TestQuarterlyVWAP:
    def test_resets_at_quarter_boundary(self):
        # Q1 → Q2 boundary is 2025-03-31 → 2025-04-01.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-03-31 09:30', tz='America/New_York'),
            pd.Timestamp('2025-04-01 09:30', tz='America/New_York'),
        ])
        bars = _bars(idx,
                     high=[10, 100], low=[10, 100],
                     close=[10, 100], volume=[1, 1])
        r = quarterly_vwap(bars)
        np.testing.assert_allclose(r, [10.0, 100.0])

    def test_no_reset_within_quarter(self):
        # Two Q2 days.
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-04-01 09:30', tz='America/New_York'),
            pd.Timestamp('2025-05-01 09:30', tz='America/New_York'),
        ])
        bars = _bars(idx,
                     high=[10, 20], low=[10, 20],
                     close=[10, 20], volume=[1, 1])
        r = quarterly_vwap(bars)
        np.testing.assert_allclose(r, [10.0, 15.0])


class TestYearlyVWAP:
    def test_resets_at_year_boundary(self):
        idx = pd.DatetimeIndex([
            pd.Timestamp('2025-12-31 09:30', tz='America/New_York'),
            pd.Timestamp('2026-01-02 09:30', tz='America/New_York'),
        ])
        bars = _bars(idx,
                     high=[10, 100], low=[10, 100],
                     close=[10, 100], volume=[1, 1])
        r = yearly_vwap(bars)
        np.testing.assert_allclose(r, [10.0, 100.0])
