"""Tests for qp.stats — trade persistence + roll-ups."""

import numpy as np
import pandas as pd
import pytest

from qp.stats import StatsStore
from qp.live.events import CloseEvent


def _evt(setup='S1', symbol='SPY', r=1.0, side='long', reason='target'):
    return CloseEvent(
        setup=setup, symbol=symbol, side=side,
        entry_bar=0, exit_bar=1, timestamp='2025-01-06T09:30:00-05:00',
        entry_px=100.0, exit_px=100.0 + r, stop_px=99.0, target_px=102.0,
        qty=10.0, reason=reason, r_multiple=r,
    )


class TestStatsStore:
    def test_record_and_retrieve_single_trade(self):
        s = StatsStore(':memory:')
        s.record(_evt(r=2.0))
        df = s.trades()
        assert len(df) == 1
        assert df.iloc[0]['r_multiple'] == 2.0
        assert df.iloc[0]['setup'] == 'S1'
        s.close()

    def test_summary_empty_store(self):
        s = StatsStore(':memory:')
        assert s.summary()['n_trades'] == 0
        s.close()

    def test_summary_wins_and_losses(self):
        s = StatsStore(':memory:')
        for r in (2.0, -1.0, 2.0, -1.0, 0.0):
            s.record(_evt(r=r))
        sm = s.summary()
        assert sm['n_trades']  == 5
        assert sm['n_wins']    == 2
        assert sm['n_losses']  == 2
        assert sm['win_rate']  == 0.4
        np.testing.assert_allclose(sm['total_r'], 2.0)
        # Expectancy = 0.4 * 2 + 0.4 * (-1) = 0.4
        np.testing.assert_allclose(sm['expectancy_r'], 0.4)
        s.close()

    def test_filter_by_setup(self):
        s = StatsStore(':memory:')
        s.record(_evt(setup='A', r=1.0))
        s.record(_evt(setup='B', r=-1.0))
        s.record(_evt(setup='A', r=2.0))
        sm_a = s.summary(setup='A')
        assert sm_a['n_trades'] == 2
        np.testing.assert_allclose(sm_a['total_r'], 3.0)
        sm_b = s.summary(setup='B')
        assert sm_b['n_trades'] == 1
        s.close()

    def test_filter_by_symbol(self):
        s = StatsStore(':memory:')
        s.record(_evt(symbol='SPY', r=1.0))
        s.record(_evt(symbol='QQQ', r=-1.0))
        assert s.summary(symbol='SPY')['n_trades'] == 1
        assert s.summary(symbol='QQQ')['n_trades'] == 1
        s.close()

    def test_rolling_expectancy(self):
        s = StatsStore(':memory:')
        for r in (2.0, -1.0, 2.0, -1.0):
            s.record(_evt(r=r))
        roll = s.rolling_expectancy(window=2)
        # Ordered by id ascending: [2, -1, 2, -1].
        # Rolling mean w=2: [nan, 0.5, 0.5, 0.5].
        assert pd.isna(roll.iloc[0])
        np.testing.assert_allclose(roll.iloc[1], 0.5)
        np.testing.assert_allclose(roll.iloc[2], 0.5)
        np.testing.assert_allclose(roll.iloc[3], 0.5)
        s.close()

    def test_record_bulk(self):
        s = StatsStore(':memory:')
        s.record_bulk([_evt(r=1.0), _evt(r=-1.0), _evt(r=2.0)])
        assert s.summary()['n_trades'] == 3
        s.close()

    def test_persistence_across_reopen(self, tmp_path):
        db = tmp_path / 'stats.sqlite'
        s = StatsStore(db)
        s.record(_evt(r=1.5))
        s.close()

        s2 = StatsStore(db)
        assert s2.summary()['n_trades'] == 1
        np.testing.assert_allclose(s2.summary()['total_r'], 1.5)
        s2.close()
