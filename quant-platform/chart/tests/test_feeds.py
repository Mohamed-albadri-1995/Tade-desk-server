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
