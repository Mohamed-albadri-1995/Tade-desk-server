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

    # `view` joined the signature on 2026-08-31: qp's decide path had it
    # hardcoded to 'regular' while every backtest defaults to 'all', so the
    # two evaluated different frames — a different rolling-indicator warm-up,
    # and no 09:29 bar at all for a setup whose entry window opens at 09:30.
    # These stubs take it and ignore it; what these tests are about is the
    # ranking.
    def fake(strategies, sym, date, tf, feed, days=2, fill='live', view='all'):
        _t.sleep(random.uniform(0, 0.03))       # uneven, so order really varies
        e, s = prices[sym]
        return [{'symbol': sym, 'strategy': 'X', 'side': 'long',
                 'entry': e, 'stop': s, 'entry_at': '10:00', 'entry_ts': 0}]

    monkeypatch.setattr(dec, 'evaluate_symbol', fake)
    for _ in range(5):                          # repeated: a race shows up once
        # The metric is NAMED. It used to be assumed, which is what turned a
        # spec's "take the signals" into "take the two most extended".
        out = dec.decide([{'name': 'X'}], ['CCC', 'AAA', 'BBB'],
                         '2026-08-10', workers=3,
                         metric='vwap_extension', top_n=2)
        assert [p['symbol'] for p in out['picks']] == ['AAA', 'BBB']


def _one(entry=10.0, stop=9.0):
    def fake(strategies, sym, date, tf, feed, days=2, fill='live', view='all'):
        st = None if sym == 'NOSTOP' else stop
        return [{'symbol': sym, 'strategy': 'X', 'side': 'long',
                 'entry': entry, 'stop': st, 'entry_at': '10:00', 'entry_ts': 0}]
    return fake


def test_naming_no_metric_takes_every_signal(monkeypatch):
    # The only default that invents no preference. A live run that silently
    # ranked would be backtest #231 with money behind it: 103 of 117 signals
    # discarded on a criterion the spec never mentioned.
    from chart import decide as dec
    monkeypatch.setattr(dec, 'evaluate_symbol', _one())
    out = dec.decide([{'name': 'X'}], ['AAA', 'BBB', 'CCC'], '2026-08-10')
    assert len(out['picks']) == 3
    assert out['rank']['metric'] is None


def test_the_direction_reverses_the_picks(monkeypatch):
    from chart import decide as dec
    prices = {'AAA': 9.0, 'BBB': 9.5, 'CCC': 9.8}

    def fake(strategies, sym, date, tf, feed, days=2, fill='live', view='all'):
        return [{'symbol': sym, 'strategy': 'X', 'side': 'long', 'entry': 10.0,
                 'stop': prices[sym], 'entry_at': '10:00', 'entry_ts': 0}]

    monkeypatch.setattr(dec, 'evaluate_symbol', fake)
    wide = dec.decide([{'name': 'X'}], ['AAA', 'BBB', 'CCC'], '2026-08-10',
                      metric='vwap_extension', top_n=2)
    tight = dec.decide([{'name': 'X'}], ['AAA', 'BBB', 'CCC'], '2026-08-10',
                       metric='tight_stop', top_n=2)
    # Opposite sets. That is the size of what was happening silently.
    assert [p['symbol'] for p in wide['picks']] == ['AAA', 'BBB']
    assert [p['symbol'] for p in tight['picks']] == ['CCC', 'BBB']


def test_an_unknown_metric_is_refused_rather_than_guessed():
    from chart import decide as dec
    out = dec.decide([], [], '2026-08-10', metric='nonsense')
    assert out['ok'] is False
    assert 'unknown rank metric' in out['error']


def test_an_unscorable_signal_is_reported_not_ranked_last(monkeypatch):
    # Sorting it to the bottom would quietly make it the last pick on a thin
    # day — a trade taken on a number that could not be computed.
    from chart import decide as dec
    monkeypatch.setattr(dec, 'evaluate_symbol', _one())
    out = dec.decide([{'name': 'X'}], ['AAA', 'NOSTOP', 'CCC'], '2026-08-10',
                     metric='vwap_extension', top_n=5)
    assert [p['symbol'] for p in out['picks']] == ['AAA', 'CCC']
    assert [d['symbol'] for d in out['dropped_unscorable']] == ['NOSTOP']


def test_the_card_is_what_reg_score_ranks_on(monkeypatch):
    from chart import decide as dec
    monkeypatch.setattr(dec, 'evaluate_symbol', _one())
    out = dec.decide([{'name': 'X'}], ['AAA', 'BBB'], '2026-08-10',
                     metric='reg_score', top_n=1,
                     ctx={'AAA': {'score': 40}, 'BBB': {'score': 90}})
    assert [p['symbol'] for p in out['picks']] == ['BBB']


def test_a_run_reports_how_long_it_took():
    """Whether the alert arrived while it was still actionable is a fact about
    the run, not a hope about it."""
    from chart import decide as dec
    out = dec.decide([], [], '2026-08-10')
    assert 'took_ms' in out and isinstance(out['took_ms'], int)


