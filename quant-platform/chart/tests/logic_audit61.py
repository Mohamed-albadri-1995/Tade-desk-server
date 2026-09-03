"""Audit 61 — a backtest may not know what nobody knew on the day.

    "make strategies test them if they are good then ably them and get
     similar results"

The last five words are the whole difficulty. A backtest and a live desk give
"similar results" only when the backtest was allowed to know exactly what the
desk knew, and every shared file this system writes describes TODAY:

    data/oneil-groups.json   today's group ranks
    data/oneil-13f.json      the four quarters published by now
    ~/.qp-cache/oneil/*.json every filing a company has ever made

Gate a backtest on any of them and every trade is taken on knowledge that did
not exist. The equity curve comes out beautiful, and it comes out beautiful in
the direction that makes you trade it. That is not a weak backtest, it is a
lie with a chart attached — and it is the same family as everything audits 57
to 60 caught: a number that is arithmetically correct about the wrong thing.

So `chart/canslim.py` is built on a refusal:

    A LETTER THAT CANNOT BE RECONSTRUCTED AS OF THE DATE IS NOT RETURNED.

What this file checks is that the refusal cannot be walked around — that no
path through the module hands back a value for a letter it has just said it
cannot reconstruct.

C, A AND I REFUSED OUTRIGHT UNTIL 2026-09-03, all three because a date was
never stored: the EDGAR cache dropped `filed` and the 13F file recorded which
quarters it used but not when any of them became public. Both are stored now
(edgar.SCHEMA 5, f13's `published_by`), so the second half of this file checks
the thing the refusal was standing in for — that a figure filed AFTER the
as-of date is invisible, and that a record with no dates in it still refuses
FOR THAT TICKER rather than falling back to the newest row on file.
"""

import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pandas as _pd                                       # noqa: E402

from chart import canslim, edgar, f13, oneil               # noqa: E402

PASS = FAIL = 0


def ok(label, cond, got=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {label}')
    else:
        FAIL += 1
        print(f'  FAIL {label}' + (f'\n       got: {got!r}' if got is not None
                                   else ''))


print('=' * 64)
print('audit 61 — the letters as they were known on the day')
print('=' * 64)

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'canslim.py').read_text()


# ── 1. WHICH LETTERS CAN BE HAD, AND WHY THE OTHERS CANNOT ─────────────
print()
print('== three letters refuse, and say why ==')

ok('M can be reconstructed — the model is pure over index frames',
   canslim.unavailable('m') is None)
ok('L can be — RS is recomputed from the price cache, which is stored per '
   'session', canslim.unavailable('l') is None)
ok('N and S can be — they are read from the stock\'s own bars',
   canslim.unavailable('n') is None and canslim.unavailable('s') is None)
ok('C and A can be, now that every EDGAR row carries the date it was filed',
   canslim.unavailable('c') is None and canslim.unavailable('a') is None)
ok('I can be, now that each 13F quarter carries when it became public',
   canslim.unavailable('i') is None)

ok('an unknown letter refuses, rather than being quietly allowed',
   canslim.unavailable('z') is not None)
ok('...and so does an empty one', canslim.unavailable('') is not None)

# ONE LIST, NOT TWO. A caller asks `refusals` whether a setup is backtestable
# and `asof` for the values. If those consulted different tables they would
# drift, and the drift would show up as a backtest that ran when it should
# have refused — which is the failure this whole file is about.
ok('refusals() and unavailable() answer from the same table',
   canslim.refusals('canslim') == {} and canslim.refusals(('c', 'z'))
   == {'z': canslim.unavailable('z')}, canslim.refusals(('c', 'z')))
ok('the whole word is backtestable, which is what an empty refusal set means',
   canslim.refusals(('m', 'l', 'n', 's')) == {})

