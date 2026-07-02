"""Tests for qp.price."""

import numpy as np
import pandas as pd
import pytest

from qp.price import hl2, hlc3, ohlc4, typical_price, median_price, weighted_close


@pytest.fixture
def bars():
    return pd.DataFrame({
        'open':   [10.0, 11.0, 12.0],
        'high':   [11.0, 12.0, 13.0],
        'low':    [ 9.0, 10.0, 11.0],
        'close':  [10.5, 11.5, 12.5],
        'volume': [1000, 2000, 3000],
    })


def test_hl2(bars):
    np.testing.assert_allclose(hl2(bars), [10.0, 11.0, 12.0])


def test_hlc3(bars):
    np.testing.assert_allclose(hlc3(bars), [(11+9+10.5)/3, (12+10+11.5)/3, (13+11+12.5)/3])


def test_ohlc4(bars):
    np.testing.assert_allclose(ohlc4(bars), [
        (10+11+9+10.5)/4, (11+12+10+11.5)/4, (12+13+11+12.5)/4,
    ])


def test_typical_price_is_hlc3(bars):
    np.testing.assert_allclose(typical_price(bars), hlc3(bars))


def test_median_price_is_hl2(bars):
    np.testing.assert_allclose(median_price(bars), hl2(bars))


def test_weighted_close(bars):
    np.testing.assert_allclose(weighted_close(bars), [
        (11+9+2*10.5)/4, (12+10+2*11.5)/4, (13+11+2*12.5)/4,
    ])


def test_missing_column_raises():
    df = pd.DataFrame({'open':[1], 'high':[2], 'low':[0.5]})  # close missing
    with pytest.raises(ValueError):
        hlc3(df)
