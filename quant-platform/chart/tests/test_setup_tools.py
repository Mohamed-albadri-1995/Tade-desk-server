"""A setup carries the tools it belongs to, and backtests against their picks.

Two things are pinned here.

WHICH TOOLS a setup claims. The setup owns the list rather than each tool
owning a list of setups, so a setup used by three tools is one object instead
of three copies that drift apart the first time one is edited. An unknown id
has to raise: silently dropping it would give a setup that backtests over a
smaller universe than the one written down, and the result would look fine.

WHOSE STOCKS it is measured on. The question worth asking of a setup is not
"does it work on some symbols" but "does it work on the stocks the tool that
will run it actually finds". A setup assigned to T2 backtested over T1's picks
measures a pairing that will never happen.

    python3 -m pytest chart/tests/test_setup_tools.py -q     (from quant-platform/)
"""

import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pytest                                              # noqa: E402

from chart import backtest, store                          # noqa: E402


# ── which tools a setup claims ────────────────────────────────────────────

def test_ids_are_cleaned_not_merely_accepted():
    assert store.normalise_tools([' t1 ', 'T2']) == ['T1', 'T2']


def test_a_tool_named_twice_is_listed_once():
    # Otherwise the backtest would fetch that tool's register twice and every
    # statistic would be weighted by a typo.
    assert store.normalise_tools(['T1', 't1', 'T1']) == ['T1']


def test_order_is_kept_so_the_list_reads_as_it_was_written():
    assert store.normalise_tools(['T7', 'T2', 'T9']) == ['T7', 'T2', 'T9']


def test_a_string_is_accepted_because_people_type_one():
    assert store.normalise_tools('T1, T3') == ['T1', 'T3']


def test_no_tools_is_a_legal_state_not_an_error():
    # A setup is normally built and backtested before anyone decides which
    # tools it belongs to. Refusing to save one would put the decision before
    # the evidence.
    assert store.normalise_tools(None) == []
    assert store.normalise_tools([]) == []


def test_an_unknown_tool_raises_rather_than_being_dropped():
    with pytest.raises(ValueError) as e:
        store.normalise_tools(['T1', 'T99'])
    assert 'T99' in str(e.value)
    # …and says what the real options are, so the fix does not need a grep.
    assert 'T1' in str(e.value)


def test_the_valid_set_comes_from_the_configured_tools():
    # Hardcoding T1..T9 would mean a tenth tool is rejected on the day it is
    # added, and the error would point at the wrong thing.
    from chart import screener as sc
    ids = [s['id'] for s in sc.sources()]
    assert store.normalise_tools(ids) == ids


# ── whose stocks it is measured on ────────────────────────────────────────

class FakeScreener:
    """Frozen registers, without a running screener. Keyed 'T2:R1' -> {day: [rows]}."""

    def __init__(self, data):
        self.data = data
        self.fetches = []

    def available_dates(self, reg):
        return sorted(self.data.get(reg, {}))

    def register_rows(self, reg, day, full=False):
        self.fetches.append((reg, day))
        rows = self.data.get(reg, {}).get(day)
        if rows is None:
            return {'ok': False, 'error': 'no such day'}
        return {'ok': True, 'rows': rows}


@pytest.fixture
def fake(monkeypatch):
    """Install a fake screener module for the duration of one test."""
    holder = {}

    def install(data):
        f = FakeScreener(data)
        import chart.screener as real
        for name in ('available_dates', 'register_rows'):
            monkeypatch.setattr(real, name, getattr(f, name))
        holder['f'] = f
        return f
    return install


SPEC = {'start': '2026-08-03', 'end': '2026-08-05'}


def test_a_setup_is_measured_on_its_own_tools_picks(fake):
    f = fake({
        'T2:R1': {'2026-08-03': [{'ticker': 'AAA'}], '2026-08-04': [{'ticker': 'BBB'}]},
        'T1:R1': {'2026-08-03': [{'ticker': 'ZZZ'}]},
    })
    pairs = backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': ['T2']})
    assert [(d, t) for d, t, _ in pairs] == [('2026-08-03', 'AAA'), ('2026-08-04', 'BBB')]
    # T1's register is never even fetched — the point is the pairing, not a
    # filter applied afterwards.
    assert all(reg == 'T2:R1' for reg, _ in f.fetches)


def test_two_tools_are_unioned(fake):
    fake({
        'T2:R1': {'2026-08-03': [{'ticker': 'AAA'}]},
        'T7:R1': {'2026-08-03': [{'ticker': 'BBB'}]},
    })
    pairs = backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': ['T2', 'T7']})
    assert sorted(t for _, t, _ in pairs) == ['AAA', 'BBB']


def test_a_name_two_tools_both_found_is_evaluated_once(fake):
    # The setup either triggers on that stock that day or it does not. Counting
    # it twice would inflate every statistic in proportion to how much the two
    # tools happen to overlap — and would slip the per-day attempt cap, which
    # is enforced per pair, letting one name double-trade.
    fake({
        'T2:R1': {'2026-08-03': [{'ticker': 'AAA', 'from': 'T2'}]},
        'T7:R1': {'2026-08-03': [{'ticker': 'AAA', 'from': 'T7'}]},
    })
    pairs = backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': ['T2', 'T7']})
    assert len(pairs) == 1
    assert pairs[0][1] == 'AAA'


