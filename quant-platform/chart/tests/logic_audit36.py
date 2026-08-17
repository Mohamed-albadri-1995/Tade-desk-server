"""The watchlist gate — a trade taken before the scanner found the stock.

THE LOOK-AHEAD NOBODY SEES.

A register backtest evaluates a day's frozen list and takes whatever the
strategy fires. Nothing in that list says WHEN each name arrived, so a 09:45
entry counts in a stock the scanner did not surface until 10:00. Live, that
trade is not a near miss — it is nothing at all: at 09:45 the name was not on
the watchlist, no alert could fire and no order could be placed.

The scanner has always stamped the answer. `foundMinsFromOpen` is minutes from
the 09:30 open, written when a screener first matched the ticker and never moved
afterwards (src/r0/registry.js), negative for a pre-market find. The backtest
simply never read it.

PART A — a trade before the scan time is dropped, and counted.
PART B — a pre-market find gates nothing.
PART C — a missing scan time does NOT become a guessed 09:30.
PART D — the gate can be switched off deliberately, and says so.
"""
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import tools.compare_server as cs                            # noqa: E402
import chart.backtest as bt                                  # noqa: E402
import chart.screener as sc                                  # noqa: E402

PASS = 0
FAIL = 0


def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: got={got!r} exp={exp!r}")


class StubLoader:
    """Flat 1-minute bars, every minute, so the only thing that decides whether
    a trade exists is the entry rule and the gate under test."""
    def load(self, symbol, tf, start, end):
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:8000]
        base = np.full(len(idx), 50.0)
        return pd.DataFrame({'open': base, 'high': base + 0.05, 'low': base - 0.05,
                             'close': base + 0.01, 'volume': 1000.0}, index=idx)


cs._LOADERS['stub36'] = StubLoader()

T = {'kind': 'time', 'field': 'hhmm'}
DAY = '2024-01-09'
RULES = {'rth_entries': True, 'eod_close': True}


def strat_at(hhmm):
    """Fires on exactly one minute of the day, so the entry time is a fact."""
    return {'name': f'at {hhmm}', 'side': 'long',
            'entry': {'logic': 'AND',
                      'rules': [{'left': T, 'op': 'eq',
                                 'right': {'kind': 'const', 'value': hhmm}}]},
            'exit': {'logic': 'AND', 'rules': []}}


def run(rows, strategy, **extra):
    """One register day, whatever rows we hand it."""
    _ad, _rr = sc.available_dates, sc.register_rows
    try:
        sc.available_dates = lambda reg='R1': [DAY]
        sc.register_rows = lambda reg, d, full=False: {'ok': True, 'rows': rows}
        return bt.run({'strategy': strategy, 'tf': '1m', 'days': 1,
                       'feed': 'stub36', 'view': 'all', 'fill': 'close',
                       'start': DAY, 'end': DAY,
                       'universe': {'kind': 'register', 'register': 'R1'},
                       'rules': RULES, **extra})
    finally:
        sc.available_dates, sc.register_rows = _ad, _rr


# ── PART A · the trade that could not have been taken ───────────────────────
print("PART A — an entry before the scanner found the name")

# Found at 10:00 (30 minutes after the open). The strategy fires at 09:45.
FOUND_AT_10 = [{'ticker': 'GOOD', '_score': 9, 'foundMinsFromOpen': 30}]

out = run(FOUND_AT_10, strat_at(945))
cov = out['summary'].get('coverage') or {}
chkv('the 09:45 trade is not counted', len(out['trades']), 0)
chkv('and it is counted as removed, not vanished', cov.get('before_scan'), 1)
chkv('the sample names the two times',
     (cov.get('before_scan_samples') or [None])[0], '2024-01-09 GOOD entry 09:45 < found 10:00')
chkv('the gate is recorded on the run', cov.get('scan_gate'), True)

# The same strategy, one minute after the name arrived, is a real trade.
out = run(FOUND_AT_10, strat_at(1001))
chkv('an entry AFTER the scan time is kept', len(out['trades']), 1)
chkv('nothing was removed', (out['summary'].get('coverage') or {}).get('before_scan'), None)

# The boundary belongs to the trade: the minute the scanner found it is the
# first minute the name was on the list.
out = run(FOUND_AT_10, strat_at(1000))
chkv('an entry ON the scan minute is kept', len(out['trades']), 1)


# ── PART B · a pre-market find gates nothing ────────────────────────────────
print("PART B — a name found before the open")

# 08:00 is 90 minutes BEFORE the open, so foundMinsFromOpen is negative. Those
# names are available from the first bar and must not be gated at all.
PRE = [{'ticker': 'GOOD', '_score': 9, 'foundMinsFromOpen': -90}]
out = run(PRE, strat_at(935))
chkv('a 09:35 entry in a pre-market find is kept', len(out['trades']), 1)
chkv('nothing removed', (out['summary'].get('coverage') or {}).get('before_scan'), None)