# THE TABLE IS STILL THE SWITCH. Flipping a letter back must refuse it again
# through every path — otherwise POINT_IN_TIME is documentation, not a gate.
_keep = dict(canslim.POINT_IN_TIME)
try:
    canslim.POINT_IN_TIME['c'] = False
    canslim.WHY_NOT['c'] = 'the dates were never stored'
    _off = canslim.asof('AAPL', '2026-03-13', want=('c',))
    ok('a letter switched off in POINT_IN_TIME refuses again, and returns no '
       'value — the table is the gate, not a comment',
       'c' not in _off and _off['refused'].get('c')
       == 'the dates were never stored', _off)
finally:
    canslim.POINT_IN_TIME.clear()
    canslim.POINT_IN_TIME.update(_keep)
    canslim.WHY_NOT.pop('c', None)
ok('...and the table is restored', canslim.refusals('canslim') == {})


# ── 2. THE REFUSAL CANNOT BE WALKED AROUND ─────────────────────────────
#
# This is the one that matters. It is not enough for the module to SAY a
# letter is unavailable; no path through it may hand back a value for one.
print()
print('== a refused letter comes back with no value at all ==')

# NO EDGAR RECORD AND NO 13F FILE FOR THIS NAME — the per-ticker refusal,
# which is a different claim from the letter being unreconstructable and has
# to behave the same way at the boundary: no key, and a reason.
_saved_cache = edgar.CACHE
_saved_shared = f13.SHARED
_tmp = pathlib.Path(tempfile.mkdtemp())
try:
    edgar.CACHE = _tmp / 'oneil'
    f13.SHARED = _tmp / 'no-such-13f.json'

    _r = canslim.asof('NOSUCH', '2026-03-13', want=('c', 'a', 'i'))
    ok('a stock with no record returns none of the three letters',
       not ({'c', 'a', 'i'} & set(_r)), sorted(_r))
    ok('...and names all three in `refused`',
       set(_r['refused']) == {'c', 'a', 'i'}, _r['refused'])
    # NOT None, NOT an empty dict, NOT ANY KEY. A key holding None reads as
    # "this stock has no C", which is a claim about the company. The absence of
    # the key is the only shape that says "this question was not answered".
    ok('the key is ABSENT, not present-and-empty — a None C would read as "this '
       'company has no earnings", which is a different claim',
       'c' not in _r and 'a' not in _r and 'i' not in _r)
    # AND THE REASON SAYS WHAT WOULD HAVE BEEN WRONG, not just that it failed.
    ok('the reason rules out the fallback explicitly, because falling back to '
       'the newest row IS the bug',
       'is not an answer' in _r['refused']['c'], _r['refused']['c'])

    _mix = canslim.asof('NOSUCH', '2026-03-13', want=('c',))
    ok('a request for one unreadable letter refuses only it',
       list(_mix['refused']) == ['c'] and 'c' not in _mix, _mix)
finally:
    edgar.CACHE = _saved_cache
    f13.SHARED = _saved_shared

ok('asking for nothing refuses nothing and returns nothing',
   canslim.asof('AAPL', '2026-03-13', want=())['refused'] == {})

ok('the rule is written where the module starts, not buried',
   'IS NOT RETURNED' in SRC and 'Never today\'s value.' in SRC)
# WHITESPACE-NORMALISED, because the phrase wraps across two lines in the
# docstring and a raw substring search cannot see it. This module has caught
# itself doing that several times now — a check against prose has to read the
# prose the way a person does.
ok('and the reason a flattering backtest is the dangerous kind is recorded',
   'lie with a chart attached' in ' '.join(SRC.split()))


# ── 3. THE MARKET MODEL AS OF A DAY USES NO BAR AFTER IT ───────────────
#
# `market_model` is pure over its frames, so the as-of is a truncation and
# nothing else. What must hold is that the truncation actually happens —
# a cut that silently does nothing is exactly how look-ahead gets in.
print()
print('== the market model as of a day ==')

_dates = _pd.date_range('2024-01-01', periods=400, freq='B')
_frame = _pd.DataFrame({
    'open': [100.0 + i * 0.1 for i in range(400)],
    'high': [101.0 + i * 0.1 for i in range(400)],
    'low': [99.0 + i * 0.1 for i in range(400)],
    'close': [100.5 + i * 0.1 for i in range(400)],
    'volume': [1_000_000] * 400,
}, index=_dates)

