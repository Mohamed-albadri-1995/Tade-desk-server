"""Choosing a ranking metric from data, and refusing to when the data cannot.

The tool exists because extension is right for T2 and may be exactly wrong for
the 09:35 opening-range setup — more volume is in the tape by then, and a name
that extended while VWAP failed to follow is a name that reverts. That is a
question about data, not about reasoning.

The tests that matter here are the REFUSALS. A sweep that finds an edge in
noise is worse than no sweep: it produces a number, a rationale and a
configuration change, all of them wrong, and nothing downstream can tell.

    python3 -m pytest chart/tests/test_rank_sweep.py -q     (from quant-platform/)
"""

import random
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import rank_sweep as rs                          # noqa: E402


def make(days=40, per_day=5, ret_of=None, seed=1):
    """A day's signals with stops at increasing distance — k=0 tightest."""
    random.seed(seed)
    out = []
    for d in range(days):
        for k in range(per_day):
            ext = 0.5 + k
            out.append({'date': f'2026-07-{d:02d}', 'symbol': f'S{k}',
                        'side': 'long', 'entry': 100.0,
                        'stop': 100.0 * (1 - ext / 100),
                        'ret': ret_of(k) * (ext / 100), 'ctx': {}})
    return out


# ── the refusals ──────────────────────────────────────────────────────────

def test_pure_noise_produces_no_winner():
    """The one that must never fail.

    With a one-standard-error bar this returned "tight_stop (asc), 0.235R above
    baseline" on data containing no signal at all. Picking the best of seven
    orderings is most of why anything is ever ahead.
    """
    out = rs.sweep(make(ret_of=lambda k: random.gauss(0, 1), seed=3), top_n=2)
    assert out['verdict']['call'] == 'no ranking beats taking everything'


def test_noise_is_refused_across_many_seeds():
    """Once could be luck. This is the false-positive rate."""
    calls = []
    for seed in range(20):
        out = rs.sweep(make(ret_of=lambda k: random.gauss(0, 1), seed=seed), top_n=2)
        calls.append(out['verdict']['call'])
    false_positives = [c for c in calls if c not in
                       ('no ranking beats taking everything', 'not enough trades')]
    assert not false_positives, f'found an edge in noise {len(false_positives)}/20 times'


def test_a_thin_sample_is_refused_whatever_it_shows():
    out = rs.sweep(make(days=5, ret_of=lambda k: random.gauss(1.2 - 0.45 * k, 1.0)),
                   top_n=2)
    assert out['verdict']['call'] == 'not enough trades'
    assert str(rs.MIN_TRADES) in out['verdict']['why']


# ── finding a real one ────────────────────────────────────────────────────

def test_a_real_negative_extension_edge_is_found_with_the_right_sign():
    """The 09:35 hypothesis, made true in synthetic data.

    More extended = worse. The answer must be tight_stop ASCENDING — the least
    extended names — and vwap_extension descending must be visibly negative.
    """
    out = rs.sweep(make(ret_of=lambda k: random.gauss(1.2 - 0.45 * k, 1.0), seed=7),
                   top_n=2)
    assert out['verdict']['call'] == 'tight_stop (asc)'
    by = {r['label']: r for r in out['rows'] if not r.get('error')}
    assert by['vwap_extension (desc)']['expectancy_r'] < 0
    assert by['tight_stop (asc)']['expectancy_r'] > 0


def test_a_real_positive_extension_edge_is_found_too():
    """The T2 direction. The tool must not merely prefer tight stops."""
    out = rs.sweep(make(ret_of=lambda k: random.gauss(-0.6 + 0.45 * k, 1.0), seed=11),
                   top_n=2)
    assert out['verdict']['call'] == 'vwap_extension (desc)'


# ── the arithmetic ────────────────────────────────────────────────────────

def test_the_bar_rises_with_the_number_of_orderings_tried():
    # Bonferroni: more comparisons, higher bar. Testing one thing needs 1.96.
    assert round(rs.threshold_z(1), 2) == 1.96
    assert rs.threshold_z(7) > rs.threshold_z(3) > rs.threshold_z(1)


def test_r_is_measured_against_each_trade_s_own_risk():
    # A 1% gain on a 0.3% stop and a 1% gain on a 3% stop are not the same
    # trade, and percent returns would call them equal.
    tight = {'entry': 100.0, 'stop': 99.7, 'ret': 0.01}
    wide = {'entry': 100.0, 'stop': 97.0, 'ret': 0.01}
    assert round(rs._r_multiple(tight), 2) == 3.33
    assert round(rs._r_multiple(wide), 2) == 0.33


def test_a_trade_with_no_stop_is_left_out_rather_than_counted_as_zero():
    assert rs._r_multiple({'entry': 100.0, 'stop': 0, 'ret': 0.01}) is None
    assert rs.stats([{'entry': 100.0, 'stop': 0, 'ret': 0.01}])['scorable'] == 0


def test_the_baseline_is_every_signal():
    trades = make(days=10, per_day=4, ret_of=lambda k: 1.0)
    out = rs.sweep(trades, top_n=2)
    assert out['baseline']['trades'] == 40
    # Every ordering that could score keeps exactly top_n a day. reg_score and
    # rvol keep nothing here because these rows carry no card.
    scored = [r for r in out['rows'] if r.get('scorable')]
    assert scored and all(r['trades'] == 20 for r in scored)


def test_one_ordering_is_not_listed_twice_under_two_names():
    """tight_stop IS vwap_extension ascending — the platform says so.

    Listing both directions of both put the SAME ordering in the table twice:
    they tied to three decimals and the verdict named whichever sorted first.
    Each duplicate also raises the multiple-comparison bar for no information.
    """
    v = rs.variants()
    assert len(v) == len(set(v))
    families = {(rs.ALIAS_OF.get(m, m), d) for m, d in v}
    assert len(families) == len(v)
    # …and the surviving name is the one whose default direction it is.
    assert ('vwap_extension', 'desc') in v
    assert ('tight_stop', 'asc') in v
    assert ('tight_stop', 'desc') not in v


def test_variants_do_not_read_each_other_s_leftovers():
    """Selection writes rank_metric into ctx; two runs must not share it."""
    trades = make(days=10, ret_of=lambda k: 1.0)
    rs.sweep(trades, top_n=2)
    assert all('rank_metric' not in (t.get('ctx') or {}) for t in trades)