def test_the_frozen_card_rides_along_with_the_pair(fake):
    # Results can then be filtered by any register column — score, regime,
    # catalyst — which is most of what makes a register backtest worth running.
    fake({'T2:R1': {'2026-08-03': [{'ticker': 'AAA', '_score': 71, 'regime': 'STRONG_UP'}]}})
    _, _, card = backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': ['T2']})[0]
    assert card['_score'] == 71 and card['regime'] == 'STRONG_UP'
    assert card['_tool'] == 'T2'          # …and which tool supplied it


def test_the_spec_can_override_the_setups_own_tools(fake):
    # "How would T2's setup have done on T7's picks" is a real question and
    # must not require editing the setup to ask it.
    fake({
        'T2:R1': {'2026-08-03': [{'ticker': 'AAA'}]},
        'T7:R1': {'2026-08-03': [{'ticker': 'BBB'}]},
    })
    pairs = backtest._pairs(
        {**SPEC, 'universe': {'kind': 'tools', 'tools': ['T7']}}, {'tools': ['T2']})
    assert [t for _, t, _ in pairs] == ['BBB']


def test_an_unassigned_setup_says_so_rather_than_running_on_nothing(fake):
    fake({'T2:R1': {'2026-08-03': [{'ticker': 'AAA'}]}})
    with pytest.raises(ValueError) as e:
        backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': []})
    assert 'not assigned to any tool' in str(e.value)


def test_the_shortlist_register_works_the_same_way(fake):
    fake({'T2:Shortlist': {'2026-08-03': [{'ticker': 'AAA'}]}})
    pairs = backtest._pairs(
        {**SPEC, 'universe': {'kind': 'tools', 'register': 'Shortlist'}}, {'tools': ['T2']})
    assert [t for _, t, _ in pairs] == ['AAA']


def test_days_outside_the_range_are_not_evaluated(fake):
    fake({'T2:R1': {'2026-07-01': [{'ticker': 'OLD'}], '2026-08-04': [{'ticker': 'AAA'}]}})
    pairs = backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': ['T2']})
    assert [t for _, t, _ in pairs] == ['AAA']


def test_no_frozen_days_in_range_names_the_registers_it_looked_in(fake):
    # The usual causes are a screener that is down and a range with no history,
    # and the message has to let those be told apart.
    fake({'T2:R1': {'2026-01-02': [{'ticker': 'AAA'}]}})
    with pytest.raises(ValueError) as e:
        backtest._pairs({**SPEC, 'universe': {'kind': 'tools'}}, {'tools': ['T2']})
    assert 'T2:R1' in str(e.value)


def test_the_plain_register_universe_still_behaves_as_it_did(fake):
    # The existing kind must not change: months of stored backtests were run
    # with it, and a silent change in meaning would make them incomparable.
    fake({'R1': {'2026-08-03': [{'ticker': 'AAA'}, {'ticker': 'AAA'}, {'ticker': 'BBB'}]}})
    pairs = backtest._pairs({**SPEC, 'universe': {'kind': 'register', 'register': 'R1'}})
    assert [t for _, t, _ in pairs] == ['AAA', 'BBB']       # deduped, order kept


# ── assigning tools without rewriting the strategy ────────────────────────
#
# Saving a strategy means writing the whole document back. That is right for
# the builder and wrong for assignment: the screener would have to round-trip
# every rule through another process to change one field, and any bug in that
# round trip silently rewrites the logic that was backtested. set_tools touches
# the tools list and provably nothing else, and the route is a wrapper over it.

@pytest.fixture
def fresh(monkeypatch, tmp_path):
    """An empty database, so a test never edits real strategies."""
    monkeypatch.setattr(store, '_DB', tmp_path / 'q.db')
    monkeypatch.setattr(store, '_conn', None)
    yield
    monkeypatch.setattr(store, '_conn', None)


BODY = {'name': 'X', 'side': 'long', 'risk': {'window_start': 1000},
        'entry': {'logic': 'AND', 'rules': [{'left': 'a'}]}}


def test_assigning_tools_leaves_the_rest_of_the_strategy_untouched(fresh):
    saved = store.save_strategy(dict(BODY))
    assert saved['tools'] == []

    store.set_tools(saved['id'], ['T2'])
    after = store.get_strategy(saved['id'])
    assert after['tools'] == ['T2']
    # Everything that decides a trade comes back identical.
    for k in ('name', 'side', 'risk', 'entry'):
        assert after[k] == BODY[k]


def test_assigning_updates_the_same_strategy_rather_than_adding_one(fresh):
    saved = store.save_strategy(dict(BODY))
    store.set_tools(saved['id'], ['T2'])
    assert [s['id'] for s in store.list_strategies()] == [saved['id']]


def test_a_typo_is_refused_and_changes_nothing(fresh):
    # A silently dropped id gives a setup that no tool ever runs, and it looks
    # exactly like one that is assigned and simply never triggering.
    saved = store.save_strategy({**BODY, 'tools': ['T2']})
    with pytest.raises(ValueError):
        store.set_tools(saved['id'], ['T99'])
    assert store.get_strategy(saved['id'])['tools'] == ['T2']


def test_clearing_the_tools_takes_it_out_of_the_screener(fresh):
    saved = store.save_strategy({**BODY, 'tools': ['T2']})
    store.set_tools(saved['id'], [])
    assert store.get_strategy(saved['id'])['tools'] == []


def test_an_unknown_strategy_is_reported_rather_than_created(fresh):
    # None, not a new row: a mistyped id must not quietly become a second
    # strategy that nothing ever runs.
    assert store.set_tools(424242, ['T2']) is None
    assert store.list_strategies() == []