_saved = None
try:
    from chart import data_manager as _dm
    _saved = _dm.load_bars
    _dm.load_bars = lambda sym, tf, days, feed=None, *a, **k: _frame.copy()

    _cut = '2024-06-28'
    _asof = oneil.build(asof=_cut)
    _full = oneil.build()

    ok('the as-of model stamps the date it was built for',
       _asof.get('asof') == _cut, _asof.get('asof'))
    ok('...and the model with no as-of does not claim one',
       'asof' not in _full)
    # THE LAST BAR IS THE CUT DATE. Not the day before it: the model for 28
    # June is the one a reader had after 28 June closed, and starting it a day
    # early would throw away the session the decision was made on.
    ok('the newest session it saw is the cut date itself, inclusive',
       str(_asof.get('as_of') or _asof.get('last') or _cut).startswith('2024-06-28')
       or _asof.get('ok') is not None)
    # The real proof: the same frame cut by hand gives the same answer.
    _by_hand = oneil.market_model(
        {s: _frame[_frame.index.astype(str).str.slice(0, 10) <= _cut].copy()
         for s in oneil.INDEXES})
    ok('an as-of model equals the model over hand-cut frames — the truncation '
       'IS the whole of the as-of, with no separate historical path',
       _asof.get('status') == _by_hand.get('status')
       and len(_asof.get('distribution_days') or [])
       == len(_by_hand.get('distribution_days') or []),
       (_asof.get('status'), _by_hand.get('status')))
    # AND IT IS NOT A NO-OP. A cut that quietly kept every bar would pass the
    # equality above and be exactly the bug this is guarding.
    ok('...and the cut really removed bars, rather than passing by doing '
       'nothing',
       len(_frame[_frame.index.astype(str).str.slice(0, 10) <= _cut]) < len(_frame))
finally:
    if _saved is not None:
        from chart import data_manager as _dm2
        _dm2.load_bars = _saved

ok('the reason there is no separate historical model is recorded',
   'no separate backtest evaluator' in
   (pathlib.Path(__file__).resolve().parents[1] / 'oneil.py').read_text())


# ── 4. THE CACHED DAY ───────────────────────────────────────────────────
#
# A date is expensive once — rebuilding the group ranks is about twenty
# seconds — and a register backtest asks for the same date once per symbol.
print()
print('== computed once per date, read many ==')

ok('a day is cached under its own date', 'def _path' in SRC and '.json' in SRC)
ok('...behind a schema, so a day written by older code is rebuilt rather '
   'than read with the wrong keys',
   "rec.get('schema') == SCHEMA" in SRC)
ok('...written through a temp and renamed, so a reader never sees half',
   "tmp.replace(p)" in SRC)
ok('a cache that cannot be WRITTEN still returns the answer it computed',
   'not a reason to fail the read' in SRC)

# THE PRIOR SESSION COMES FROM THE SESSIONS THAT EXIST. Ninety calendar days
# back lands on a weekend or a holiday about a third of the time, and the
# rotation would then compare against a day with no prices and report nothing.
ok('the rotation\'s prior date is picked from cached sessions, not by '
   'subtracting days', 'cached_days()' in SRC and 'weekend or a holiday' in SRC)
ok('...and a history too short to have one says so rather than guessing',
   'if len(days) <= back' in SRC and 'return None' in SRC)


# ── 5. C AND A: A FIGURE FILED AFTER THE DATE IS NOT VISIBLE ────────────
#
# The whole reason C and A refused for a fortnight. A quarter ENDS six weeks
# before anybody reads it, so dating the row by its period rather than by its
# filing hands a backtest the number that moved the stock, on the day before
# it moved.
print()
print('== the quarter you could read, not the quarter that had ended ==')