def test_one_symbol_failing_does_not_stop_the_others(monkeypatch):
    from chart import decide as dec

    def fake(strategies, sym, date, tf, feed, days=2, fill='live', view='all'):
        if sym == 'BAD':
            return [{'symbol': sym, 'strategy': 'X', 'error': 'no bars'}]
        return [{'symbol': sym, 'strategy': 'X', 'side': 'long', 'entry': 10.0,
                 'stop': 9.0, 'entry_at': '10:00', 'entry_ts': 0}]

    monkeypatch.setattr(dec, 'evaluate_symbol', fake)
    out = dec.decide([{'name': 'X'}], ['GOOD', 'BAD'], '2026-08-10')
    assert [p['symbol'] for p in out['picks']] == ['GOOD']
    assert [e['symbol'] for e in out['errors']] == ['BAD']


# ── the open trade is what a live signal looks like ──────────────────────────
# At 10:00 the entry has just fired and nothing has closed it, so the signal
# arrives as `open_trade`, not as a closed trade. It carries `time`; a CLOSED
# trade carries `entry_ts`. Reading entry_ts off an open trade returned 0 —
# 1970 — which never matches the date, so every live pick was dropped without a
# word and the run reported "nothing qualified" on a day with two signals.

def test_an_open_trade_is_picked_up_from_its_own_timestamp_field(monkeypatch):
    from chart import decide as dec

    def fake_evaluate(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {
            'ok': True, 'side': 'long', 'trades': [],
            # Exactly the shape chart/strategy.evaluate returns: `time`.
            'open_trade': {'time': int(pd.Timestamp('2026-08-06 10:00', tz=_ET_TZ)
                                       .timestamp()),
                           'entry': 29.05, 'stop': 27.68},
        }

    monkeypatch.setattr(dec.strat, 'evaluate', fake_evaluate)
    rows = dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE',
                               '2026-08-06', '1m', 'yahoo')
    # THREE KINDS OF ROW NOW: a signal, a failure, and a `seen` row carrying
    # the newest bar this symbol had. The last is what lets the desk tell a
    # live decision from one taken on a delayed feed's older prices, and it is
    # emitted on EVERY evaluated symbol — including the quiet ones, which is
    # exactly when the question matters.
    signals = [r for r in rows if not r.get('seen') and not r.get('error')]
    assert len(signals) == 1, 'the live signal was dropped'
    assert signals[0]['entry'] == 29.05
    assert signals[0]['entry_at'] == '10:00'
    assert signals[0].get('open') is True
    assert any(r.get('seen') for r in rows), 'no bar was reported for the symbol'


def test_an_open_trade_with_no_timestamp_is_an_error_not_a_silent_drop(monkeypatch):
    """The failure that hid the bug: a missing field looked like no signal."""
    from chart import decide as dec

    def fake_evaluate(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {'ok': True, 'side': 'long', 'trades': [],
                'open_trade': {'entry': 29.05, 'stop': 27.68}}

    monkeypatch.setattr(dec.strat, 'evaluate', fake_evaluate)
    rows = dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE',
                               '2026-08-06', '1m', 'yahoo')
    errors = [r for r in rows if r.get('error')]
    assert len(errors) == 1
    assert 'no timestamp' in errors[0]['error']


def test_an_open_trade_from_another_session_is_not_taken(monkeypatch):
    from chart import decide as dec

    def fake_evaluate(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {'ok': True, 'side': 'long', 'trades': [],
                'open_trade': {'time': int(pd.Timestamp('2026-08-05 10:00',
                                                        tz=_ET_TZ).timestamp()),
                               'entry': 29.05, 'stop': 27.68}}

    monkeypatch.setattr(dec.strat, 'evaluate', fake_evaluate)
    rows = dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE',
                               '2026-08-06', '1m', 'yahoo')
    # NO SIGNAL — but the symbol was still looked at, and says so. "Evaluated
    # and found nothing" and "never evaluated" are the two cases the whole
    # session log exists to separate, and the `seen` row is what keeps them
    # apart here.
    assert [r for r in rows if not r.get('seen')] == []
    assert any(r.get('seen') for r in rows)


_ET_TZ = 'America/New_York'


# ── which price the entry is ─────────────────────────────────────────────────
# 'close' fills at the signal bar's close; 'next_open' at the following bar's
# open, which is what a market order really gets. It moves the entry, and
# through it the risk, the target and the ranking metric — so a caller must be
# able to choose it, and the run must say which was used.
#
# Measured on 2026-08-06: LSCC came out at 128.74 on 'close' against the spec's
# 129.56. LIFE differed by a penny. That spread is one bar's range, not a feed
# disagreement, which is how the convention showed itself.

def test_the_fill_convention_reaches_the_strategy(monkeypatch):
    from chart import decide as dec
    seen = {}

    def fake_evaluate(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        seen['fill'] = fill
        return {'ok': True, 'side': 'long', 'trades': [], 'open_trade': None}

    monkeypatch.setattr(dec.strat, 'evaluate', fake_evaluate)
    dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE', '2026-08-06',
                        '1m', 'yahoo', fill='next_open')
    assert seen['fill'] == 'next_open', 'the caller\'s fill never reached evaluate'


