"""Tests for qp.setups — spec, evaluator, stop / target rules."""

import numpy as np
import pandas as pd
import pytest

from qp.setups import Setup, StopRule, TargetRule, evaluate
from qp.primitives import above


def _bars(high, low, close, open_=None, volume=None):
    n = len(close)
    if open_ is None:
        open_ = close
    if volume is None:
        volume = np.ones(n)
    return pd.DataFrame({'open': open_, 'high': high, 'low': low,
                         'close': close, 'volume': volume})


def _always_trigger(bars):
    return np.ones(len(bars), dtype=bool)


def _never_trigger(bars):
    return np.zeros(len(bars), dtype=bool)


class TestEvaluatorEntries:
    def test_never_triggering_setup_has_no_entries(self):
        bars = _bars(high=[10, 11, 12], low=[9, 10, 11], close=[10, 11, 12])
        setup = Setup(
            name='never',
            side='long',
            trigger=_never_trigger,
            stop=StopRule(kind='percent', pct=0.01),
            target=TargetRule(kind='percent', pct=0.02),
        )
        r = evaluate(setup, bars)
        assert not r.entries.any()
        assert np.isnan(r.entry_px).all()
        assert np.isnan(r.stop_px).all()
        assert np.isnan(r.target_px).all()

    def test_trigger_returns_wrong_shape_raises(self):
        bars = _bars(high=[10, 11], low=[9, 10], close=[10, 11])
        bad_trigger = lambda bars: np.array([True])  # wrong length
        setup = Setup(name='bad', side='long', trigger=bad_trigger,
                      stop=StopRule(kind='percent'), target=TargetRule(kind='percent'))
        with pytest.raises(ValueError):
            evaluate(setup, bars)


class TestPercentStopTarget:
    def test_long_stop_below_target_above(self):
        bars = _bars(high=[100], low=[99], close=[100])
        setup = Setup(
            name='p',
            side='long',
            trigger=_always_trigger,
            stop=StopRule(kind='percent', pct=0.02),
            target=TargetRule(kind='percent', pct=0.05),
        )
        r = evaluate(setup, bars)
        assert r.entries[0] == True
        assert r.entry_px[0] == 100
        assert r.stop_px[0]   == 100 * (1 - 0.02)
        assert r.target_px[0] == 100 * (1 + 0.05)

    def test_short_stop_above_target_below(self):
        bars = _bars(high=[100], low=[99], close=[100])
        setup = Setup(
            name='p',
            side='short',
            trigger=_always_trigger,
            stop=StopRule(kind='percent', pct=0.02),
            target=TargetRule(kind='percent', pct=0.05),
        )
        r = evaluate(setup, bars)
        assert r.stop_px[0]   == 100 * (1 + 0.02)
        assert r.target_px[0] == 100 * (1 - 0.05)


class TestRMultipleTarget:
    def test_2r_target_is_twice_stop_distance_above_entry(self):
        bars = _bars(high=[100], low=[99], close=[100])
        setup = Setup(
            name='r',
            side='long',
            trigger=_always_trigger,
            stop=StopRule(kind='percent', pct=0.01),   # stop @ 99
            target=TargetRule(kind='r_multiple', r=2.0),
        )
        r = evaluate(setup, bars)
        # R = |100 - 99| = 1. target = 100 + 2*1 = 102.
        assert r.stop_px[0]   == 99.0
        assert r.target_px[0] == 102.0


class TestAtrRule:
    def test_atr_stop_uses_true_range(self):
        # Two bars: enough for ATR(2) with RMA to seed on bar 1.
        bars = _bars(
            high=[10, 12, 11, 13],
            low=[9, 10, 10, 11],
            close=[10, 11, 10, 13],
        )
        # ATR(2) seeded at index 1 with RMA — value depends on TR series.
        # We don't care about the exact number; we care that the STOP is
        # distinct from entry and on the correct side.
        setup = Setup(
            name='a',
            side='long',
            trigger=_always_trigger,
            stop=StopRule(kind='atr', mult=1.0, atr_length=2),
            target=TargetRule(kind='atr', mult=2.0, atr_length=2),
        )
        r = evaluate(setup, bars)
        # On any bar that fires with a valid ATR, stop < entry and target > entry.
        for i in range(len(bars)):
            if r.entries[i] and not np.isnan(r.stop_px[i]):
                assert r.stop_px[i] < r.entry_px[i]
                assert r.target_px[i] > r.entry_px[i]


class TestLevelRule:
    def test_stop_at_named_level(self):
        bars = _bars(high=[100], low=[99], close=[100])
        level = np.array([95.0])
        setup = Setup(
            name='lvl',
            side='long',
            trigger=_always_trigger,
            stop=StopRule(kind='level', level_name='prev_day_low'),
            target=TargetRule(kind='percent', pct=0.03),
        )
        r = evaluate(setup, bars, context={'prev_day_low': level})
        assert r.stop_px[0] == 95.0
        # Target = 100 * 1.03 = 103.
        np.testing.assert_allclose(r.target_px[0], 103.0)

    def test_missing_context_raises(self):
        bars = _bars(high=[100], low=[99], close=[100])
        setup = Setup(
            name='lvl',
            side='long',
            trigger=_always_trigger,
            stop=StopRule(kind='level', level_name='prev_day_low'),
            target=TargetRule(kind='percent', pct=0.03),
        )
        with pytest.raises(KeyError):
            evaluate(setup, bars, context={})


class TestComposedTrigger:
    def test_close_above_ma_trigger(self):
        # 5 bars, close crosses a synthetic MA at bar 2.
        bars = _bars(
            high=[10, 11, 12, 13, 14],
            low=[9, 10, 11, 12, 13],
            close=[10, 10, 12, 12, 14],
        )
        ma = np.array([11., 11., 11., 11., 11.])
        def trigger(bars):
            return above(bars['close'].to_numpy(dtype=float), ma)
        setup = Setup(
            name='cross',
            side='long',
            trigger=trigger,
            stop=StopRule(kind='percent', pct=0.01),
            target=TargetRule(kind='r_multiple', r=2.0),
        )
        r = evaluate(setup, bars)
        # Bars 2, 3, 4 have close > 11.
        expected = np.array([False, False, True, True, True])
        np.testing.assert_array_equal(r.entries, expected)