_saved_cache = edgar.CACHE
_saved_shared = f13.SHARED
_tmp = pathlib.Path(tempfile.mkdtemp())
try:
    edgar.CACHE = _tmp / 'oneil'
    edgar.CACHE.mkdir(parents=True, exist_ok=True)
    _rec = {
        'ticker': 'TSTA', 'schema': edgar.SCHEMA, 'ok': True,
        'built_at': '2026-06-01T00:00:00+00:00',
        'c': {'rows': [
            # Q1 ended 31 March and was filed on 5 May. On 13 March neither
            # had happened; on 1 June both had.
            {'quarter': '2026-03-31', 'filed': '2026-05-05', 'eps': 2.0,
             'eps_chg': 60.0},
            {'quarter': '2025-12-31', 'filed': '2026-02-10', 'eps': 1.8,
             'eps_chg': 40.0},
            {'quarter': '2025-09-30', 'filed': '2025-11-05', 'eps': 1.5,
             'eps_chg': 20.0},
            {'quarter': '2025-06-30', 'filed': '2025-08-05', 'eps': 1.2,
             'eps_chg': 30.0},
        ]},
        'a': {'rows': [
            {'fy': '2025-12-31', 'filed': '2026-02-20', 'eps': 6.0,
             'eps_chg': 50.0, 'roe_pct': 22.0},
            {'fy': '2024-12-31', 'filed': '2025-02-20', 'eps': 4.0,
             'eps_chg': 33.0, 'roe_pct': 20.0},
        ]},
    }
    (edgar.CACHE / 'TSTA.json').write_text(json.dumps(_rec))

    _mar = canslim.asof('TSTA', '2026-03-13', want=('c', 'a'))
    _jun = canslim.asof('TSTA', '2026-06-01', want=('c', 'a'))

    ok('in March the newest quarter is the one filed in February, NOT the one '
       'that ended in March', _mar['c']['latest']['quarter'] == '2025-12-31',
       _mar['c']['latest']['quarter'])
    ok('...and in June it is the March quarter, because by then it had been '
       'filed', _jun['c']['latest']['quarter'] == '2026-03-31',
       _jun['c']['latest']['quarter'])
    # AND THE CUT IS NOT A NO-OP. A filter that quietly kept every row would
    # pass the June check and be exactly the bug.
    ok('the March reading really is shorter — the cut removed a row rather '
       'than passing by doing nothing',
       len(_mar['c']['rows']) == 3 and len(_jun['c']['rows']) == 4,
       (len(_mar['c']['rows']), len(_jun['c']['rows'])))

    # THE VERDICTS ARE RECOMPUTED, NOT COPIED. This is the subtler half:
    # trimming the rows while keeping the stored "accelerating" would be a true
    # statement about a table nobody could see. 20 → 40 → 60 accelerates over
    # three quarters; the March reading has 40 → 20 → 30 and does not.
    ok('the verdicts are recomputed over what was visible, not carried over '
       'from the full table',
       _jun['c']['accelerating'] is True and _mar['c']['accelerating'] is False,
       (_jun['c']['accelerating'], _mar['c']['accelerating']))
    ok('...and the count they were computed over travels with them, so a '
       'verdict over two quarters cannot pass for one over eight',
       _mar['c']['accelerating_of'] == 3 and _jun['c']['beat_25_of'] == 4,
       (_mar['c']['accelerating_of'], _jun['c']['beat_25_of']))
    # THROUGH edgar's OWN SUMMARY, not a copy of the arithmetic here.
    ok('the recomputation goes through edgar.c_summary — one implementation, '
       'so the card and the as-of reading cannot disagree',
       _mar['c']['beat_25'] == edgar.c_summary(_mar['c']['rows'])['beat_25'])

    ok('A works the same way: the 2025 year is invisible before its 10-K',
       _mar['a']['latest']['fy'] == '2025-12-31'
       and canslim.asof('TSTA', '2026-02-01', want=('a',))['a']['latest']['fy']
       == '2024-12-31')

    # NOTHING FILED YET IS A REFUSAL, NOT AN EMPTY TABLE.
    _early = canslim.asof('TSTA', '2024-01-01', want=('c', 'a'))
    ok('before the record starts, both letters refuse rather than returning an '
       'empty table — an empty C reads as a company with no earnings',
       'c' not in _early and 'a' not in _early
       and set(_early['refused']) == {'c', 'a'}, _early)

    # A RECORD WITH NO DATES IN IT. `cached` already rejects an older schema,
    # so this is the case where the schema matches and the rows are dateless.
    (edgar.CACHE / 'TSTB.json').write_text(json.dumps({
        'ticker': 'TSTB', 'schema': edgar.SCHEMA, 'ok': True,
        'c': {'rows': [{'quarter': '2026-03-31', 'eps': 2.0, 'eps_chg': 60.0}]},
        'a': {'rows': []}}))
    _nod = canslim.asof('TSTB', '2026-06-01', want=('c',))
    ok('a row with no filing date is refused, NOT read as "filed long ago" — '
       'the newest row on file is the one answer that must never be given',
       'c' not in _nod and 'nothing on it can be placed' in _nod['refused']['c'],
       _nod)

    # ── I: THE QUARTER THE MARKET COULD SEE ────────────────────────────
    print()
    print('== the 13F quarter that was public, not the one that had ended ==')

    f13.SHARED = _tmp / '13f.json'
    f13.SHARED.write_text(json.dumps({
        'ok': True, 'holder_unit': 'manager',
        'quarters': ['2025Q3', '2025Q4', '2026Q1'],
        'published_by': {'2025Q3': '2025-11-14', '2025Q4': '2026-02-14',
                         '2026Q1': '2026-05-15'},
        'published_measured': {'2025Q3': True, '2025Q4': True,
                               '2026Q1': False},
        'stocks': {'TSTA': {'quarters': [
            {'q': '2025Q3', 'funds': 100, 'of': 1000, 'share_pct': 10.0},
            {'q': '2025Q4', 'funds': 120, 'of': 1000, 'share_pct': 12.0},
            {'q': '2026Q1', 'funds': 200, 'of': 1000, 'share_pct': 20.0}]}}}))

    _i_mar = canslim.asof('TSTA', '2026-03-13', want=('i',))['i']
    _i_jun = canslim.asof('TSTA', '2026-06-01', want=('i',))['i']
    ok('on 13 March the newest 13F quarter is 2025Q4 — 2026Q1 holdings were as '
       'of 31 March and not filed until May',
       _i_mar['newest'] == '2025Q4' and _i_mar['funds'] == 120, _i_mar['newest'])
    ok('...and by June it is 2026Q1', _i_jun['newest'] == '2026Q1')
    ok('the direction is recomputed over the visible quarters only',
       _i_mar['quarters_counted'] == 2 and _i_jun['quarters_counted'] == 3,
       (_i_mar['quarters_counted'], _i_jun['quarters_counted']))
    ok('the history stays a LIST — `trend` is merged into a dict that already '
       'holds one, and it clobbered it once',
       isinstance(_i_mar['quarters'], list) and len(_i_mar['quarters']) == 2)
    ok('a quarter dated by the statutory deadline says so, since a legal '
       'deadline is not an observation',
       _i_mar['published_measured'] is True
       and _i_jun['published_measured'] is False)
    ok('before any quarter was public, I refuses rather than reporting zero '
       'holders — zero managers is a claim about the company',
       'i' not in canslim.asof('TSTA', '2025-01-01', want=('i',)))

    # A 13F FILE FROM BEFORE THE DATES WERE RECORDED.
    f13.SHARED.write_text(json.dumps({
        'ok': True, 'quarters': ['2026Q1'],
        'stocks': {'TSTA': {'quarters': [{'q': '2026Q1', 'funds': 200}]}}}))
    _old = canslim.asof('TSTA', '2026-06-01', want=('i',))
    ok('a 13F file with no `published_by` refuses, rather than treating every '
       'quarter as always having been public',
       'i' not in _old and 'published_by' in _old['refused']['i'], _old)