def test_a_run_reports_which_fill_it_used():
    """Two runs of the same day can differ only by this, so it is part of the
    answer rather than a setting somebody has to remember."""
    from chart import decide as dec
    assert dec.decide([], [], '2026-08-06')['fill'] == 'close'
    assert dec.decide([], [], '2026-08-06', fill='next_open')['fill'] == 'next_open'


# ── the strategy's own exit, not an invented one ───────────────────────────
#
# Every pick used to be given a single target at target_r × risk, whatever the
# strategy said. For a strategy whose risk block carries scale-out targets —
# take a third at 1R, a third at 2R, let the rest run — that is not a smaller
# approximation of the tested trade. It is a different trade, and the live
# order would not have matched the backtest that justified it.

from chart.decide import exit_plan                            # noqa: E402


def test_a_strategy_with_no_targets_keeps_the_single_r_target():
    p = exit_plan({}, 'long', 100.0, 98.0, 2.0)
    assert len(p['legs']) == 1
    leg = p['legs'][0]
    assert leg['fraction'] == 1.0
    assert leg['r_multiple'] == 2.0
    assert leg['price'] == 104.0
    assert leg['anchored'] is False
    # Every leg now carries its OWN stop, so "2 SL / 2 TP" is a shape the
    # protocol can express rather than one that silently comes out with one.
    assert leg['stop'] == 98.0
    assert p['runner'] == 0.0
    assert p['shape'] == '1 SL / 1 TP'


def test_the_protocol_travels_with_the_plan():
    # The screener must not have to re-derive any of this: what is wrong with a
    # strategy has to arrive with the prices, not be worked out again.
    p = exit_plan({'risk': {'sl': {'type': 'pct', 'value': 1, 'freeze': True},
                            'targets': [{'fraction': 0.5, 'r_multiple': 2}]}},
                  'long', 100.0, 98.0)
    assert p['protocol'] == 1
    assert p['shape'] == '1 SL / 1 TP + runner (50%)'
    assert p['ok'] is True
    assert p['runner'] == 0.5
    assert p['runner_manage'] == 'eod'


def test_a_declared_plan_can_give_each_leg_its_own_stop():
    from chart import exit_protocol as xp
    proto = xp.normalise({'risk': {'sl': {'type': 'pct', 'value': 1, 'freeze': True}},
                          'exit_plan': {'legs': [
                              {'fraction': 0.5, 'r_multiple': 1,
                               'sl': {'type': 'points', 'value': 0.5, 'freeze': True}},
                              {'fraction': 0.5, 'r_multiple': 2}],
                              'runner': {'fraction': 0.0}}})
    assert proto['ok'] is True
    assert proto['shape'] == '2 SL / 2 TP'
    # The second leg falls back to the strategy's stop, EXPLICITLY.
    assert proto['legs'][1]['sl'] == {'type': 'pct', 'value': 1, 'freeze': True}


def test_the_parts_must_add_up_to_exactly_one():
    from chart import exit_protocol as xp
    short = xp.normalise({'risk': {'sl': {'type': 'pct', 'freeze': True}},
                          'exit_plan': {'legs': [{'fraction': 0.4, 'r_multiple': 1},
                                                 {'fraction': 0.4, 'r_multiple': 2}],
                                        'runner': {'fraction': 0.1}}})
    assert short['ok'] is False
    # 90% of a correct size looks exactly like a correct size, so this has to
    # be an error rather than a rounding note.
    assert 'never be ordered' in short['errors'][0]

    over = xp.normalise({'risk': {'sl': {'type': 'pct', 'freeze': True}},
                         'exit_plan': {'legs': [{'fraction': 0.8, 'r_multiple': 1},
                                                {'fraction': 0.8, 'r_multiple': 2}],
                                       'runner': {'fraction': 0.0}}})
    assert over['ok'] is False
    assert 'more than the position' in over['errors'][0]


def test_a_manual_runner_is_declared_and_flagged():
    from chart import exit_protocol as xp
    p = xp.normalise({'risk': {'sl': {'type': 'pct', 'freeze': True}},
                      'exit_plan': {'legs': [{'fraction': 0.7, 'r_multiple': 2}],
                                    'runner': {'fraction': 0.3, 'manage': 'manual'}}})
    assert p['ok'] is True
    assert 'manual' in p['shape']
    assert 'BY HAND' in ' '.join(p['warnings'])


def test_a_leg_with_no_stop_is_an_error_not_a_warning():
    from chart import exit_protocol as xp
    p = xp.normalise({'risk': {'targets': [{'fraction': 1.0, 'r_multiple': 2}]}})
    assert p['ok'] is False
    assert 'no stop' in p['errors'][0]


