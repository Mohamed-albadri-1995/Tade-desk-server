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

    def fake(strategies, sym, date, tf, feed, days=2, fill='close'):
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
    def fake(strategies, sym, date, tf, feed, days=2, fill='close'):
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

    def fake(strategies, sym, date, tf, feed, days=2, fill='close'):
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

    def fake(strategies, sym, date, tf, feed, days=2, fill='close'):
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
    assert len(rows) == 1, 'the live signal was dropped'
    assert rows[0]['entry'] == 29.05
    assert rows[0]['entry_at'] == '10:00'
    assert rows[0].get('open') is True


def test_an_open_trade_with_no_timestamp_is_an_error_not_a_silent_drop(monkeypatch):
    """The failure that hid the bug: a missing field looked like no signal."""
    from chart import decide as dec

    def fake_evaluate(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {'ok': True, 'side': 'long', 'trades': [],
                'open_trade': {'entry': 29.05, 'stop': 27.68}}

    monkeypatch.setattr(dec.strat, 'evaluate', fake_evaluate)
    rows = dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE',
                               '2026-08-06', '1m', 'yahoo')
    assert len(rows) == 1
    assert 'no timestamp' in rows[0]['error']


def test_an_open_trade_from_another_session_is_not_taken(monkeypatch):
    from chart import decide as dec

    def fake_evaluate(strategy, symbol, tf, days, feed, view, asof, fill='close'):
        return {'ok': True, 'side': 'long', 'trades': [],
                'open_trade': {'time': int(pd.Timestamp('2026-08-05 10:00',
                                                        tz=_ET_TZ).timestamp()),
                               'entry': 29.05, 'stop': 27.68}}

    monkeypatch.setattr(dec.strat, 'evaluate', fake_evaluate)
    assert dec.evaluate_symbol([{'name': 'S', 'side': 'long'}], 'LIFE',
                               '2026-08-06', '1m', 'yahoo') == []


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
        for s in json.loads(f.read_text()):
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
