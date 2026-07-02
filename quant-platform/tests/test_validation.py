"""Tests for qp.validation — CSV export + comparison harness."""

import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from qp.validation import export_series, compare


def _bars(n=5):
    idx = pd.date_range('2025-01-06 09:30', periods=n, freq='1min',
                        tz='America/New_York')
    return pd.DataFrame({
        'open':  np.arange(100.0, 100.0 + n),
        'high':  np.arange(101.0, 101.0 + n),
        'low':   np.arange( 99.0,  99.0 + n),
        'close': np.arange(100.5, 100.5 + n),
        'volume': np.ones(n) * 1000,
    }, index=idx)


class TestExport:
    def test_export_writes_expected_columns(self):
        bars = _bars(3)
        ema = np.array([100.0, np.nan, 101.5])
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'out.csv'
            export_series(bars, {'ema': ema}, path)
            written = pd.read_csv(path)
            assert list(written.columns) == ['timestamp', 'close', 'ema']
            # NaN → empty cell → NaN after re-parse.
            assert pd.isna(written['ema'].iloc[1])

    def test_length_mismatch_raises(self):
        bars = _bars(3)
        with tempfile.TemporaryDirectory() as d:
            with pytest.raises(ValueError):
                export_series(bars, {'bad': np.array([1., 2.])},
                              Path(d) / 'out.csv')


class TestCompare:
    def test_identical_series_passes(self):
        x = np.array([1., 2., 3., 4., 5.])
        r = compare(x, x)
        assert r.passes
        assert r.max_abs_diff == 0.0
        assert r.mismatched_bars == []

    def test_small_diff_within_tol(self):
        a = np.array([1., 2., 3.])
        b = a + 1e-10
        r = compare(a, b, rtol=1e-6, atol=1e-8)
        assert r.passes

    def test_large_diff_fails(self):
        r = compare(np.array([1., 2., 3.]), np.array([1., 99., 3.]))
        assert not r.passes
        assert 1 in r.mismatched_bars

    def test_leading_nan_excused_when_flag_set(self):
        # Computed has leading NaN (indicator seeding); reference not.
        a = np.array([np.nan, 1., 2., 3.])
        b = np.array([np.nan, 1., 2., 3.])
        r = compare(a, b, ignore_leading_nan=True)
        assert r.passes

    def test_leading_one_nan_flagged_when_flag_set(self):
        # If one side has leading NaN but the other doesn't AT THE SAME
        # position, that's normal — most callers align. But if the flag
        # is off, we require exact matching including NaN placement.
        a = np.array([np.nan, 1., 2.])
        b = np.array([1., 1., 2.])
        r_strict = compare(a, b, ignore_leading_nan=False)
        assert not r_strict.passes
        r_loose = compare(a, b, ignore_leading_nan=True)
        assert r_loose.passes

    def test_shape_mismatch_raises(self):
        with pytest.raises(ValueError):
            compare(np.arange(3), np.arange(4))
