"""Tests for qp.chart — builder + serialisation."""

import json
import math

import numpy as np
import pandas as pd
import pytest

from qp.chart import ChartBuilder, to_dict


def _bars(n=5):
    idx = pd.date_range('2025-01-06 09:30', periods=n, freq='1min',
                        tz='America/New_York')
    return pd.DataFrame({
        'open': np.arange(100.0, 100.0 + n),
        'high': np.arange(101.0, 101.0 + n),
        'low':  np.arange( 99.0,  99.0 + n),
        'close':np.arange(100.5, 100.5 + n),
        'volume': np.ones(n) * 1000,
    }, index=idx)


class TestBuilder:
    def test_build_produces_frame_with_series_and_markers(self):
        bars = _bars(3)
        ema = np.array([100.0, 101.0, 102.0])
        frame = (ChartBuilder(bars, title='test')
                 .add_series('EMA', ema, pane='price', color='blue')
                 .add_marker('entry', bar_index=1, price=101.0, kind='buy')
                 .build())
        assert frame.title == 'test'
        assert len(frame.series) == 1
        assert frame.series[0].name == 'EMA'
        assert len(frame.markers) == 1
        assert frame.markers[0].kind == 'buy'

    def test_add_series_length_mismatch_raises(self):
        bars = _bars(3)
        with pytest.raises(ValueError):
            ChartBuilder(bars).add_series('bad', np.arange(2, dtype=float))

    def test_add_marker_out_of_range_raises(self):
        bars = _bars(3)
        with pytest.raises(ValueError):
            ChartBuilder(bars).add_marker('x', bar_index=5, price=100.0)


class TestSerialise:
    def test_bars_serialise_to_iso_timestamps(self):
        bars = _bars(2)
        frame = ChartBuilder(bars).build()
        d = to_dict(frame)
        assert d['bars'][0]['ts'].startswith('2025-01-06T09:30')

    def test_nan_becomes_none(self):
        bars = _bars(3)
        ema = np.array([np.nan, 101.0, np.nan])
        frame = ChartBuilder(bars).add_series('EMA', ema).build()
        d = to_dict(frame)
        assert d['series'][0]['values'] == [None, 101.0, None]

    def test_output_is_json_serialisable(self):
        bars = _bars(2)
        frame = (ChartBuilder(bars, title='j')
                 .add_series('X', np.array([1.0, 2.0]))
                 .add_marker('m', bar_index=0, price=100.0, kind='buy')
                 .build())
        d = to_dict(frame)
        # Must roundtrip via json without errors.
        s = json.dumps(d)
        parsed = json.loads(s)
        assert parsed['title'] == 'j'
        assert parsed['markers'][0]['bar_index'] == 0

    def test_non_datetime_index_raises(self):
        bars = pd.DataFrame({
            'open': [1.], 'high': [1.], 'low': [1.],
            'close': [1.], 'volume': [1.],
        })
        frame = ChartBuilder(bars).build()
        with pytest.raises(TypeError):
            to_dict(frame)