def test_the_declared_key_is_not_the_exit_RULES_group():
    # qp has always used `exit` for {logic, rules}. Reading that as a protocol
    # found no legs and quietly replaced a real two-part exit with a one-part
    # default — it happened once, while this was being written.
    from chart import exit_protocol as xp
    p = xp.normalise({'exit': {'logic': 'AND', 'rules': []},
                      'risk': {'sl': {'type': 'pct', 'freeze': True},
                               'targets': [{'fraction': 0.5, 'r_multiple': 2}]}})
    assert p['runner']['fraction'] == 0.5
    assert p['derived'] is True


def test_scale_out_legs_are_priced_from_their_r_multiples():
    p = exit_plan({'risk': {'targets': [
        {'fraction': 0.5, 'r_multiple': 1},
        {'fraction': 0.25, 'r_multiple': 2},
    ]}}, 'long', 100.0, 98.0)
    assert [l['price'] for l in p['legs']] == [102.0, 104.0]
    # What the legs do not book rides the stop — the runner is not a rounding
    # error, it is the part of the tested trade that has no target at all.
    assert p['runner'] == 0.25


def test_a_short_prices_its_legs_the_other_way():
    p = exit_plan({'risk': {'targets': [{'fraction': 1.0, 'r_multiple': 2}]}},
                  'short', 100.0, 102.0)
    assert p['legs'][0]['price'] == 96.0


def test_a_frozen_stop_is_fixed_and_a_percent_stop_trails():
    assert exit_plan({'risk': {'sl': {'type': 'pct', 'value': 1.5, 'freeze': True}}},
                     'long', 100.0, 98.0)['stop_kind'] == 'fixed'
    p = exit_plan({'risk': {'sl': {'type': 'pct', 'value': 1.5}}}, 'long', 100.0, 98.0)
    assert p['stop_kind'] == 'trailing'
    assert p['trail'] == {'kind': 'pct', 'value': 1.5}


def test_an_indicator_anchored_stop_reports_no_distance():
    # It is wherever that line sits on the bar. A number here would be a
    # plausible-looking distance that puts the stop where the backtest never
    # had one, so the caller is told there isn't one instead.
    p = exit_plan({'risk': {'sl': {'type': 'prim'}}}, 'long', 100.0, 98.0)
    assert p['stop_anchored'] is True
    assert p['trail'] is None


def test_a_leg_with_an_anchored_target_has_no_price_and_says_so():
    p = exit_plan({'risk': {'targets': [
        {'fraction': 0.5, 'tp': {'type': 'prim', 'key': 'ema'}},
    ]}}, 'long', 100.0, 98.0)
    assert p['legs'][0]['price'] is None
    assert p['legs'][0]['anchored'] is True


def test_a_malformed_leg_is_skipped_rather_than_sized_as_zero():
    p = exit_plan({'risk': {'targets': [
        {'fraction': 'nonsense', 'r_multiple': 1},
        {'fraction': 0, 'r_multiple': 1},
        {'fraction': 0.5, 'r_multiple': 1},
    ]}}, 'long', 100.0, 98.0)
    assert len(p['legs']) == 1
    assert p['legs'][0]['fraction'] == 0.5


# ── a rule exit is not a 2R exit ───────────────────────────────────────────
#
# Three seeds have no targets and leave on a CONDITION — a VWAP cross, an SMA
# cross. Substituting a 2R bracket does not approximate those strategies, it
# replaces them: the backtested win rate comes from the rule exit, so a live
# order at 2R would be a different strategy wearing the same name and carrying
# the same evidence. Fashionably Late is validated at 75%; that number is not
# about a 2R target.

def test_a_strategy_that_exits_on_a_rule_gets_no_invented_target():
    from chart import exit_protocol as xp
    p = xp.normalise({
        'risk': {'sl': {'type': 'pct', 'value': 1, 'freeze': True}},
        'exit': {'logic': 'AND', 'rules': [{'left': 'close', 'op': 'cross_above'}]},
    })
    assert p['legs'][0]['tp_kind'] == 'rule'
    # It ALERTS correctly — entry and stop are both known at the decision.
    assert p['ok'] is True
    # It must not be auto-traded.
    assert p['order_ok'] is False
    assert 'no broker can watch' in ' '.join(p['order_errors'])


def test_a_strategy_with_no_exit_rules_still_gets_the_default_target():
    # Nothing takes it out but the stop, so the screener's R is a stated
    # convention rather than a substitution for something that exists.
    from chart import exit_protocol as xp
    p = xp.normalise({'risk': {'sl': {'type': 'pct', 'value': 1, 'freeze': True}},
                      'exit': {'logic': 'AND', 'rules': []}})
    assert p['legs'][0]['tp_kind'] == 'default_r'
    assert p['order_ok'] is True


def test_the_rule_leg_is_priced_at_nothing():
    p = exit_plan({'risk': {'sl': {'type': 'pct', 'freeze': True}},
                   'exit': {'rules': [{'op': 'cross_above'}]}},
                  'long', 100.0, 98.0)
    assert p['legs'][0]['price'] is None
    assert p['order_ok'] is False


