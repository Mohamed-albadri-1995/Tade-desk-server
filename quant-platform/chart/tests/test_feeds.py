"""Every data feed is registered in BOTH places that resolve one.

There are two loader registries and they are consulted by different callers:

    chart/data_manager.LOADERS      the chart's own fetches
    tools/compare_server._LOADERS   prepare_bars(), which is what
                                    strategy.evaluate() — and therefore every
                                    backtest and every live setup decision —
                                    goes through

A feed registered in one and not the other works everywhere you happen to test
it and fails in the half you forgot, with "unknown feed 'x' (have: [...])" from
somewhere far from the registration. That is exactly how the yahoo loader
shipped the first time: added to data_manager, missing from compare_server, and
found only when a live setup decision returned four identical errors.

    python3 -m pytest chart/tests/test_feeds.py -q     (from quant-platform/)
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pandas as pd                                        # noqa: E402
import pytest                                              # noqa: E402

from chart.data_manager import LOADERS                     # noqa: E402
from tools.compare_server import _LOADERS                  # noqa: E402


def test_both_registries_list_the_same_feeds():
    assert sorted(LOADERS) == sorted(_LOADERS), (
        'a feed registered in one registry and not the other fails only in the '
        'half that was forgotten')


def test_the_same_module_backs_each_name():
    for name in LOADERS:
        assert LOADERS[name] is _LOADERS[name], (
            f'{name} resolves to a different module depending on the caller')


@pytest.mark.parametrize('name', sorted(LOADERS))
def test_every_loader_honours_the_contract(name):
    """load(symbol, timeframe, start, end) is the whole interface.

    Checked by signature rather than by calling it: a network fetch in a unit
    test is a test that fails on a Sunday for reasons unrelated to the code.
    """
    import inspect
    fn = getattr(LOADERS[name], 'load', None)
    assert callable(fn), f'{name} has no load()'
    params = list(inspect.signature(fn).parameters)
    assert params[:4] == ['symbol', 'timeframe', 'start', 'end'], (
        f'{name}.load has {params[:4]}, which prepare_bars cannot call')


def test_yahoo_is_available_without_a_key():
    """The reason it exists: the live decision cannot depend on a key or a plan.

    polygon is a day behind on the free plan and alpaca's free tier is IEX, so
    yahoo is what serves a decision taken during the session. If it ever grows
    a credential requirement, the 10:00 setup silently loses its feed.
    """
    from chart.data_manager import feed_ok
    assert feed_ok('yahoo') is True


def test_yahoo_returns_the_expected_frame_shape_when_empty():
    """An empty result is a DataFrame with the right columns, not a bare one.

    prepare_bars indexes the columns straight away, so a loader that returns an
    empty frame without them raises a KeyError far from the cause — on a
    weekend, or on a symbol that did not trade.
    """
    from tools.data import yahoo
    df = pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])
    df.index = pd.DatetimeIndex([], tz='UTC', name='t')
    assert list(df.columns) == ['open', 'high', 'low', 'close', 'volume']
    assert hasattr(yahoo, 'load')


# ── the range Yahoo is asked for ─────────────────────────────────────────────
# `interval=1m&range=3mo` is not "more history than it has" — it is a 422 and
# no data at all. qp applies a 40-day floor to any strategy referencing session
# VWAP or window levels, so EVERY 1-minute request became 3mo and every one of
# them failed, with the cause forty lines away from the error.

@pytest.mark.parametrize('span_days', [1, 2, 5, 40, 400])
def test_one_minute_never_asks_beyond_what_yahoo_serves(span_days):
    from tools.data.yahoo import _range_for
    end = pd.Timestamp('2026-08-06T20:00:00Z')
    got = _range_for('1m', end - pd.Timedelta(days=span_days), end)
    assert got in ('1d', '5d'), (
        f'1m asked for range={got}; Yahoo answers 422 for anything longer, so a '
        'wide history request must be capped rather than passed through')


# Measured 2026-08-09 by chart/tests/tools_yahoo_limits.py, not read from
# documentation. 5m and 15m answer 422 at 3mo — the guessed table had them
# reaching it, so every request beyond a month returned nothing.
@pytest.mark.parametrize('tf,allowed', [
    ('5m', {'1d', '5d', '1mo'}),
    ('15m', {'1d', '5d', '1mo'}),
    ('1h', {'5d', '1mo', '3mo', '1y'}),
    ('1d', {'5d', '1mo', '3mo', '1y'}),
])
def test_every_interval_stays_inside_its_own_ceiling(tf, allowed):
    from tools.data.yahoo import _range_for
    end = pd.Timestamp('2026-08-06T20:00:00Z')
    for span in (1, 5, 40, 400, 4000):
        got = _range_for(tf, end - pd.Timedelta(days=span), end)
        assert got in allowed, f'{tf} asked for range={got} at span {span}d'


def test_a_wider_request_never_returns_a_narrower_range():
    """Monotonic, so asking for more history can never quietly fetch less."""
    from tools.data.yahoo import _range_for
    order = ['1d', '5d', '1mo', '3mo', '1y']
    end = pd.Timestamp('2026-08-06T20:00:00Z')
    for tf in ('1m', '5m', '1h', '1d'):
        seen = [order.index(_range_for(tf, end - pd.Timedelta(days=d), end))
                for d in (1, 5, 30, 90, 400, 4000)]
        assert seen == sorted(seen), f'{tf} range is not monotonic: {seen}'


# ── the decision has a deadline ──────────────────────────────────────────────
# The setup fires at 10:00 and the trade is entered at market on sight, so the
# whole card list has to be evaluated inside the minute it is worth acting in.
# Sequentially that is one network fetch per symbol; the parallel version is
# what makes the deadline reachable. What must NOT change is which two names
# come out — concurrency may reorder completion, never the ranking.

def test_parallel_evaluation_cannot_change_the_picks(monkeypatch):
    import random
    import time as _t
    from chart import decide as dec

    prices = {'AAA': (10.0, 9.0), 'BBB': (10.0, 9.5), 'CCC': (10.0, 9.8)}

    def fake(strategies, sym, date, tf, feed, days=2):
        _t.sleep(random.uniform(0, 0.03))       # uneven, so order really varies
        e, s = prices[sym]
        return [{'symbol': sym, 'strategy': 'X', 'side': 'long',
                 'entry': e, 'stop': s, 'entry_at': '10:00', 'entry_ts': 0}]

    monkeypatch.setattr(dec, 'evaluate_symbol', fake)
    for _ in range(5):                          # repeated: a race shows up once
        out = dec.decide([{'name': 'X'}], ['CCC', 'AAA', 'BBB'],
                         '2026-08-10', workers=3)
        assert [p['symbol'] for p in out['picks']] == ['AAA', 'BBB']


def test_a_run_reports_how_long_it_took():
    """Whether the alert arrived while it was still actionable is a fact about
    the run, not a hope about it."""
    from chart import decide as dec
    out = dec.decide([], [], '2026-08-10')
    assert 'took_ms' in out and isinstance(out['took_ms'], int)


def test_one_symbol_failing_does_not_stop_the_others(monkeypatch):
    from chart import decide as dec

    def fake(strategies, sym, date, tf, feed, days=2):
        if sym == 'BAD':
            return [{'symbol': sym, 'strategy': 'X', 'error': 'no bars'}]
        return [{'symbol': sym, 'strategy': 'X', 'side': 'long', 'entry': 10.0,
                 'stop': 9.0, 'entry_at': '10:00', 'entry_ts': 0}]

    monkeypatch.setattr(dec, 'evaluate_symbol', fake)
    out = dec.decide([{'name': 'X'}], ['GOOD', 'BAD'], '2026-08-10')
    assert [p['symbol'] for p in out['picks']] == ['GOOD']
    assert [e['symbol'] for e in out['errors']] == ['BAD']