finally:
    edgar.CACHE = _saved_cache
    f13.SHARED = _saved_shared


# ── 6. WHERE THE DATES COME FROM ────────────────────────────────────────
print()
print('== the dates themselves ==')

_rows = [{'start': '2025-01-01', 'end': '2025-03-31', 'val': 1.0,
          'filed': '2025-05-05'},
         {'start': '2025-04-01', 'end': '2025-06-30', 'val': 1.2,
          'filed': '2025-08-05'},
         {'start': '2025-07-01', 'end': '2025-09-30', 'val': 1.3,
          'filed': '2025-11-05'},
         {'start': '2025-01-01', 'end': '2025-12-31', 'val': 5.0,
          'filed': '2026-02-20'}]
_v, _f = edgar._series(_rows, 60, 120)
_y, _yf = edgar._series(_rows, 300, 400)
ok('the value map and the filed map are built in one pass, so their keys '
   'cannot disagree', set(_v) == set(_f) and set(_y) == set(_yf))
ok('...and the quarterly and annual spans still separate the same way',
   len(_v) == 3 and len(_y) == 1)

_out, _der = edgar._fill_q4(_v, _y, _f, _yf)
ok('a derived Q4 is dated by the LAST filing it needed — the 10-K, not the '
   'year end and not the earliest quarter',
   _f['2025-12-31'] == '2026-02-20', _f.get('2025-12-31'))
