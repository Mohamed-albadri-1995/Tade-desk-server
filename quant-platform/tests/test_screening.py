"""Tests for qp.screening — scan and scan_latest across a universe."""

import numpy as np
import pandas as pd
import pytest

from qp.screening import scan, scan_latest
from qp.setups import Setup, StopRule, TargetRule
from qp.primitives import above


def _bars(closes, index=None):
    n = len(closes)
    idx = index if index is not None else pd.RangeIndex(n)
    return pd.DataFrame({
        'open':   closes, 'high': closes, 'low': closes,
        'close':  closes, 'volume': np.ones(n),
    }, index=idx)


def _make_setup(name, threshold):
    def trigger(bars):
        return above(bars['close'].to_numpy(dtype=float),
                     np.full(len(bars), threshold))
    return Setup(
        name=name, side='long', trigger=trigger,
        stop=StopRule(kind='percent', pct=0.01),
        target=TargetRule(kind='percent', pct=0.03),
    )


class TestScan:
    def test_empty_universe_returns_empty(self):
        r = scan([_make_setup('s', 100)], {})
        assert r.matches.empty

    def test_no_setups_returns_empty(self):
        r = scan([], {'AAPL': _bars([100, 101])})
        assert r.matches.empty

    def test_two_symbols_two_setups(self):
        u = {
            'AAPL': _bars([100., 105., 110.]),
            'MSFT': _bars([50.,  55.,  60.]),
        }
        s1 = _make_setup('over100', 100)
        s2 = _make_setup('over55',  55)
        r = scan([s1, s2], u)
        df = r.matches
        # AAPL bars 1, 2 fire over100 (105, 110 > 100). None fire over55.
        # Wait — AAPL is 100, 105, 110. above 55 too. Fires all bars for s2.
        # AAPL x over100: bars 1, 2 (2 rows).
        # AAPL x over55: bars 0, 1, 2 (3 rows).
        # MSFT x over100: no bars.
        # MSFT x over55: bar 2 only (60 > 55; 55 == 55 not >).
        assert len(df[(df['symbol'] == 'AAPL') & (df['setup'] == 'over100')]) == 2
        assert len(df[(df['symbol'] == 'AAPL') & (df['setup'] == 'over55')])  == 3
        assert len(df[(df['symbol'] == 'MSFT') & (df['setup'] == 'over100')]) == 0
        assert len(df[(df['symbol'] == 'MSFT') & (df['setup'] == 'over55')])  == 1

    def test_match_row_contains_entry_stop_target(self):
        u = {'AAPL': _bars([100.])}
        s = _make_setup('always', 50)  # 100 > 50 → fires bar 0.
        df = scan([s], u).matches
        row = df.iloc[0]
        assert row['entry_px']  == 100.0
        assert row['stop_px']   == 99.0     # 1% below
        assert row['target_px'] == 103.0    # 3% above
        assert row['side'] == 'long'


class TestScanLatest:
    def test_returns_only_last_bar_matches(self):
        u = {'AAPL': _bars([100., 101., 105.])}
        s = _make_setup('over104', 104)  # only bar 2 fires (105 > 104).
        df = scan_latest([s], u)
        assert len(df) == 1
        assert df.iloc[0]['bar_index'] == 2

    def test_ignores_historic_matches(self):
        # Bar 0 fires, bar 1 doesn't.
        u = {'AAPL': _bars([200., 50.])}
        s = _make_setup('over100', 100)
        df = scan_latest([s], u)
        assert df.empty
