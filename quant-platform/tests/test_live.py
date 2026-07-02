"""Tests for qp.live — sizer + streaming engine."""

import numpy as np
import pandas as pd
import pytest

from qp.live import LiveEngine, OpenEvent, CloseEvent, fixed_risk_qty
from qp.setups import Setup, StopRule, TargetRule


def _bar_series(ts, open_, high, low, close, volume=1):
    s = pd.Series({'open': open_, 'high': high, 'low': low,
                   'close': close, 'volume': volume})
    s.name = ts
    return s


def _long_1pct_2r(name, fire_indices):
    def trigger(bars):
        mask = np.zeros(len(bars), dtype=bool)
        for i in fire_indices:
            if 0 <= i < len(bars):
                mask[i] = True
        return mask
    return Setup(name=name, side='long', trigger=trigger,
                 stop=StopRule(kind='percent', pct=0.01),
                 target=TargetRule(kind='r_multiple', r=2.0))


class TestFixedRiskSizer:
    def test_rounds_down_to_whole_shares(self):
        # Risk $100, distance $1.5 → raw 66.67 → 66 shares.
        assert fixed_risk_qty(100.0, entry_price=100.0, stop_price=98.5) == 66.0

    def test_zero_distance_returns_zero(self):
        assert fixed_risk_qty(100.0, 100.0, 100.0) == 0.0

    def test_below_min_qty_returns_zero(self):
        # Distance $10, budget $5 → 0.5 → 0 shares.
        assert fixed_risk_qty(5.0, 100.0, 90.0, min_qty=1.0) == 0.0

    def test_lot_size_rounding(self):
        # Distance $1, budget $105, lot_size 10 → floor(105/10)*10 = 100.
        assert fixed_risk_qty(105.0, 100.0, 99.0, lot_size=10.0) == 100.0

    def test_negative_risk_raises(self):
        with pytest.raises(ValueError):
            fixed_risk_qty(-1.0, 100.0, 99.0)


class TestLiveEngineOpen:
    def test_open_event_on_trigger(self):
        events = []
        setup = _long_1pct_2r('go', fire_indices=[0])
        engine = LiveEngine(setups=[setup], on_event=events.append,
                            risk_per_trade=100.0)
        engine.on_new_bar('SPY', _bar_series(
            pd.Timestamp('2025-01-06 09:30', tz='America/New_York'),
            open_=100, high=100.5, low=99.5, close=100.0))
        assert len(events) == 1
        e = events[0]
        assert isinstance(e, OpenEvent)
        assert e.side == 'long'
        assert e.entry_px == 100.0
        assert e.stop_px == 99.0
        # Target = entry + 2 * (entry - stop) = 100 + 2 = 102.
        assert e.target_px == 102.0
        # Qty = floor(100 / (100 - 99)) = 100.
        assert e.qty == 100.0

    def test_no_double_entry_on_same_setup(self):
        events = []
        setup = _long_1pct_2r('go', fire_indices=[0, 1])
        engine = LiveEngine(setups=[setup], on_event=events.append,
                            risk_per_trade=100.0)
        ts = pd.Timestamp('2025-01-06 09:30', tz='America/New_York')
        engine.on_new_bar('SPY', _bar_series(ts, 100, 100.5, 99.5, 100.0))
        engine.on_new_bar('SPY', _bar_series(ts + pd.Timedelta(minutes=1),
                                             100, 100.5, 99.5, 100.5))
        # Only one OpenEvent — the position is already open on bar 1.
        opens = [e for e in events if isinstance(e, OpenEvent)]
        assert len(opens) == 1


class TestLiveEngineClose:
    def test_target_hit_closes(self):
        events = []
        setup = _long_1pct_2r('go', fire_indices=[0])
        engine = LiveEngine(setups=[setup], on_event=events.append,
                            risk_per_trade=100.0)
        ts0 = pd.Timestamp('2025-01-06 09:30', tz='America/New_York')
        engine.on_new_bar('SPY', _bar_series(ts0, 100, 100.5, 99.5, 100.0))
        # Bar 1: high reaches 102 → target hit.
        engine.on_new_bar('SPY', _bar_series(ts0 + pd.Timedelta(minutes=1),
                                             100, 102.0, 100.0, 101.0))
        closes = [e for e in events if isinstance(e, CloseEvent)]
        assert len(closes) == 1
        c = closes[0]
        assert c.reason == 'target'
        assert c.exit_px == 102.0
        np.testing.assert_allclose(c.r_multiple, 2.0)

    def test_stop_hit_closes(self):
        events = []
        setup = _long_1pct_2r('go', fire_indices=[0])
        engine = LiveEngine(setups=[setup], on_event=events.append,
                            risk_per_trade=100.0)
        ts0 = pd.Timestamp('2025-01-06 09:30', tz='America/New_York')
        engine.on_new_bar('SPY', _bar_series(ts0, 100, 100.5, 99.5, 100.0))
        engine.on_new_bar('SPY', _bar_series(ts0 + pd.Timedelta(minutes=1),
                                             100, 100.5, 98.5, 99.0))
        closes = [e for e in events if isinstance(e, CloseEvent)]
        assert len(closes) == 1
        assert closes[0].reason == 'stop'
        np.testing.assert_allclose(closes[0].r_multiple, -1.0)

    def test_close_all_uses_manual_reason(self):
        events = []
        setup = _long_1pct_2r('go', fire_indices=[0])
        engine = LiveEngine(setups=[setup], on_event=events.append,
                            risk_per_trade=100.0)
        ts0 = pd.Timestamp('2025-01-06 09:30', tz='America/New_York')
        engine.on_new_bar('SPY', _bar_series(ts0, 100, 100.5, 99.5, 100.0))
        engine.close_all(reason='eod')
        closes = [e for e in events if isinstance(e, CloseEvent)]
        assert len(closes) == 1
        assert closes[0].reason == 'eod'