# The rule, in the words it was asked for:
#
#   "if the stock been found premarket it's ok to trade it during the day
#    but if the trade was 10 but the scanner find the stock 12 then I can't
#    trade it in reality because it was not really exist at time"
#
# Both halves, spelled out, because the premarket half is the one an
# over-eager gate would get wrong — a negative offset is EARLIER than the open,
# not a name that arrived late.
print("PART B2 — the rule as asked")

out = run(PRE, strat_at(1430))
chkv('found pre-market, traded in the afternoon: kept', len(out['trades']), 1)

FOUND_AT_NOON = [{'ticker': 'GOOD', '_score': 9, 'foundMinsFromOpen': 150}]   # 12:00
out = run(FOUND_AT_NOON, strat_at(1000))
chkv('found at 12:00, entry at 10:00: dropped', len(out['trades']), 0)
chkv('and counted', (out['summary'].get('coverage') or {}).get('before_scan'), 1)

out = run(FOUND_AT_NOON, strat_at(1330))
chkv('found at 12:00, entry at 13:30: kept', len(out['trades']), 1)


# ── PART C · a missing scan time is not a guess ─────────────────────────────
print("PART C — a register row with no scan time")

# Rows frozen before the scanner started stamping the field. A guessed 09:30
# would pass exactly the trades the gate exists to catch, so the honest answer
# is to leave them ungated AND say how many.
OLD = [{'ticker': 'GOOD', '_score': 9}]
out = run(OLD, strat_at(945))
cov = out['summary'].get('coverage') or {}
chkv('an ungatable row still trades', len(out['trades']), 1)
chkv('and is counted as ungatable', cov.get('scan_time_unknown'), 1)
chkv('it is not counted as removed', cov.get('before_scan'), None)

# A field that is present but unreadable is the same case, not a crash.
BAD = [{'ticker': 'GOOD', '_score': 9, 'foundMinsFromOpen': 'soon'}]
out = run(BAD, strat_at(945))
chkv('an unparseable scan time is ungatable, not fatal',
     ((out['summary'].get('coverage') or {}).get('scan_time_unknown'), len(out['trades'])),
     (1, 1))


# ── PART D · switching it off is a decision, and it is recorded ─────────────
print("PART D — the gate switched off")

out = run(FOUND_AT_10, strat_at(945), scan_gate=False)
cov = out['summary'].get('coverage') or {}
chkv('the old, optimistic number is still reachable', len(out['trades']), 1)
chkv('and the run records that the gate was off', cov.get('scan_gate'), False)
chkv('nothing is reported as removed, because nothing was',
     cov.get('before_scan'), None)

# The report has to SAY so — a run whose numbers include impossible trades and
# does not mention it is the thing this whole part exists to prevent.
from chart import server as srv                              # noqa: E402
from chart import store                                      # noqa: E402

_saved = store.get_backtest
try:
    store.get_backtest = lambda bid: {
        'name': 'gate', 'status': 'done',
        'spec': {'tf': '1m', 'feed': 'stub36', 'fill': 'close',
                 'universe': {'kind': 'register', 'register': 'R1'}},
        'summary': {'trades': 1, 'dates': [DAY],
                    'coverage': {'scan_gate': False, 'pairs': 1}},
        'trades': []}
    page = srv.backtest_report(1).body.decode()
    chkv('an OFF gate is disclosed in the report', 'watchlist gate OFF' in page, True)

    store.get_backtest = lambda bid: {
        'name': 'gate', 'status': 'done',
        'spec': {'tf': '1m', 'feed': 'stub36', 'fill': 'close',
                 'universe': {'kind': 'register', 'register': 'R1'}},
        'summary': {'trades': 1, 'dates': [DAY],
                    'coverage': {'scan_gate': True, 'before_scan': 4,
                                 'before_scan_samples': ['2024-01-09 GOOD entry 09:45 < found 10:00']}},
        'trades': []}
    page = srv.backtest_report(1).body.decode()
    chkv('and so are the trades it removed',
         '4 trades removed' in page and 'entry 09:45' in page, True)
finally:
    store.get_backtest = _saved

# ── PART E · the field actually survives the trip ───────────────────────────
#
# Everything above stubs `register_rows`, so it proves the gate and not the
# plumbing. `_card()` names a fixed set of columns and `full=True` merges the
# rest — if `foundMinsFromOpen` were ever added to the card list, or the merge
# order flipped, the gate would go quietly dead with every test still green.
print("PART E — the scan time survives the screener's card mapping")

_one = None
_src = {'id': 't1', 'name': 'Screener', 'url': 'http://stub'}
_orig_get = sc._get
try:
    sc._get = lambda path, base='': [
        {'ticker': 'GOOD', '_score': 9, 'foundMinsFromOpen': 30, 'capturedAt': 1},
    ]
    rows, err = sc._fetch_one(_src, 'R1', DAY, full=True)
    chkv('full=True carries the scan time through', rows[0].get('foundMinsFromOpen'), 30)
    chkv('and it is not shadowed by a card field of the same name',
         'foundMinsFromOpen' not in sc._card({'ticker': 'X'}), True)
finally:
    sc._get = _orig_get

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