def test_the_three_real_seeds_that_exit_on_a_rule_are_flagged():
    import json
    import pathlib
    from chart import exit_protocol as xp
    seeds = pathlib.Path(__file__).resolve().parents[1] / 'seeds'
    flagged = []
    for f in sorted(seeds.glob('*.json')):
        # A seed file may hold one strategy or a list of them — store's loader
        # accepts both. Iterating a bare dict yields its KEYS, so this loop was
        # handing normalise() the string '_keep_user_edits' the day the first
        # single-strategy seed was added.
        docs = json.loads(f.read_text())
        for s in (docs if isinstance(docs, list) else [docs]):
            if not xp.normalise(s)['order_ok']:
                flagged.append(s['name'])
    assert set(flagged) == {'Fashionably Late Scalp', 'PM Breakout (2m)', 'PML breakout'}


def test_a_cut_without_a_metric_is_ignored_and_reported(monkeypatch):
    """"Take the top 2" with no metric took the first two in card order.

    That is a cut chosen by nothing, and it is indistinguishable from a working
    ranking — which is exactly how T2 was configured after the metric stopped
    being assumed. It is dropped rather than obeyed, and the drop is reported.
    """
    from chart import decide as dec
    monkeypatch.setattr(dec, 'evaluate_symbol', _one())
    out = dec.decide([{'name': 'X'}], ['AAA', 'BBB', 'CCC', 'DDD'], '2026-08-10',
                     top_n=2)
    assert [p['symbol'] for p in out['picks']] == ['AAA', 'BBB', 'CCC', 'DDD']
    assert out['rank']['ignored_top_n'] == 2
    assert out['rank']['top_n'] == 0


def test_a_cut_WITH_a_metric_is_honoured(monkeypatch):
    from chart import decide as dec
    monkeypatch.setattr(dec, 'evaluate_symbol', _one())
    out = dec.decide([{'name': 'X'}], ['AAA', 'BBB'], '2026-08-10',
                     metric='vwap_extension', top_n=1)
    assert len(out['picks']) == 1
    assert out['rank'].get('ignored_top_n') is None


# ── the polygon + yahoo join ──────────────────────────────────────────────
#
# WHY THIS FEED EXISTS. Neither source answers the question this platform asks.
# Polygon has a year of history and full premarket but its free plan is a day
# behind, so a live 09:35 decision taken on it has no bars for this morning at
# all. Yahoo arrives during the session but keeps roughly a week of 1-minute
# history, which is not a backtest. Joined, they answer both halves.
#
# THE JOIN IS THE RISK, so it is what is tested. Stubbed sources, because a
# network fetch in a unit test is a test that fails on a Sunday for reasons
# unrelated to the code.

def _frame(times, vol=1000.0, px=10.0):
    import pandas as pd
    idx = pd.DatetimeIndex([pd.Timestamp(t, tz='UTC') for t in times], name='t')
    return pd.DataFrame(
        {'open': px, 'high': px, 'low': px, 'close': px, 'volume': vol},
        index=idx)


def test_polygon_supplies_history_and_yahoo_only_the_gap(monkeypatch):
    from tools.data import hybrid_yahoo as hy
    import pandas as pd
    poly = _frame(['2026-08-28 14:30', '2026-08-28 14:31'], px=10.0)
    # Yahoo is handed the whole window and returns an OVERLAPPING frame — which
    # is what it really does, because it is asked for a range not a slice.
    yah = _frame(['2026-08-28 14:31', '2026-08-31 13:31'], px=99.0)
    monkeypatch.setattr(hy.polygon, 'load', lambda *a, **k: poly)
    monkeypatch.setattr(hy.yahoo, 'load', lambda *a, **k: yah)
    out = hy.load('X', '1m', pd.Timestamp('2026-08-28', tz='UTC'),
                  pd.Timestamp('2026-08-31 20:00', tz='UTC'))
    assert len(out) == 3
    # POLYGON WINS THE OVERLAP. It is the consolidated settled record; Yahoo is
    # here for the minutes Polygon has not published. Taking Yahoo's copy of a
    # bar Polygon already has would put two tapes' versions of one minute in
    # the frame and pick between them silently.
    assert out.loc[pd.Timestamp('2026-08-28 14:31', tz='UTC'), 'close'] == 10.0
    # ...and only the bars AFTER polygon's last are taken from yahoo.
    assert out.loc[pd.Timestamp('2026-08-31 13:31', tz='UTC'), 'close'] == 99.0


def test_the_yahoo_half_is_asked_for_extended_hours(monkeypatch):
    """Polygon's history carries the premarket, so the gap must too.

    A seam where the premarket simply stops existing reads as "the stock did
    not trade before the open today" — a statement about the world rather than
    about the feed.
    """
    from tools.data import hybrid_yahoo as hy
    import pandas as pd
    seen = {}

    def _yah(symbol, tf, start, end, *a, **kw):
        seen.update(kw)
        return _frame([])
    monkeypatch.setattr(hy.polygon, 'load', lambda *a, **k: _frame([]))
    monkeypatch.setattr(hy.yahoo, 'load', _yah)
    try:
        hy.load('X', '1m', pd.Timestamp('2026-08-28', tz='UTC'),
                pd.Timestamp('2026-08-31', tz='UTC'))
    except RuntimeError:
        pass                     # both empty is a refusal, tested below
    assert seen.get('prepost') is True


