"""Tests for qp.structure — pivots, HH/HL/LH/LL, trend state."""

import numpy as np
import pandas as pd
import pytest

from qp.structure import pivot_highs, pivot_lows, label_pivots, trend_state


def _bars(high, low, close=None, open_=None, volume=None):
    n = len(high)
    if close is None:
        close = high
    if open_ is None:
        open_ = close
    if volume is None:
        volume = np.ones(n)
    return pd.DataFrame({'open': open_, 'high': high, 'low': low,
                         'close': close, 'volume': volume})


class TestPivotHighs:
    def test_single_peak_with_symmetric_flanks(self):
        # left=2, right=2. Peak at index 2, value 5.
        h = [1, 3, 5, 3, 1]
        bars = _bars(high=h, low=h)
        ph = pivot_highs(bars, left=2, right=2)
        assert ph[2] == 5.0
        assert np.isnan([ph[i] for i in (0, 1, 3, 4)]).all()

    def test_no_pivot_on_flat_top(self):
        # Peak is tied — not strictly greater on the right.
        h = [1, 3, 5, 5, 3, 1]
        bars = _bars(high=h, low=h)
        ph = pivot_highs(bars, left=2, right=2)
        assert np.isnan(ph).all()

    def test_boundary_bars_never_pivot(self):
        h = [10, 1, 1, 1, 10]
        bars = _bars(high=h, low=h)
        ph = pivot_highs(bars, left=2, right=2)
        # Neither boundary can be a pivot — no room for `left` or `right`.
        assert np.isnan(ph[0]) and np.isnan(ph[-1])

    def test_invalid_params(self):
        bars = _bars(high=[1, 2, 3], low=[1, 2, 3])
        with pytest.raises(ValueError):
            pivot_highs(bars, left=0, right=1)


class TestPivotLows:
    def test_single_valley(self):
        l = [5, 3, 1, 3, 5]
        bars = _bars(high=l, low=l)
        pl = pivot_lows(bars, left=2, right=2)
        assert pl[2] == 1.0

    def test_no_flat_bottom_pivot(self):
        l = [5, 3, 1, 1, 3, 5]
        bars = _bars(high=l, low=l)
        pl = pivot_lows(bars, left=2, right=2)
        assert np.isnan(pl).all()


class TestLabelPivots:
    def test_hh_hl_uptrend_sequence(self):
        # Alternating highs and lows going up.
        # Highs at bars 2 and 6, values 5, 8. Lows at bars 4 and 8, values 2, 3.
        ph = np.array([np.nan, np.nan, 5,  np.nan, np.nan, np.nan, 8,  np.nan, np.nan])
        pl = np.array([np.nan, np.nan, np.nan, np.nan, 2, np.nan, np.nan, np.nan, 3])
        labels = label_pivots(ph, pl)
        assert list(labels['label']) == ['first_high', 'first_low', 'HH', 'HL']

    def test_ll_lh_downtrend_sequence(self):
        ph = np.array([np.nan, 8, np.nan, np.nan, np.nan, 6, np.nan, np.nan])
        pl = np.array([np.nan, np.nan, np.nan, 4, np.nan, np.nan, np.nan, 2])
        labels = label_pivots(ph, pl)
        assert list(labels['label']) == ['first_high', 'first_low', 'LH', 'LL']

    def test_shape_mismatch_raises(self):
        with pytest.raises(ValueError):
            label_pivots(np.array([1., 2.]), np.array([1.]))


class TestTrendState:
    def test_uptrend_after_hh_hl(self):
        # Fabricate a synthetic pivot dataframe.
        labels = pd.DataFrame({
            'bar_index': [1, 3, 5, 7],
            'price': [10, 8, 12, 9],
            'kind': ['high', 'low', 'high', 'low'],
            'label': ['first_high', 'first_low', 'HH', 'HL'],
        })
        state = trend_state(labels, n_bars=10)
        # After the HL at bar 7, everything from 8 onwards is 'up'.
        assert state[8] == 'up'
        assert state[9] == 'up'

    def test_downtrend_after_ll_lh(self):
        labels = pd.DataFrame({
            'bar_index': [1, 3, 5, 7],
            'price': [10, 8, 6, 9],
            'kind': ['high', 'low', 'low', 'high'],
            'label': ['first_high', 'first_low', 'LL', 'LH'],
        })
        state = trend_state(labels, n_bars=10)
        assert state[8] == 'down'

    def test_unknown_before_any_pivot(self):
        labels = pd.DataFrame(columns=['bar_index', 'price', 'kind', 'label'])
        state = trend_state(labels, n_bars=5)
        assert (state == 'unknown').all()

    def test_mixed_pair_yields_range(self):
        labels = pd.DataFrame({
            'bar_index': [1, 3, 5],
            'price': [10, 8, 12],
            'kind': ['high', 'low', 'high'],
            'label': ['first_high', 'first_low', 'HH'],
        })
        state = trend_state(labels, n_bars=8)
        # HH after first_low → range (needs an HL to confirm 'up').
        assert state[6] == 'range'
