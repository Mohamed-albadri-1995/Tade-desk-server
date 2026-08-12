"""Marking YOUR trade on a print-sheet chart.

The chart sheet draws a DAY. A journal review is looking at a TRADE — where it
went on, where it came off, and what the bars did in between. Same chart, one
more layer.

`_parse_trades` is deliberately separate from `parse_pairs`, which ignores the
columns beside a ticker on purpose: the register card drawn on a chart comes
from the screener's own frozen row, never from retyped numbers that could
disagree with it. A trade is a different kind of fact — not a claim about what
the market did, but the record of what you did, held nowhere else — so it
arrives explicitly and is drawn as given.

What is pinned here is the parsing contract and the refusals. Bad input must
produce no marks rather than a mark in the wrong place: a chart claiming you
entered somewhere you did not is worse than a chart with nothing on it.

    python3 -m pytest chart/tests/test_trade_marks.py -q    (from quant-platform/)
"""

import json
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

# server.py imports fastapi; the parser under test does not. Pull the function
# out of the module source so the test runs without the web stack installed.
_SRC = (pathlib.Path(__file__).resolve().parents[1] / 'server.py').read_text()
_NS: dict = {}
_start = _SRC.index('def _parse_trades')
_end = _SRC.index('def _build_pair_sheets')
exec(compile('import re\n_DATE_RE = re.compile(r"\\d{4}-\\d{2}-\\d{2}")\n'
             + _SRC[_start:_end], 'server_slice', 'exec'), _NS)
_parse_trades = _NS['_parse_trades']


def test_a_trade_is_keyed_by_symbol_and_day():
    got = _parse_trades(json.dumps([
        {'symbol': 'aapl', 'date': '2026-08-03', 'entry': 100, 'exit': 102},
    ]))
    assert list(got) == [('AAPL', '2026-08-03')]      # upper-cased
    assert got[('AAPL', '2026-08-03')]['exit'] == 102


def test_the_same_ticker_on_two_days_is_two_trades():
    """The normal case in a journal, and the reason the key is a pair."""
    got = _parse_trades(json.dumps([
        {'symbol': 'AAPL', 'date': '2026-08-03'},
        {'symbol': 'AAPL', 'date': '2026-08-04'},
    ]))
    assert len(got) == 2


# ── the refusals ──────────────────────────────────────────────────────────

def test_garbage_produces_no_marks_rather_than_wrong_ones():
    """A chart claiming an entry that never happened is worse than a bare one."""
    for bad in ('', 'not json', '{}', '[1,2,3]', '[null]', 'null'):
        assert _parse_trades(bad) == {}, bad


def test_a_row_without_a_real_date_is_dropped():
    got = _parse_trades(json.dumps([
        {'symbol': 'AAPL', 'date': 'yesterday'},
        {'symbol': 'AAPL', 'date': '03-08-2026'},     # not ISO
        {'symbol': '', 'date': '2026-08-03'},
        {'symbol': 'MSFT', 'date': '2026-08-03'},     # the only good one
    ]))
    assert list(got) == [('MSFT', '2026-08-03')]


def test_missing_prices_and_times_are_kept_not_invented():
    """A trade with no exit yet is still worth drawing — the entry is real.
    The renderer decides what it can draw; the parser must not fill blanks."""
    got = _parse_trades(json.dumps([
        {'symbol': 'AAPL', 'date': '2026-08-03', 'entry': 100, 'entry_ts': 111},
    ]))
    t = got[('AAPL', '2026-08-03')]
    assert t['entry'] == 100 and t['entry_ts'] == 111
    assert 'exit' not in t and 'exit_ts' not in t