def test_yahoos_extended_frame_is_cached_apart_from_the_regular_one():
    """prepost changes which BARS come back, not how they are formatted.

    A regular-hours frame served from cache to a caller that asked for extended
    hours is silently the wrong window, and the caller cannot tell: a session
    with no premarket looks exactly like a stock that did not trade before the
    open.
    """
    from tools.data import yahoo
    import pandas as pd
    a = pd.Timestamp('2026-08-28', tz='UTC')
    b = pd.Timestamp('2026-08-31', tz='UTC')
    assert yahoo._cache_path('X', '1m', a, b, False) \
        != yahoo._cache_path('X', '1m', a, b, True)


def test_one_source_down_still_returns_the_other(monkeypatch):
    """A chart with half the window beats no chart."""
    from tools.data import hybrid_yahoo as hy
    import pandas as pd
    yah = _frame(['2026-08-31 13:31'])
    monkeypatch.setattr(hy.polygon, 'load',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('403')))
    monkeypatch.setattr(hy.yahoo, 'load', lambda *a, **k: yah)
    out = hy.load('X', '1m', pd.Timestamp('2026-08-28', tz='UTC'),
                  pd.Timestamp('2026-08-31 20:00', tz='UTC'))
    assert len(out) == 1


def test_both_sources_down_raises_and_names_both(monkeypatch):
    """Not an empty frame. Zero bars and two dead sources are different facts,
    and returning the first as the second is how a blank chart reads as a
    quiet stock."""
    from tools.data import hybrid_yahoo as hy
    import pandas as pd
    monkeypatch.setattr(hy.polygon, 'load',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('poly boom')))
    monkeypatch.setattr(hy.yahoo, 'load',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('yah boom')))
    with pytest.raises(RuntimeError) as e:
        hy.load('X', '1m', pd.Timestamp('2026-08-28', tz='UTC'),
                pd.Timestamp('2026-08-31', tz='UTC'))
    assert 'poly boom' in str(e.value) and 'yah boom' in str(e.value)


def test_the_frame_is_sorted_and_has_the_five_columns(monkeypatch):
    from tools.data import hybrid_yahoo as hy
    import pandas as pd
    monkeypatch.setattr(hy.polygon, 'load',
                        lambda *a, **k: _frame(['2026-08-28 14:31', '2026-08-28 14:30']))
    monkeypatch.setattr(hy.yahoo, 'load', lambda *a, **k: _frame([]))
    out = hy.load('X', '1m', pd.Timestamp('2026-08-28', tz='UTC'),
                  pd.Timestamp('2026-08-31', tz='UTC'))
    assert list(out.columns) == ['open', 'high', 'low', 'close', 'volume']
    assert out.index.is_monotonic_increasing


def test_it_is_the_default_when_polygon_is_configured(monkeypatch):
    """The only feed that answers BOTH halves of the question — a year to test
    against and today to decide from — so it is what the fallback reaches for.

    Still only a fallback: a chosen feed wins, and yahoo remains the answer on
    a box with no keys.
    """
    import tools.compare_server as cs
    monkeypatch.setattr(cs, 'default_feed_override', lambda: '')
    monkeypatch.setenv('POLYGON_API_KEY', 'x')
    assert cs._feed_status()['default_feed'] == 'hybrid_yahoo'
    monkeypatch.delenv('POLYGON_API_KEY')
    assert cs._feed_status()['default_feed'] == 'yahoo'
    # A choice still wins over the preference.
    monkeypatch.setattr(cs, 'default_feed_override', lambda: 'yahoo')
    monkeypatch.setenv('POLYGON_API_KEY', 'x')
    assert cs._feed_status()['default_feed'] == 'yahoo'


# ── WHICH BAR THE ANSWER WAS ABOUT ───────────────────────────────────────────
#
# The failure that looks exactly like a quiet market, and it cost the whole of
# 2026-09-03.
#
# A DELAYED FEED DOES NOT FAIL. `evaluate` reads whatever bars exist and
# answers about those, so on Yahoo's free intraday data — roughly fifteen
# minutes behind — a desk asks about the 09:41 bar at 09:42, is answered about
# 09:26, and reports "nothing qualified". That is the same sentence a quiet
# market produces. Twenty minutes later the 09:41 bar arrives, the entry
# appears, and the desk refuses it as stale.
#
#     09:49  cards 7  evaluated 7  signalled 0
#     10:00  cards 9  evaluated 9  signalled 2   stale: GEO@09:45, IBKR@09:41
#
# Both signals showed up on exactly the run where a fifteen-minute delay would
# first expose them. Every part of the desk behaved correctly and none of it
# could say why, because the answer never said which bar it was about.

