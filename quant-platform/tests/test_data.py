"""Tests for the data layer.

The loader is exercised against a synthetic Source so tests don't need
network access. The Yahoo adapter's live integration is validated
separately (see scripts/validate_ema.py) and won't run in CI.
"""

from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from qp.data import load, list_cached, clear_cache
from qp.data.sources.base import Bars, Source


class FakeSource(Source):
    """Deterministic in-memory source. Returns the same synthetic bars
    every time so cache-hit / cache-miss behaviour is testable."""
    name = 'fake'

    def fetch(self, symbol, timeframe, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')
        n = len(idx)
        df = pd.DataFrame({
            'open':   np.arange(n, dtype=float),
            'high':   np.arange(n, dtype=float) + 0.5,
            'low':    np.arange(n, dtype=float) - 0.5,
            'close':  np.arange(n, dtype=float) + 0.1,
            'volume': np.full(n, 1000.0),
        }, index=idx)
        return Bars(df=df, symbol=symbol, timeframe=timeframe,
                    adjusted=True, source=self.name)


@pytest.fixture
def cache_dir(tmp_path: Path) -> Path:
    return tmp_path / 'qp-cache'


def _range():
    start = pd.Timestamp('2026-06-15 14:00', tz='UTC')
    end   = pd.Timestamp('2026-06-15 15:00', tz='UTC')
    return start, end


class TestLoader:
    def test_returns_normalised_bars(self, cache_dir):
        src = FakeSource()
        start, end = _range()
        bars = load('SPY', '1m', start, end, source=src, cache_dir=cache_dir)
        assert bars.symbol == 'SPY'
        assert bars.timeframe == '1m'
        assert bars.source == 'fake'
        assert bars.df.index.tz is not None
        assert not bars.df.empty

    def test_cache_hit_returns_from_disk(self, cache_dir):
        src = FakeSource()
        start, end = _range()
        first  = load('SPY', '1m', start, end, source=src, cache_dir=cache_dir)
        # If we replace source with one that would fail, the second call
        # must still succeed because it's a cache hit.
        class Broken(Source):
            name = 'fake'
            def fetch(self, *a, **k):
                raise RuntimeError('should not have been called')
        second = load('SPY', '1m', start, end, source=Broken(), cache_dir=cache_dir)
        # Parquet roundtrip drops the index freq metadata but keeps every
        # value. Compare the data, not the freq attribute.
        pd.testing.assert_frame_equal(first.df, second.df, check_freq=False)

    def test_session_filter_regular(self, cache_dir):
        # Two hours around the US regular open: 13:00 UTC = 09:00 ET
        # (premarket), 14:00 UTC = 10:00 ET (regular). Filter should
        # drop everything before 14:30 UTC (09:30 ET).
        start = pd.Timestamp('2026-06-15 13:00', tz='UTC')
        end   = pd.Timestamp('2026-06-15 15:00', tz='UTC')
        bars = load('SPY', '1m', start, end,
                    source=FakeSource(), cache_dir=cache_dir,
                    session='regular')
        # Convert index to ET, min should be >= 09:30.
        et_index = bars.df.index.tz_convert('America/New_York')
        assert et_index.min().hour * 60 + et_index.min().minute >= 9 * 60 + 30

    def test_list_cached(self, cache_dir):
        load('SPY', '1m', *_range(), source=FakeSource(), cache_dir=cache_dir)
        entries = list_cached(cache_dir)
        assert len(entries) == 1
        assert entries[0]['symbol'] == 'SPY'
        assert entries[0]['timeframe'] == '1m'

    def test_clear_cache(self, cache_dir):
        load('SPY', '1m', *_range(), source=FakeSource(), cache_dir=cache_dir)
        assert list_cached(cache_dir)
        n = clear_cache(cache_dir)
        assert n >= 1
        assert list_cached(cache_dir) == []


class TestBarsValidation:
    def test_rejects_missing_columns(self):
        df = pd.DataFrame({'open':[1.]}, index=pd.DatetimeIndex(['2026-01-01'], tz='UTC'))
        with pytest.raises(ValueError):
            Bars(df=df, symbol='X', timeframe='1d')

    def test_rejects_naive_index(self):
        idx = pd.DatetimeIndex(['2026-01-01'])
        df = pd.DataFrame({'open':[1.], 'high':[1.], 'low':[1.],
                           'close':[1.], 'volume':[1.]}, index=idx)
        with pytest.raises(ValueError):
            Bars(df=df, symbol='X', timeframe='1d')

    def test_rejects_non_monotonic(self):
        idx = pd.DatetimeIndex(['2026-01-02', '2026-01-01'], tz='UTC')
        df = pd.DataFrame({'open':[1.,1.], 'high':[1.,1.], 'low':[1.,1.],
                           'close':[1.,1.], 'volume':[1.,1.]}, index=idx)
        with pytest.raises(ValueError):
            Bars(df=df, symbol='X', timeframe='1d')