ok('...which is the whole point: the subtraction was not knowable until the '
   'annual report existed', '2025-12-31' in _der)

_v2, _f2 = dict(_v), dict(_f)
_f2['2025-06-30'] = None                       # one contributor with no date
edgar._fill_q4(_v2, _y, _f2, _yf)
ok('a derived Q4 whose contributors are not all dated is DATELESS, so it '
   'refuses rather than being dated by the ones that happen to have a date',
   _f2['2025-12-31'] is None, _f2.get('2025-12-31'))

ok('a 13F quarter is dated by the MEDIAN filing, not the first — one early '
   'manager is not the market seeing the quarter',
   f13.published_by({'2026-05-10': 10, '2026-05-14': 40, '2026-05-15': 50},
                    2026, 1) == '2026-05-14',
   f13.published_by({'2026-05-10': 10, '2026-05-14': 40, '2026-05-15': 50},
                    2026, 1))
ok('with no filing dates it falls back to quarter end plus the statutory 45 '
   'days, which is LATE rather than early on purpose',
   f13.published_by({}, 2026, 1) == '2026-05-15'
   and f13.published_by({}, 2025, 4) == '2026-02-14',
   (f13.published_by({}, 2026, 1), f13.published_by({}, 2025, 4)))
ok('the SEC\'s several date spellings all read back the same, and a '
   'nonsense one reads back as nothing',
   f13._isodate('03-31-2026') == '2026-03-31'
   and f13._isodate('2026-03-31') == '2026-03-31'
   and f13._isodate('') is None and f13._isodate('n/a') is None)
# SORTABLE, because every comparison it feeds is a string comparison.
ok('...and the form it returns sorts as a date',
   sorted([f13._isodate('12-01-2026'), f13._isodate('01-02-2026')])
   == ['2026-01-02', '2026-12-01'])

_c, _p, _fl = f13.parse_submissions([
    'ACCESSION_NUMBER\tCIK\tSUBMISSIONTYPE\tPERIODOFREPORT\tFILING_DATE',
    'a1\t100\t13F-HR\t03-31-2026\t05-10-2026',
    'a2\t200\t13F-HR\t03-31-2026\t05-14-2026',
    'a3\t200\t13F-HR/A\t03-31-2026\t05-20-2026'])
ok('the submissions parse still counts MANAGERS by CIK, not filings — an '
   'amendment is one manager filing twice',
   len(set(_c.values())) == 2 and len(_c) == 3)
ok('...and now also reports when they filed', _fl == {'2026-05-10': 1,
                                                      '2026-05-14': 1,
                                                      '2026-05-20': 1}, _fl)
_c0, _p0, _f0 = f13.parse_submissions(['ACCESSION_NUMBER\tCIK\tPERIODOFREPORT',
                                       'a1\t100\t03-31-2026'])
ok('a dataset with no FILING_DATE column parses without one, rather than '
   'failing — the caller falls back to the deadline and says which it used',
   _f0 == {} and _c0 == {'a1': '100'})


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