def _quiet(last):
    def fake(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {'ok': True, 'side': 'long', 'trades': [], 'open_trade': None,
                'last': last}
    return fake


def test_a_quiet_symbol_still_reports_the_newest_bar_it_had(monkeypatch):
    """The quiet run is exactly when the question matters."""
    from chart import decide as dec
    monkeypatch.setattr(dec.strat, 'evaluate',
                        _quiet('2026-09-03 09:26 ET'))
    rows = dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE',
                               '2026-09-03', '1m', 'yahoo')
    seen = [r for r in rows if r.get('seen')]
    assert len(seen) == 1
    assert seen[0]['last_bar'] == '09:26'


def test_the_decision_reports_the_newest_and_the_oldest_bar(monkeypatch):
    """One name lagging is a data hole; all of them lagging is the feed."""
    from chart import decide as dec

    def fake(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {'ok': True, 'side': 'long', 'trades': [], 'open_trade': None,
                'last': {'AAA': '2026-09-03 09:26 ET',
                         'BBB': '2026-09-03 09:24 ET'}[symbol]}

    monkeypatch.setattr(dec.strat, 'evaluate', fake)
    out = dec.decide([{'name': 'S', 'side': 'long',
                       'entry': {'logic': 'AND', 'rules': []}}],
                     ['AAA', 'BBB'], '2026-09-03', tf='1m', feed='yahoo',
                     fill='live')
    assert out['ok'] is True
    assert out['last_bar'] == '09:26'
    assert out['oldest_bar'] == '09:24'
    assert out['bars_seen'] == 2
    # AND THE `seen` ROWS ARE NOT PICKS. Routed with the candidates, every
    # evaluated symbol would have become a signal.
    assert out['picks'] == []
    assert out['errors'] == []


def test_a_symbol_that_failed_reports_no_bar_rather_than_a_wrong_one(monkeypatch):
    from chart import decide as dec

    def fake(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        raise RuntimeError('no bars')

    monkeypatch.setattr(dec.strat, 'evaluate', fake)
    out = dec.decide([{'name': 'S', 'side': 'long',
                       'entry': {'logic': 'AND', 'rules': []}}],
                     ['AAA'], '2026-09-03', tf='1m', feed='yahoo', fill='live')
    # NOTHING WAS SEEN, so there is no bar to report. None — never a guess, and
    # never the date asked for, which would read as a perfectly live feed.
    assert out['last_bar'] is None
    assert out['oldest_bar'] is None
    assert out['bars_seen'] == 0
    assert len(out['errors']) == 1


def test_the_bar_is_read_out_of_the_stamp_evaluate_already_writes():
    """Not reformatted from a timestamp — two representations of one bar are
    two things that can disagree."""
    from chart import decide as dec
    assert dec._hhmm_of('2026-09-03 09:41 ET') == '09:41'
    assert dec._hhmm_of('2026-09-03 16:00 ET') == '16:00'
    # ABSENT, NOT ZERO. An older evaluate carries no stamp, and '00:00' would
    # read as a feed that is behind by the whole session.
    assert dec._hhmm_of(None) is None
    assert dec._hhmm_of('') is None
    assert dec._hhmm_of('no time here') is None


# ── a replay of today is live, and live is never served from the cache ─────
#
# The desk names the date it is deciding on every call — asof=today — and
# that made every live decision a "historical" one: the fetch window ended at
# tomorrow's midnight, a constant for the whole day, and the loaders keyed
# their parquet on it. The FIRST fetch of a symbol each day was served back
# unchanged until midnight. 2026-09-04, 15:44 ET: "the newest bar yahoo had was
# 14:14, 90 minutes behind" — not Yahoo's delay, the minute that symbol was
# first asked about. A 09:25 rehearsal would have handed the 09:35 decision
# ten-minute-old bars.

def _today_et():
    return pd.Timestamp.now(tz='America/New_York').strftime('%Y-%m-%d')


def test_today_is_live_and_yesterday_is_a_replay():
    from tools import compare_server as cs
    assert cs.is_live_asof(_today_et()) is True
    assert cs.is_live_asof('2024-01-09') is False
    assert cs.is_live_asof(None) is False
    assert cs.is_live_asof('') is False


def test_a_replay_of_today_ends_at_the_current_minute_not_at_midnight():
    """The window's end IS the cache key, so a constant end is a frozen feed."""
    from tools import compare_server as cs
    seen = {}

    class Stub:
        def load(self, sym, tf, start, end):
            seen['end'] = end
            df = pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])
            df.index = pd.DatetimeIndex([], tz='UTC', name='t')
            return df

    cs._LOADERS['stub_live'] = Stub()
    try:
        cs.prepare_bars('X', '1m', 2, feed='stub_live', view='all', asof=_today_et())
        now = pd.Timestamp.now(tz='UTC')
        # within a minute of now, not tomorrow's midnight
        assert abs((now - seen['end']).total_seconds()) < 120, seen['end']
        assert seen['end'] == seen['end'].floor('min')
    finally:
        cs._LOADERS.pop('stub_live', None)


