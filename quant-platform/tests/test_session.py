"""Tests for qp.session."""

from datetime import time

import numpy as np
import pandas as pd
import pytest

from qp.session import (
    SessionSpec, US_EQUITIES,
    is_regular, is_premarket, is_after_hours, is_extended,
    current_session, session_open, session_close,
    session_length_minutes, session_index,
)
from qp.session.engine import session_for_bars


def et(y, m, d, hh, mm=0):
    """Convenience: build a tz-aware ET timestamp."""
    return pd.Timestamp(f'{y:04d}-{m:02d}-{d:02d} {hh:02d}:{mm:02d}',
                        tz='America/New_York')


class TestClassifiers:
    def test_regular_hours(self):
        ts = et(2026, 6, 15, 10, 30)   # 10:30 ET → regular
        assert current_session(ts) == 'regular'
        assert is_regular(ts)
        assert not is_premarket(ts)
        assert not is_after_hours(ts)

    def test_premarket(self):
        ts = et(2026, 6, 15, 7, 0)     # 07:00 ET → premarket
        assert current_session(ts) == 'premarket'
        assert is_premarket(ts)
        assert is_extended(ts)

    def test_after_hours(self):
        ts = et(2026, 6, 15, 17, 30)   # 17:30 ET → after-hours
        assert current_session(ts) == 'after_hours'
        assert is_after_hours(ts)
        assert is_extended(ts)

    def test_closed(self):
        ts = et(2026, 6, 15, 3, 0)     # 03:00 ET → closed
        assert current_session(ts) == 'closed'


class TestSessionBounds:
    def test_regular_open_close(self):
        ts = et(2026, 6, 15, 10)
        open_ts  = session_open(ts, US_EQUITIES, 'regular')
        close_ts = session_close(ts, US_EQUITIES, 'regular')
        assert open_ts.time()  == time(9, 30)
        assert close_ts.time() == time(16, 0)

    def test_length_minutes(self):
        assert session_length_minutes(US_EQUITIES, 'regular') == 6 * 60 + 30
        assert session_length_minutes(US_EQUITIES, 'premarket') == 5 * 60 + 30
        assert session_length_minutes(US_EQUITIES, 'after_hours') == 4 * 60


class TestSessionIndex:
    def test_ten_minutes_into_regular(self):
        ts = et(2026, 6, 15, 9, 40)
        assert session_index(ts, US_EQUITIES, 'regular') == 10

    def test_index_none_when_outside(self):
        # 08:00 ET is premarket, so 'regular'-index should be None.
        ts = et(2026, 6, 15, 8, 0)
        assert session_index(ts, US_EQUITIES, 'regular') is None


class TestSessionForBars:
    def test_labels_align_with_bars(self):
        idx = pd.DatetimeIndex([
            et(2026, 6, 15, 7,  0),   # premarket
            et(2026, 6, 15, 10, 0),   # regular
            et(2026, 6, 15, 15, 59),  # regular (last minute)
            et(2026, 6, 15, 16, 0),   # after-hours (regular closed at :00)
            et(2026, 6, 15, 21, 0),   # closed
        ])
        df = pd.DataFrame({'open':[1.]*5, 'high':[1.]*5, 'low':[1.]*5,
                           'close':[1.]*5, 'volume':[1.]*5}, index=idx)
        labels = session_for_bars(df, US_EQUITIES).tolist()
        assert labels == ['premarket', 'regular', 'regular', 'after_hours', 'closed']

    def test_naive_index_rejected(self):
        idx = pd.DatetimeIndex(['2026-06-15 10:00'])
        df = pd.DataFrame(index=idx)
        with pytest.raises(ValueError):
            session_for_bars(df, US_EQUITIES)
