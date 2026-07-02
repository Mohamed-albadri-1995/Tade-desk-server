"""Tests for qp.primitives — compare, cross, touch, reject."""

import numpy as np
import pandas as pd
import pytest

from qp.primitives import (
    above, below, above_equal, below_equal,
    crossover, crossunder, cross,
    touch, touch_pct,
    reject_high, reject_low,
)


class TestCompare:
    def test_above_strict(self):
        a = np.array([1., 2., 3.])
        b = np.array([1., 1., 4.])
        np.testing.assert_array_equal(above(a, b), [False, True, False])

    def test_above_equal(self):
        a = np.array([1., 2., 3.])
        b = np.array([1., 1., 4.])
        np.testing.assert_array_equal(above_equal(a, b), [True, True, False])

    def test_below(self):
        np.testing.assert_array_equal(
            below(np.array([1., 2., 3.]), np.array([2., 2., 2.])),
            [True, False, False])

    def test_below_equal(self):
        np.testing.assert_array_equal(
            below_equal(np.array([1., 2., 3.]), np.array([2., 2., 2.])),
            [True, True, False])

    def test_nan_returns_false(self):
        a = np.array([np.nan, 2., np.nan])
        b = np.array([1., np.nan, 3.])
        np.testing.assert_array_equal(above(a, b), [False, False, False])

    def test_shape_mismatch_raises(self):
        with pytest.raises(ValueError):
            above(np.arange(3), np.arange(4))


class TestCross:
    def test_crossover_fires_on_transition(self):
        a = np.array([1., 1., 2., 3., 2.])
        b = np.array([2., 1., 1., 1., 3.])
        # i=0: no prev, False.
        # i=1: a<=b prev? a[0]=1, b[0]=2, prev a<=b. curr a=1, b=1, a>b False → no.
        # i=2: prev a=1, b=1, a<=b True. curr a=2, b=1, a>b True → FIRE.
        # i=3: prev a=2, b=1, a<=b False. → no.
        # i=4: prev a=3, b=1, a<=b False → no.
        np.testing.assert_array_equal(crossover(a, b),
                                      [False, False, True, False, False])

    def test_crossunder(self):
        a = np.array([3., 2., 1., 0.])
        b = np.array([1., 1., 1., 1.])
        # i=2: prev a=2>=b=1, curr a=1<b=1 False (strict) → no. Wait,
        # a[2]=1, b[2]=1, a<b False → no. Let's tune.
        # Use a = [3, 3, 0, 0].
        a = np.array([3., 3., 0., 0.])
        b = np.array([1., 1., 1., 1.])
        # i=2: prev a=3>=b=1 True. curr a=0<b=1 True → FIRE.
        np.testing.assert_array_equal(crossunder(a, b),
                                      [False, False, True, False])

    def test_cross_either_direction(self):
        a = np.array([1., 2., 3., 2., 1.])
        b = np.array([2., 2., 2., 2., 2.])
        # i=2: crossover; i=4: crossunder.
        np.testing.assert_array_equal(cross(a, b),
                                      [False, False, True, False, True])

    def test_first_bar_never_fires(self):
        r = crossover(np.array([1., 2.]), np.array([0., 3.]))
        assert r[0] == False


class TestTouch:
    def _bars(self, high, low, close):
        return pd.DataFrame({
            'open': close, 'high': high, 'low': low,
            'close': close, 'volume': [1] * len(high),
        })

    def test_touch_when_level_between_low_and_high(self):
        bars = self._bars(high=[12, 15, 20], low=[9, 10, 18], close=[10, 12, 19])
        level = np.array([10., 20., 20.])
        # Bar 0: [9, 12] contains 10 → True.
        # Bar 1: [10, 15] doesn't contain 20 → False.
        # Bar 2: [18, 20] contains 20 → True (inclusive).
        np.testing.assert_array_equal(touch(bars, level), [True, False, True])

    def test_touch_tol_extends_range(self):
        bars = self._bars(high=[10], low=[9], close=[9.5])
        level = np.array([10.5])
        assert touch(bars, level, tol=0.5)[0] == True
        assert touch(bars, level, tol=0.4)[0] == False

    def test_touch_pct(self):
        bars = self._bars(high=[100], low=[95], close=[97])
        level = np.array([101.0])
        # tol_pct = 0.01 → tol = 1.01 → range [93.99, 101.01] contains 101 → True.
        assert touch_pct(bars, level, tol_pct=0.01)[0] == True
        assert touch_pct(bars, level, tol_pct=0.001)[0] == False

    def test_nan_level_never_touches(self):
        bars = self._bars(high=[100], low=[95], close=[97])
        level = np.array([np.nan])
        assert touch(bars, level)[0] == False

    def test_negative_tol_raises(self):
        bars = self._bars(high=[1], low=[1], close=[1])
        with pytest.raises(ValueError):
            touch(bars, np.array([1.0]), tol=-0.1)


class TestReject:
    def _bars(self, high, low, close):
        return pd.DataFrame({
            'open': close, 'high': high, 'low': low,
            'close': close, 'volume': [1] * len(high),
        })

    def test_reject_high_touched_and_closed_below(self):
        # Touched 100 (high >= 100), closed 95 (< 100).
        bars = self._bars(high=[101], low=[93], close=[95])
        level = np.array([100.0])
        assert reject_high(bars, level)[0] == True

    def test_reject_high_no_touch(self):
        bars = self._bars(high=[95], low=[90], close=[92])
        level = np.array([100.0])
        assert reject_high(bars, level)[0] == False

    def test_reject_high_close_above_is_not_rejection(self):
        # Touched 100 but closed above → breakout, not rejection.
        bars = self._bars(high=[105], low=[99], close=[104])
        level = np.array([100.0])
        assert reject_high(bars, level)[0] == False

    def test_reject_low_touched_and_closed_above(self):
        # Touched 50 (low <= 50), closed 55 (> 50).
        bars = self._bars(high=[57], low=[48], close=[55])
        level = np.array([50.0])
        assert reject_low(bars, level)[0] == True

    def test_reject_low_close_below_is_not_rejection(self):
        # Broke through the level.
        bars = self._bars(high=[52], low=[45], close=[46])
        level = np.array([50.0])
        assert reject_low(bars, level)[0] == False