def test_a_replay_of_yesterday_still_ends_at_its_midnight():
    """Historical replays are untouched — the register backtests depend on it."""
    from tools import compare_server as cs
    seen = {}

    class Stub:
        def load(self, sym, tf, start, end):
            seen['end'] = end
            df = pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])
            df.index = pd.DatetimeIndex([], tz='UTC', name='t')
            return df

    cs._LOADERS['stub_hist'] = Stub()
    try:
        cs.prepare_bars('X', '1m', 2, feed='stub_hist', view='all', asof='2024-01-09')
        want = (pd.Timestamp('2024-01-09', tz='America/New_York')
                + pd.Timedelta(days=1)).tz_convert('UTC')
        assert seen['end'] == want
    finally:
        cs._LOADERS.pop('stub_hist', None)


def test_a_loader_that_knows_live_is_told_and_one_that_does_not_is_not():
    """The audits' stub loaders take four arguments and must keep working."""
    from tools import compare_server as cs
    seen = {}

    class Knows:
        def load(self, symbol, timeframe, start, end, live=False):
            seen['knows'] = live
            df = pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])
            df.index = pd.DatetimeIndex([], tz='UTC', name='t')
            return df

    class DoesNot:
        def load(self, symbol, timeframe, start, end):
            seen['doesnot'] = True
            df = pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])
            df.index = pd.DatetimeIndex([], tz='UTC', name='t')
            return df

    cs._LOADERS['knows'] = Knows()
    cs._LOADERS['doesnot'] = DoesNot()
    try:
        cs.prepare_bars('X', '1m', 2, feed='knows', view='all', asof=_today_et())
        assert seen['knows'] is True
        cs.prepare_bars('X', '1m', 2, feed='knows', view='all', asof='2024-01-09')
        assert seen['knows'] is False
        cs.prepare_bars('X', '1m', 2, feed='doesnot', view='all', asof=_today_et())
        assert seen['doesnot'] is True
    finally:
        cs._LOADERS.pop('knows', None)
        cs._LOADERS.pop('doesnot', None)


def test_the_live_loaders_accept_the_word():
    """yahoo and alpaca are the two feeds a live decision can run on."""
    import inspect
    from tools.data import yahoo, alpaca
    for mod in (yahoo, alpaca):
        assert 'live' in inspect.signature(mod.load).parameters, mod.__name__


def test_yahoo_live_neither_reads_nor_writes_the_cache(monkeypatch, tmp_path):
    """Stubbed at the parquet boundary — this box has no parquet engine, and the
    property is about WHETHER the cache is touched, not about parquet."""
    from tools.data import yahoo
    monkeypatch.setattr(yahoo, '_CACHE_DIR', tmp_path)
    monkeypatch.setattr(yahoo._cache, 'after_write', lambda: None)
    end = pd.Timestamp('2026-09-04 19:44', tz='UTC')
    start = end - pd.Timedelta(days=2)
    # A poisoned cache: the file exists, and reading it yields a bar an hour old.
    yahoo._cache_path('X', '1m', start, end, False).write_bytes(b'poison')
    stale = pd.DataFrame({'open': [1.0], 'high': [1.0], 'low': [1.0], 'close': [1.0],
                          'volume': [1.0]},
                         index=pd.DatetimeIndex([end - pd.Timedelta(hours=1)], tz='UTC', name='t'))
    reads, writes, calls = [], [], []
    monkeypatch.setattr(yahoo.pd, 'read_parquet', lambda path: (reads.append(path), stale)[1])
    monkeypatch.setattr(pd.DataFrame, 'to_parquet', lambda self, path, *a, **k: writes.append(path))
    fresh_ts = int(end.timestamp())

    def fake_fetch(symbol, params):
        calls.append(params)
        return {'timestamp': [fresh_ts],
                'indicators': {'quote': [{'open': [2.0], 'high': [2.0], 'low': [2.0],
                                          'close': [2.0], 'volume': [5.0]}]}}

    monkeypatch.setattr(yahoo, '_fetch', fake_fetch)

    # not live: the poisoned cache is what comes back, and nothing is fetched
    df = yahoo.load('X', '1m', start, end)
    assert len(reads) == 1 and len(calls) == 0 and float(df['close'].iloc[0]) == 1.0

    # live: fetched fresh, the cache neither read nor written — a file per
    # minute per symbol is a disk full by lunch
    df = yahoo.load('X', '1m', start, end, live=True)
    assert len(reads) == 1 and len(calls) == 1 and float(df['close'].iloc[0]) == 2.0
    assert writes == []


def test_the_reference_symbol_cache_is_off_for_today():
    """A SPY frame fetched at 09:25 must not gate a 09:35 decision."""
    import inspect
    from chart import strategy as S
    src = inspect.getsource(S._preload_ref_bars)
    assert 'cs.is_live_asof(asof)' in src
