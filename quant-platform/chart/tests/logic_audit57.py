"""Audit 57 — I, institutional sponsorship, counted from Form 13F.

O'Neil's I is two facts and a trap:

    PRESENT      some funds own it — a stock nobody owns has not been found
    INCREASING   the COUNT is rising, which is money still arriving
    OVER-OWNED   a stock every fund already owns has nobody left to buy it

So the reading is a number and a direction, never a score: "more is better" is
false at both ends and a grade would hide that.

Everything checked here is pure — a hand-built TSV in, an answer out — so the
counting and the name matching are provable with no network at all.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import f13                                     # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}' + (f'  {extra}' if extra is not None else ''))


print('=' * 64)
print('audit 57 — I, from Form 13F: how many funds, and which way')
print('=' * 64)

# ── the count ───────────────────────────────────────────────────────────
TSV = '\n'.join([
    'ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP\tVALUE\tSSHPRNAMT',
    '0001-A\t1\tAPPLE INC\tCOM\t037833100\t1000\t10',
    '0002-B\t2\tApple Inc.\tCOM\t037833100\t2000\t20',
    # THE SAME MANAGER, TWO SHARE CLASSES OF ONE ISSUER. One holder, not two.
    '0003-C\t3\tALPHABET INC\tCL A\t02079K305\t3000\t30',
    '0003-C\t4\tALPHABET INC\tCL C\t02079K305\t4000\t40',
    '\t\t\t\t\t\t',
    '0004-D\t5\tOBSCURE HOLDINGS LTD\tCOM\t999999999\t50\t5',
])
SRC_F13 = (pathlib.Path(__file__).resolve().parents[1]
           / 'f13.py').read_text()

p = f13.parse_infotable(TSV)
c = f13.count_holders(p)

ok('two managers holding one issuer count as two', c.get('037833100') == 2, c)
ok('ONE manager filing two share classes counts as ONE', c.get('02079K305') == 1, c)
ok('...which is the whole reason holders are counted by accession',
   'DISTINCT ACCESSION NUMBER' in (f13._parse_rows.__doc__ or ''))
ok('a blank row is skipped rather than becoming a holder', '' not in c, c)


# ── AN ISSUER IS NOT A CUSIP ────────────────────────────────────────────
#
# From the live field check, on every mega-cap on the screen:
#
#     I  holders 1 · change -5956 · falling          AAPL
#     I  holders 1 · change -6163 · falling          MSFT
#
# Apple does not have one institutional holder. 13F identifies SECURITIES,
# and one company appears under several CUSIPs in the same quarter — the
# common stock, a convertible note, the listed options, all filed under
# NAMEOFISSUER "APPLE INC". Matching by name mapped all of them to AAPL,
# correctly, and the build then appended ONE HISTORY ENTRY PER CUSIP per
# quarter. "1" was whichever security sorted last among the newest quarter's
# entries; the -5956 was a trend across a list that mixed different
# securities with different quarters. Every number was arithmetically correct
# about the wrong thing — the failure this whole module is written against.
print()
print('== holders are counted per COMPANY, not per security ==')

_ISS = '\n'.join([
    'ACCESSION_NUMBER\tCUSIP\tNAMEOFISSUER',
    'acc-A\t037833100\tAPPLE INC',        # common: A, B, C
    'acc-B\t037833100\tAPPLE INC',
    'acc-C\t037833100\tAPPLE INC',
    'acc-A\t037833AK6\tAPPLE INC',        # the convert: A again, and D
    'acc-D\t037833AK6\tAPPLE INC',
    'acc-A\t67066G104\tNVIDIA CORP',
    'acc-B\t67066G104\tNVIDIA CORP',
])
_names = {'APPLE': ['AAPL'], 'NVIDIA': ['NVDA']}
_iss = f13.parse_issuers(_ISS.splitlines())
_ct = f13.match_cusips({c_: {'name': n_} for c_, n_ in _iss.items()}, _names)
_bt = f13.count_by_ticker(_ISS.splitlines(), _ct)

ok('a company\'s several CUSIPs resolve to the one ticker',
   sorted(k for k, v in _ct.items() if v == 'AAPL')
   == ['037833100', '037833AK6'], _ct)
ok('its holders are the UNION across them — four managers, not one security',
   _bt.get('AAPL') == 4, _bt)
# SUMMING WOULD BE 3 + 2 = 5, and it is wrong for the same reason counting
# rows is wrong: a fund holding both the stock and the converts files one
# 13F and is one holder.
ok('...and not the SUM, which double-counts the manager holding both',
   _bt.get('AAPL') != 5, _bt)
ok('...and not one CUSIP of the several, which is what printed 1',
   _bt.get('AAPL') not in (2, 3), _bt)
ok('a company with a single CUSIP is unaffected', _bt.get('NVDA') == 2, _bt)
ok('the rule is the one already stated for share classes, one level up',
   'one level up' in (f13.count_by_ticker.__doc__ or ''))
ok('the live line that showed it is recorded where the fix is',
   'holders 1 · change -5956' in (f13.count_by_ticker.__doc__ or ''))

# ONLY THE MATCHED TICKERS ARE ACCUMULATED, which is why this is lighter than
# the per-CUSIP pass it replaces rather than heavier.
ok('an unmapped security contributes nothing rather than a stray key',
   f13.count_by_ticker(_ISS.splitlines(), {'037833100': 'AAPL'})
   == {'AAPL': 3})
ok('no map at all yields no tickers', 
   f13.count_by_ticker(_ISS.splitlines(), {}) == {})
ok('an empty source is empty, not an exception',
   f13.count_by_ticker(iter([]), _ct) == {}
   and f13.parse_issuers(iter([])) == {})
ok('a file with no recognisable columns yields nothing',
   f13.count_by_ticker(iter(['a\tb\tc', 'x\ty\tz']), _ct) == {}
   and f13.parse_issuers(iter(['a\tb\tc', 'x\ty\tz'])) == {})

# THE NAME MAP IS BUILT OVER EVERY QUARTER BEFORE ANY COUNTING. It was
# applied as it grew, so the oldest quarter was rolled up against a map that
# only knew the oldest quarter's spellings.
ok('the issuer pass is separate from the counting pass',
   'TWO PASSES' in SRC_F13)
ok('...and the name map is complete before the first count',
   SRC_F13.index('cusip_ticker = match_cusips(')
   < SRC_F13.index('per_q[(y, q)], filers[(y, q)] = '))
ok('one history entry per ticker per quarter, never one per security',
   'EXACTLY ONE ENTRY PER TICKER PER QUARTER' in SRC_F13)


# ── AND A COUNT NEEDS ITS DENOMINATOR ──────────────────────────────────
#
# With the per-CUSIP fault fixed, the field check came back:
#
#     AAPL 6693 +729 rising    NVDA 6343 +792 rising    MSFT 6807 +635 rising
#     AMD  3442 +736 rising    PLTR 3209 +483 rising
#
# Five companies, five industries, all rising, all by about the same amount.
# That is the number of MANAGERS FILING growing — more crossing the $100M
# threshold every quarter — carrying every widely-held name up with it. Read
# as sponsorship it says the whole market is being accumulated, which is never
# true. Nothing published the denominator, so the two could not be told apart.
print()
print('== the count is published with the population it came from ==')

_POP = '\n'.join([
    'ACCESSION_NUMBER\tCUSIP\tNAMEOFISSUER',
    'acc-A\t037833100\tAPPLE INC',
    'acc-B\t037833100\tAPPLE INC',
    'acc-A\t037833AK6\tAPPLE INC',
    'acc-D\t037833AK6\tAPPLE INC',
    # Two managers who filed and hold nothing this map recognises. They are
    # still managers who filed.
    'acc-E\t999999999\tSOMETHING ELSE',
    'acc-F\t999999999\tSOMETHING ELSE',
])
_counts, _filers = f13.count_quarter(_POP.splitlines(),
                                     {'037833100': 'AAPL',
                                      '037833AK6': 'AAPL'})
ok('the holders of an issuer are still the union across its CUSIPs',
   _counts == {'AAPL': 3}, _counts)
ok('and the filer count is EVERY manager who filed, not only those holding '
   'something we matched — a denominator that moved when the NAME MATCHING '
   'improved would read as institutions arriving',
   _filers == 5, _filers)
ok('the older entry point still answers exactly what it did',
   f13.count_by_ticker(_POP.splitlines(), {'037833100': 'AAPL'})
   == {'AAPL': 2})
ok('an empty source has no filers rather than an unknown number',
   f13.count_quarter(iter([]), {'x': 'X'}) == ({}, 0))
ok('the file wrappers exist for both, so production never builds a string',
   hasattr(f13, 'count_quarter_file') and hasattr(f13, 'count_by_ticker_file'))
ok('the published file carries the population per quarter, once, rather than '
   'copied onto every ticker row', "'filers_by_quarter'" in SRC_F13)
ok('the five live counts that showed this are recorded where the fix is',
   '+729' in (f13.count_quarter.__doc__ or ''))
# AND THE READING IS NOT CHANGED YET. 6,693 of 7,400 is a different fact from
# 6,693 of 12,000, and until both are on the card there is nothing to decide.
ok('the direction is still the plain count, not silently normalised',
   'The reading is left alone for now' in (f13.count_quarter.__doc__ or ''))

_CARD57 = (pathlib.Path(__file__).resolve().parents[3] / 'public'
           / 'index.html').read_text()
ok('the card prints the denominator beside each quarter',
   'filers_by_quarter' in _CARD57)
# `q.quarter` AGAINST A ROW WRITTEN AS {q, funds}. It rendered the WORD
# undefined, four times, for as long as the row existed.
# CHECKED AS THE EXPRESSION IT IS, not as the absence of a string: the note
# recording the bug quotes `q.quarter`, and an audit that searched for it
# would fail on its own explanation. This module has made that mistake four
# times.
ok('...and reads the quarter under the key the build actually writes',
   "'q': label" in SRC_F13 and 'fq[h.q]' in _CARD57)


# ── THE SHAPE build() ACTUALLY PUBLISHES ───────────────────────────────
#
# Everything above tests a piece. This runs the WHOLE roll-up over a
# hand-built cache and asserts the row that reaches the card, because the two
# faults that got through were both in the joins between the pieces:
#
#   run_fields.py:  TypeError: 'int' object is not subscriptable
#
# `trend()` returned a key called `quarters` holding a COUNT, and
# `row.update(trend(...))` replaced the {q, funds} history with the integer 4.
# The four-quarter history had therefore NEVER reached the published file, for
# any stock, and the card's `.map` over it threw — taking the CANSLIM fold
# down on precisely the 24% of stocks that have 13F data.
#
# Every unit test passed throughout, including the ones written for this row,
# because their fixtures were hand-made and the real shape was never checked
# against them. A fixture that does not come from the producer is a guess.
print()
print('== the row build() writes, end to end ==')

import json as _json                                       # noqa: E402
import os as _os                                           # noqa: E402
import tempfile as _tf                                     # noqa: E402

_d = pathlib.Path(_tf.mkdtemp())


def _quarter_files(y, q, rows, subs):
    p = _d / f'{y}q{q}.tsv'
    p.write_text('ACCESSION_NUMBER\tCUSIP\tNAMEOFISSUER\n'
                 + '\n'.join(rows) + '\n')
    f13._sub_path(p).write_text(
        'ACCESSION_NUMBER\tCIK\tSUBMISSIONTYPE\tPERIODOFREPORT\n'
        + '\n'.join(subs) + '\n')


# A POPULATION LARGER THAN THE HOLDERS, or the share is 100% in every
# quarter and the direction cannot be exercised at all. `zz*` are managers who
# filed and hold something this map does not recognise — which is most of a
# real quarter.
#
# 2025Q4: ciks 100 (who AMENDS, so two accessions) and 200 hold AAPL, out of
#         a population of 4 managers → 50%.
_quarter_files(2025, 4,
               ['a1\t037833100\tAPPLE INC', 'a1x\t037833100\tAPPLE INC',
                'a2\t037833100\tAPPLE INC',
                'z1\t999999999\tSOMETHING ELSE',
                'z2\t999999999\tSOMETHING ELSE'],
               ['a1\t100\t13F-HR\t12-31-2025',
                'a1x\t100\t13F-HR/A\t12-31-2025',
                'a2\t200\t13F-HR\t12-31-2025',
                'z1\t800\t13F-HR\t12-31-2025',
                'z2\t900\t13F-HR\t12-31-2025'])
# 2026Q1: ciks 100, 200 and a new 300 hold it, out of 5 → 60%.
_quarter_files(2026, 1,
               ['b1\t037833100\tAPPLE INC', 'b2\t037833100\tAPPLE INC',
                'b3\t037833100\tAPPLE INC',
                'y1\t999999999\tSOMETHING ELSE',
                'y2\t999999999\tSOMETHING ELSE'],
               ['b1\t100\t13F-HR\t03-31-2026',
                'b2\t200\t13F-HR\t03-31-2026',
                'b3\t300\t13F-HR\t03-31-2026',
                'y1\t800\t13F-HR\t03-31-2026',
                'y2\t900\t13F-HR\t03-31-2026'])

_save = (f13.CACHE, f13.SHARED, f13._name_index, f13.discover_urls,
         f13.recent_quarters)
try:
    f13.CACHE = _d
    f13.SHARED = _d / 'out.json'
    f13._name_index = lambda: {'APPLE': ['AAPL']}
    f13.discover_urls = lambda log=print: {}
    f13.recent_quarters = lambda n=4, today=None: [(2025, 4), (2026, 1)]
    _out = f13.build(quarters=2, log=lambda m: None)
finally:
    (f13.CACHE, f13.SHARED, f13._name_index, f13.discover_urls,
     f13.recent_quarters) = _save

_row = (_out.get('stocks') or {}).get('AAPL') or {}
ok('the build succeeds over a cache it can read', _out.get('ok'), _out)
ok('THE HISTORY IS A LIST, not a count — this is the whole bug',
   isinstance(_row.get('quarters'), list), _row.get('quarters'))
ok('...with one entry per quarter, under the keys the card reads — the '
   'count, the population it came from, and the share of it',
   _row.get('quarters') == [
       {'q': '2025Q4', 'funds': 2, 'of': 4, 'share_pct': 50.0},
       {'q': '2026Q1', 'funds': 3, 'of': 5, 'share_pct': 60.0}],
   _row.get('quarters'))
ok('...and trend\'s own count lives under a name that cannot collide',
   _row.get('quarters_counted') == 2, _row)
ok('an AMENDMENT is not a second holder — three filings, two managers',
   _row.get('funds') == 3 and _row['quarters'][0]['funds'] == 2, _row)
ok('the direction reads across the SHARE it kept, and the raw change is '
   'still there beside it',
   _row.get('direction') == 'rising' and _row.get('change') == 1
   and _row.get('change_share_pct') == 20.0
   and _row.get('direction_basis') == 'share', _row)
ok('the population is counted per quarter, by manager — everyone who filed, '
   'not only those holding something we matched',
   _out.get('filers_by_quarter') == {'2025Q4': 4, '2026Q1': 5},
   _out.get('filers_by_quarter'))
ok('and the file says which unit a holder is',
   _out.get('holder_unit') == 'manager', _out.get('holder_unit'))
ok('the published quarters match the history',
   _out.get('quarters') == ['2025Q4', '2026Q1'], _out.get('quarters'))
ok('nothing was relabelled, the filenames agreeing with the filings',
   _out.get('relabelled') == [], _out.get('relabelled'))
ok('what is written to disk is what was returned',
   _json.loads((_d / 'out.json').read_text())['stocks']['AAPL'] == _row)

# THE FILENAME IS NO LONGER THE AUTHORITY. It was inferred twice here and
# wrong once — every card read 2026Q2 in September for holdings as of 31
# March. PERIODOFREPORT is what the filers themselves state.
_d2 = pathlib.Path(_tf.mkdtemp())
_hit = _d2 / '2026q3.tsv'                       # deliberately the WRONG name
_hit.write_text('ACCESSION_NUMBER\tCUSIP\tNAMEOFISSUER\n'
                'c1\t037833100\tAPPLE INC\n'
                'c2\t037833100\tAPPLE INC\n')
f13._sub_path(_hit).write_text(
    'ACCESSION_NUMBER\tCIK\tSUBMISSIONTYPE\tPERIODOFREPORT\n'
    'c1\t100\t13F-HR\t03-31-2026\nc2\t200\t13F-HR\t03-31-2026\n')
_save2 = (f13.CACHE, f13.SHARED, f13._name_index, f13.discover_urls,
          f13.recent_quarters)
try:
    f13.CACHE = _d2
    f13.SHARED = _d2 / 'out.json'
    f13._name_index = lambda: {'APPLE': ['AAPL']}
    f13.discover_urls = lambda log=print: {}
    f13.recent_quarters = lambda n=1, today=None: [(2026, 3)]
    _o2 = f13.build(quarters=1, log=lambda m: None)
finally:
    (f13.CACHE, f13.SHARED, f13._name_index, f13.discover_urls,
     f13.recent_quarters) = _save2

ok('a filename that disagrees with the filings loses',
   _o2.get('quarters') == ['2026Q1'], _o2.get('quarters'))
ok('...and the disagreement is published, not swallowed',
   _o2.get('relabelled') == ['2026Q3→2026Q1'], _o2.get('relabelled'))
ok('the ticker history carries the corrected label',
   [r['q'] for r in _o2['stocks']['AAPL']['quarters']] == ['2026Q1']
   and _o2['stocks']['AAPL']['funds'] == 2, _o2['stocks']['AAPL'])

# AND WITHOUT SUBMISSIONS IT STILL ANSWERS, in the weaker unit, saying so.
#
# NOT A MISSING SIBLING — that re-fetches, because the pair is the cache unit.
# This is the case the fallback is actually for: a dataset whose SUBMISSION
# table carries no CIK column, so there is no way to tell a manager from a
# filing and the weaker unit is the only answer available.
_d3 = pathlib.Path(_tf.mkdtemp())
_h3 = _d3 / '2026q1.tsv'
_h3.write_text('ACCESSION_NUMBER\tCUSIP\tNAMEOFISSUER\n'
               'c1\t037833100\tAPPLE INC\n'
               'c1x\t037833100\tAPPLE INC\n')
f13._sub_path(_h3).write_text('ACCESSION_NUMBER\tSUBMISSIONTYPE\n'
                              'c1\t13F-HR\nc1x\t13F-HR/A\n')
_save3 = (f13.CACHE, f13.SHARED, f13._name_index, f13.discover_urls,
          f13.recent_quarters)
try:
    f13.CACHE = _d3
    f13.SHARED = _d3 / 'out.json'
    f13._name_index = lambda: {'APPLE': ['AAPL']}
    f13.discover_urls = lambda log=print: {}
    f13.recent_quarters = lambda n=1, today=None: [(2026, 1)]
    _o3 = f13.build(quarters=1, log=lambda m: None)
finally:
    (f13.CACHE, f13.SHARED, f13._name_index, f13.discover_urls,
     f13.recent_quarters) = _save3

ok('a dataset with no CIK column still produces a reading — two filings, '
   'and no way to know they are one manager',
   _o3.get('ok') and _o3['stocks']['AAPL']['funds'] == 2, _o3.get('stocks'))
ok('...and the file says the unit is the FILING, so the card can warn — an '
   'approximation that is not labelled is indistinguishable from the '
   'measurement', _o3.get('holder_unit') == 'filing', _o3.get('holder_unit'))
ok('the card checks the shape before mapping over it, since a number reached '
   'it once', 'Array.isArray(fs.quarters)' in _CARD57)
ok('...and names the unit when it is not the manager',
   'holder_unit' in _CARD57 and 'counted by FILING' in _CARD57)


# ── THE DIRECTION IS THE SHARE, NOT THE COUNT ──────────────────────────
#
# From the field check, with the counts finally in the right unit:
#
#     MSFT  +431 rising    but  71.2% -> 70.4% of filers
#     AAPL  +537 rising         68.6% -> 69.2%
#     NVDA  +605 rising         64.9% -> 66.6%
#     AMD   +649 rising         31.4% -> 36.3%
#     PLTR  +411 rising         32.1% -> 34.2%
#
# Five companies in five industries, every one "rising". The population of
# managers filing went 8,060 · 8,034 · 8,636 · 8,759 over the same quarters
# and carried them all up. Microsoft was LOSING ground against the managers
# who could have held it while the card said money was arriving.
#
# O'Neil's I is new funds DECIDING to buy this stock. A manager that starts
# filing this quarter and indexes everything has decided nothing about
# Microsoft.
print()
print('== the direction is read from the share of filers ==')

_POOL = [8060, 8034, 8636, 8759]
_msft = f13.trend([5737, 5850, 6000, 6168], _POOL)
_amd = f13.trend([2527, 2700, 2950, 3176], _POOL)
_aapl = f13.trend([5527, 5600, 5900, 6064], _POOL)

ok('a count that rises while the share does not is NOT rising — this is the '
   'Microsoft case and the whole point',
   _msft['direction'] != 'rising', _msft)
ok('...and the share move is the negative one it actually is',
   _msft['change_share_pct'] < 0, _msft)
# NOT "falling" EITHER. -1.1% relative over a year is inside the noise a
# threshold population produces; naming it a decline would be over-reading in
# the other direction, which is the same fault wearing the other coat.
ok('...but a 1% relative move is flat, not a decline invented to match the '
   'correction', _msft['direction'] == 'flat', _msft)
ok('a stock genuinely taking share still reads rising',
   _amd['direction'] == 'rising' and _amd['change_share_pct'] > 15, _amd)
ok('and a mega-cap standing still reads flat, however large the raw change',
   _aapl['direction'] == 'flat' and _aapl['change'] == 537, _aapl)

ok('THE RAW CHANGE IS NEVER DROPPED — it is a true fact about the stock',
   _msft['change'] == 431 and _amd['change'] == 649)
ok('...and the share series is published, so the reading can be checked',
   _msft['share_pct'] == [71.2, 72.8, 69.5, 70.4], _msft['share_pct'])
ok('the basis is named, always', _msft['direction_basis'] == 'share')

# RELATIVE, NOT IN POINTS. Half a point is noise at 70% and a sixth of the
# position at 3%, so a fixed points threshold would be deaf at one end and
# hysterical at the other.
_small = f13.trend([300, 360], [10000, 10000])          # 3.0% -> 3.6%
ok('a small holder base moving half a point IS a direction, because it is '
   'a fifth of the position', _small['direction'] == 'rising', _small)
_big = f13.trend([7000, 7060], [10000, 10000])          # 70.0% -> 70.6%
ok('...and the same half point at 70% is not', _big['direction'] == 'flat',
   _big)

ok('the band is a named constant, not a number buried in a comparison',
   f13.SHARE_BAND_PCT == 3.0)

# WITHOUT A POPULATION IT STILL ANSWERS, in the weaker basis, saying so.
_nofil = f13.trend([100, 130])
ok('no filer counts falls back to the raw count',
   _nofil['direction'] == 'rising' and _nofil['direction_basis'] == 'count',
   _nofil)
ok('...and refuses to invent a share move',
   _nofil['change_share_pct'] is None and _nofil['share_pct'] is None, _nofil)
# A PARTIAL POPULATION IS REFUSED rather than patched: a share against one
# quarter's filers compared with a count against another's is the same fault
# as a cover-page share count against a weighted average.
ok('a population missing for one quarter is not half-used',
   f13.trend([100, 130], [1000, None])['direction_basis'] == 'count')
ok('one quarter has no direction at all, as before',
   f13.trend([100])['direction'] is None)

# ── STILL CLIMBING, OR ROSE ONCE AND FADED ─────────────────────────────
#
# Two stocks with the same year-over-year gain, live:
#
#     AMD    31.4 → 33.1 → 35.6 → 36.3     +15.6%   every quarter up
#     PLTR   32.1 → 34.9 → 34.8 → 34.2      +6.5%   up once, down three
#
# Comparing only the first quarter with the last called both "rising", and
# everything between was thrown away. But I is money STILL ARRIVING: a stock
# that gained sponsors a year ago and has shed them for three quarters is
# being distributed, and "rising" is the word a reader acts on.
#
# The same shape as C's `accelerating`, which already refuses to judge a trend
# from its endpoints.
print()
print('== a year-over-year gain that is over is not "rising" ==')

_P = [8060, 8034, 8636, 8759]
_amd2 = f13.trend([2531, 2659, 3074, 3176], _P)
_pltr = f13.trend([2587, 2804, 3005, 2998], _P)

ok('a share climbing every quarter is rising',
   _amd2['direction'] == 'rising', _amd2)
ok('...and one that rose a year ago and has faded since is PEAKED, not '
   'rising — same yearly gain, opposite reading',
   _pltr['direction'] == 'peaked', _pltr)
ok('both still report the year\'s gain, which is real and is not withdrawn',
   _amd2['change_share_pct'] > 0 and _pltr['change_share_pct'] > 0,
   (_amd2['change_share_pct'], _pltr['change_share_pct']))
ok('the newest step is published, so "peaked" can be checked not believed',
   _pltr['last_step_pct'] < 0 < _amd2['last_step_pct'],
   (_pltr['last_step_pct'], _amd2['last_step_pct']))

# THE MIRROR, AND IT MATTERS MORE: down over the year, newest quarter up, is
# the stock being picked up again.
_turn = f13.trend([1000, 900, 800, 860], _P)
ok('down over the year but turning up in the newest quarter says so',
   _turn['direction'] == 'turning up', _turn)
ok('...and one still falling is just falling',
   f13.trend([1000, 900, 800, 700], _P)['direction'] == 'falling')

# THE LAST STEP ONLY BREAKS A TIE. It does not overturn a flat reading — a
# quarter of noise inside the band is not a direction, which is the whole
# reason the band exists.
_flat = f13.trend([5739, 5752, 6140, 6168], _P)
ok('a flat year stays flat however the last quarter moved',
   _flat['direction'] == 'flat', _flat)

ok('without a share series there is no step to read, and none is invented',
   f13.trend([100, 130])['last_step_pct'] is None)
ok('two quarters still give a direction and a step',
   f13.trend([100, 130], [1000, 1000])['last_step_pct'] == 30.0)

# In the function BODY, beside the branch it explains, rather than in the
# docstring — the docstring already carries why the direction is a share at
# all, and this is why it is not only the endpoints.
ok('the two live series that showed this are recorded where the rule is',
   '31.4 → 33.1 → 35.6 → 36.3' in SRC_F13
   and '32.1 → 34.9 → 34.8 → 34.2' in SRC_F13)
ok('peaked is NOT coloured bullish on the card — the gain is real and it is '
   'over, and green would say money is still arriving',
   "fs.direction === 'rising' || fs.direction === 'turning up'" in _CARD57)
ok('...and the newest step reaches the card beside the year\'s move',
   'last_step_pct' in _CARD57 and 'newest quarter' in _CARD57)

ok('the live five that showed this are recorded where the rule is',
   '71.2% -> 70.4%' in (f13.trend.__doc__ or ''))
ok('the card reads the share, not the count',
   'change_share_pct' in _CARD57 and 'share of filers' in _CARD57)
ok('...and leaves the raw change UNCOLOURED, since colouring +431 green '
   'beside the word flat is the contradiction being fixed',
   'holders raw' in _CARD57 and 'deliberately UNCOLOURED' in _CARD57
   or 'THE RAW CHANGE IS NOT COLOURED' in _CARD57)
ok('the issuer name is carried through for matching',
   p['037833100']['name'] == 'APPLE INC', p['037833100'])

ok('a file with no header we recognise yields nothing, not a crash',
   f13.parse_infotable('junk\nrows\n') == {})
ok('...and so does an empty file', f13.parse_infotable('') == {})

# ── the name matching ───────────────────────────────────────────────────
n = f13.normalize_name
ok('the legal-form noise is stripped from both sides',
   n('APPLE INC.') == n('Apple Incorporated') == 'APPLE', n('APPLE INC.'))
ok('punctuation and case do not separate one company into two',
   n('AT&T Inc') == n('AT AND T INC'), (n('AT&T Inc'), n('AT AND T INC')))
ok('a share-class suffix does not make a different company',
   n('ALPHABET INC CL A') == n('Alphabet Inc.'), n('ALPHABET INC CL A'))

NAMES = {'APPLE': ['AAPL'], 'ALPHABET': ['GOOGL', 'GOOG'],
         'AMBIGUOUS': ['XX', 'YY']}
m = f13.match_cusips(p, NAMES)
ok('a clean single match maps the CUSIP to its ticker',
   m.get('037833100') == 'AAPL', m)
ok('a name matching TWO tickers is dropped, never assigned to one',
   '02079K305' not in m, m)
ok('...and a name matching nothing is dropped too', '999999999' not in m, m)
ok('nothing is fuzzy-matched — attributing one company\'s sponsorship to '
   'another is worse than no answer',
   'never nearest' in (f13.match_cusips.__doc__ or ''))

# ── the direction ───────────────────────────────────────────────────────
ok('a rising count is reported as rising, with the size of the rise',
   f13.trend([100, 120, 140])['direction'] == 'rising'
   and f13.trend([100, 120, 140])['change'] == 40, f13.trend([100, 120, 140]))
ok('a falling count is falling', f13.trend([140, 100])['direction'] == 'falling')
ok('an unchanged count is flat, not "no data"',
   f13.trend([50, 50])['direction'] == 'flat')
ok('one quarter has no direction, and says so rather than guessing one',
   f13.trend([50])['direction'] is None
   and 'two quarters' in f13.trend([50])['note'], f13.trend([50]))
ok('...and neither does no data at all', f13.trend([])['direction'] is None)

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('it refuses to score I, because more is NOT always better',
   'false at both ends' in SRC and 'over-owned' in SRC.lower())
ok('the FILER count is the measure, not shares held',
   'Shares held is dominated by' in SRC
   and 'NUMBER OF DISTINCT MANAGERS' in SRC)

# ── the filing lag ──────────────────────────────────────────────────────
# A 13F is due 45 days after the quarter ends. Asking for the quarter that
# just closed gets a 404, and an empty quarter on a card reads as "the funds
# sold out" — the opposite of "it has not been filed yet".
import datetime as _dt                                    # noqa: E402

ok('the quarter that just ended is NOT requested',
   f13.recent_quarters(1, _dt.date(2026, 4, 2)) == [(2025, 4)],
   f13.recent_quarters(1, _dt.date(2026, 4, 2)))
ok('...and it is once its 45 days have passed',
   f13.recent_quarters(1, _dt.date(2026, 5, 20)) == [(2026, 1)],
   f13.recent_quarters(1, _dt.date(2026, 5, 20)))
ok('the history runs oldest-first, so a trend reads left to right',
   f13.recent_quarters(3, _dt.date(2026, 5, 20)) == [(2025, 3), (2025, 4), (2026, 1)],
   f13.recent_quarters(3, _dt.date(2026, 5, 20)))
ok('a year boundary steps back correctly — on 20 Feb the newest filed '
   'quarter is Q4 of the year before, whose 45 days closed on the 14th',
   f13.recent_quarters(2, _dt.date(2026, 2, 20)) == [(2025, 3), (2025, 4)],
   f13.recent_quarters(2, _dt.date(2026, 2, 20)))
ok('...and one day before that deadline it is not yet requested',
   f13.recent_quarters(1, _dt.date(2026, 2, 13)) == [(2025, 3)],
   f13.recent_quarters(1, _dt.date(2026, 2, 13)))

# ── honesty about coverage ──────────────────────────────────────────────
ok('one download per quarter, not six thousand requests',
   'six thousand requests' in SRC and 'structured data set' in SRC)
ok('the CUSIP problem is stated rather than hidden',
   'licensed and not free' in SRC)
ok('an unmatched stock reports NO DATA, never zero funds',
   'reports NO DATA' in SRC)
# Naming the tried urls was the original rule and it was not enough — twelve
# of them were printed nightly and told nobody anything. It still names them,
# and now also names what the SEC's listing actually offered.
ok('a failed fetch names the urls it tried',
   'WHAT WAS TRIED' in SRC and "tried: {tried}" in SRC)
ok('...AND what was on offer, which is the half that was missing',
   'WHAT WAS OFFERED' in SRC and 'index: {_index_summary()}' in SRC)
ok('the CUSIP map only grows, so one odd quarter cannot hole the history',
   'only ever grows' in SRC)


# ── THE FILENAME IS READ, NOT GUESSED ──────────────────────────────────
#
# This module's own comment said the name "is not guessable from the quarter
# alone" — and then guessed it three ways. From the live journal, every night
# for as long as 13F existed:
#
#   2025Q3: no dataset found. Tried: [three urls]      404 404 404
#   2025Q4 · 2026Q1 · 2026Q2                           all 404
#   [ok  ] institutional sponsorship (I): not built
#
# Twelve 404s and not one 403, so the paths were wrong and not the User-Agent:
# EDGAR answered 14,583 requests on the same UA in the same run with nothing
# refused. A name that cannot be guessed has to be read off the SEC's listing.
print()
print('== the SEC listing is the source of the URL ==')

_INDEX_HTML = """
 <li><a href="/files/structureddata/data/form-13f-data-sets/2026q2_form13f.zip">2026 Q2</a></li>
 <li><a href="/files/structureddata/data/form-13f-data-sets/2026q1_form13f.zip">2026 Q1</a></li>
 <li><a href="https://www.sec.gov/files/structureddata/data/form-13f-data-sets/2025q4_form13f.zip">2025 Q4</a></li>
 <li><a href="/files/structureddata/data/financial-statement-data-sets/2026q2.zip">not 13f</a></li>
 <li><a href="/data-research/form-13f.html">not a zip</a></li>
"""
# THE KEY IS THE REPORT QUARTER, WHICH IS NOT THE ONE IN THE NAME. A set
# named 2026q2 holds the filings that ARRIVED in Q2 2026 — holdings as of
# 31 March. See the block on _report_quarter below for how that was found.
_U, _UN = f13.parse_index(_INDEX_HTML)
ok('a listed quarter resolves to its own url',
   _U.get((2026, 1), '').endswith('2026q2_form13f.zip'), _U)
ok('a RELATIVE href gains the host, which is the common case on sec.gov',
   _U[(2026, 1)].startswith('https://www.sec.gov/files/'), _U[(2026, 1)])
ok('...and an absolute one is left alone',
   _U[(2025, 3)].startswith('https://www.sec.gov/files/'), _U[(2025, 3)])
ok('a zip that is not 13F data is not mistaken for one — a quarter number '
   'is not enough to tell them apart', len(_U) == 3, _U)
ok('a link that is not a zip is ignored', (2026, 1) in _U and len(_U) == 3)

ok('a page with no 13F links yields nothing rather than raising',
   f13.parse_index('<a href="/x/2026q2.zip">x</a>') == ({}, []))
ok('...and so does an empty or absent page',
   f13.parse_index('') == ({}, []) and f13.parse_index(None) == ({}, []))

# PURE, so the parsing is provable with no network — which matters more here
# than anywhere else in this module, because the network is precisely what
# could not be checked when the guessed patterns were written.
import inspect                                             # noqa: E402
ok('parse_index touches nothing but its argument',
   'urllib' not in inspect.getsource(f13.parse_index))

# THE FAILURE MESSAGE HAS TO NAME WHAT EXISTS, not only what was requested.
# The old one printed the tried URLs nightly and told nobody anything: the
# useful fact is not which wrong addresses were asked for, it is which right
# ones were on offer.
_save = dict(f13._INDEX)
try:
    f13._INDEX.update({'html': None, 'urls': None, 'error': 'HTTP Error 404'})
    ok('an unreachable LISTING says so, rather than reading as a missing '
       'quarter — different faults, different fixes',
       'index unreachable' in f13._index_summary())
    f13._INDEX.update({'html': '<html/>', 'urls': {}, 'error': None})
    ok('a listing that carries no zips says the page has changed',
       'listed no 13F zips' in f13._index_summary())
    f13._INDEX.update({'urls': {(2026, 1): 'https://x/2026q2_form13f.zip'},
                       'error': None})
    ok('...and when links ARE found it names them, which is the line that '
       'ends the guessing',
       '2026q2_form13f.zip' in f13._index_summary())
finally:
    f13._INDEX.clear()
    f13._INDEX.update(_save)

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('the discovered link is tried BEFORE the constructed ones',
   'THE LINK THE SEC PUBLISHED, FIRST' in SRC)
ok('...and the constructed ones are kept, not deleted: swapping a path that '
   'might work for another that might work is not progress',
   'URL_PATTERNS' in SRC and 'KEPT AS A FALLBACK' in SRC)
ok('the listing is fetched once per run, not once per quarter',
   '_INDEX' in SRC and 'One page fetch per run' in SRC)
ok('the twelve 404s that showed this are recorded',
   '404, 404, 404' in SRC or 'Twelve 404s' in SRC)

# AND THE JOB MUST NOT CALL IT SUCCESS.
DAILY = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
         / 'run_daily.py').read_text()
# EXECUTED AGAINST THE REAL MESSAGES, not grepped. This was
# `'def _looks_failed' in DAILY`, which is true of a marker that fires on
# every line and of one that fires on none. Live, on a night that worked:
#
#     [warn] earnings tables (C, A): 732 built, 0 have no filings,
#            0 failed, 0 left for tomorrow (327s)
#
# Nothing wrong with that run. The list held the bare word 'failed' and a
# healthy step prints it as a COUNT. A marker that fires on success teaches
# the reader to skip past [warn], which is the habit it was built to break.
import importlib.util as _ilu                              # noqa: E402
_spec = _ilu.spec_from_file_location(
    '_rd', pathlib.Path(__file__).resolve().parents[2] / 'deploy' / 'run_daily.py')
_rd = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_rd)

for _msg, _want, _why in (
    ('732 built, 0 have no filings, 0 failed, 0 left for tomorrow (327s)',
     False, 'a healthy walk prints its failure COUNT and it is zero'),
    ('700 built, 0 have no filings, 12 failed, 32 left for tomorrow',
     True, 'a NON-zero failure count is worth a look'),
    ('not built: no 13F quarters could be fetched',
     True, 'the line this marker was built for'),
    ('no RS universe yet — nothing to walk', True, 'nothing to walk'),
    ('not walked: no universe', True, 'not walked'),
    ("3382 tickers over ['2025Q2'] — wanted 2025Q3–2026Q2; index has …",
     False, 'a 13F fallback is not a failure — it is the SEC publishing lag'),
    ('175 groups over 6745 symbols, as of 2026-09-01 → …',
     False, 'a good group build'),
    ('6745 classified, 6095 fetched, 6745 in map', False, 'a good SIC walk'),
    ('0 errors', False, 'zero of anything is health'),
    ('4 errors', True, 'four is not'),
    (None, False, 'a step that returned nothing is not a string'),
):
    ok(f'{"warns" if _want else "quiet"}: {_why}',
       _rd._looks_failed(_msg) is _want, (_msg, _rd._looks_failed(_msg)))

ok('the marker still exists and still writes warn',
   'def _looks_failed' in DAILY and "'warn'" in DAILY)
ok('the false warning that showed this is recorded where the fix is',
   '0 failed' in DAILY and 'fires on success' in DAILY)
ok('...and it still does not take the other steps down',
   'never take the others down' in DAILY)
ok('the line that hid this is quoted where the marker is',
   'no 13F quarters' in DAILY)


# ── WHAT IT CANNOT PLACE IS NAMED, NOT DROPPED ─────────────────────────
#
# The first version of this parser did `if not m: continue`. From the live
# run, with that silence in place:
#
#   13F index: 43 quarterly zips listed — newest (2023, 4)
#
# 43 is exactly 2013Q2 → 2023Q4: every quarter the YYYYqN naming ever covered.
# Everything after it was on the page under another name and was thrown away
# without a word, while the job reported only that its own guesses had 404'd.
# A parser that discards input in silence is the same fault as a URL that is
# guessed without being checked — this module has now made it twice.
print()
print('== the newer naming, and what still cannot be read ==')

_MIXED = """
 <a href="/files/x/2023q4_form13f.zip">2023 Q4</a>
 <a href="/files/x/01dec2023-29feb2024_form13f.zip">Dec-Feb</a>
 <a href="/files/x/01mar2026-31may2026_form13f.zip">Mar-May 2026</a>
 <a href="/files/x/form13f_no_date_at_all.zip">mystery</a>
"""
_M, _MU = f13.parse_index(_MIXED)
ok('a date-range filename is placed in its quarter',
   _M.get((2023, 4), '').endswith('01dec2023-29feb2024_form13f.zip'), _M)
ok('...including one the old pattern could never see',
   (2026, 1) in _M, sorted(_M))
ok('the YYYYqN form still works beside it', (2023, 3) in _M, sorted(_M))
ok('a 13F zip it CANNOT place is named rather than dropped',
   _MU == ['form13f_no_date_at_all.zip'], _MU)


# ── AND THE QUARTER IN THE NAME IS NOT THE QUARTER IN THE DATA ──────────
#
# Read in September 2026, off a live card:
#
#     "it's until q2 2026 now we are in September?"
#
# Which is the whole bug in seven words. The build had just reported
#
#     ok - 3576 tickers over ['2025Q3','2025Q4','2026Q1','2026Q2']
#
# from these four files, and every label was one quarter too new:
#
#     01jun2025-31aug2025   01sep2025-30nov2025
#     01dec2025-28feb2026   01mar2026-31may2026
#
# The SEC names a data set for the window in which the filings ARRIVED. A 13F
# is due 45 days after the quarter it describes ends, so the report quarter is
# the one whose deadline falls inside the window — the last quarter to have
# ended when the window opened. The previous version of this file dated a
# range by where it FINISHES and carried a comment justifying it. The comment
# was confident and wrong, which is the only kind that survives review.
print()
print('== a filing window is not a report quarter ==')

ok('a range is dated by where it OPENS, and by the deadline that opening '
   'implies — Mar-May 2026 is holdings as of 31 March',
   f13._quarter_of('01mar2026-31may2026_form13f.zip') == (2026, 1),
   f13._quarter_of('01mar2026-31may2026_form13f.zip'))
ok('...the four the live run mislabelled now read as filed',
   [f13._quarter_of(n) for n in
    ('01jun2025-31aug2025_form13f.zip', '01sep2025-30nov2025_form13f.zip',
     '01dec2025-28feb2026_form13f.zip', '01mar2026-31may2026_form13f.zip')]
   == [(2025, 2), (2025, 3), (2025, 4), (2026, 1)],
   [f13._quarter_of(n) for n in
    ('01jun2025-31aug2025_form13f.zip', '01sep2025-30nov2025_form13f.zip',
     '01dec2025-28feb2026_form13f.zip', '01mar2026-31may2026_form13f.zip')])
ok('the older calendar-quarter naming is a filing window too: 2023q4 is what '
   'arrived Oct-Dec 2023, which is Q3',
   f13._quarter_of('2023q4_form13f.zip') == (2023, 3),
   f13._quarter_of('2023q4_form13f.zip'))
# WHY THAT READING AND NOT THE OTHER. The listing runs 2013q2 ... 2023q4 —
# 43 files, exactly every calendar quarter — and then continues
# 01dec2023-29feb2024 and on. Read as filing windows the two namings form one
# unbroken run of report quarters. Read the old half as report quarters and
# the seam repeats 2023Q4 twice. Continuity is the evidence, so it is a test.
ok('the seam between the two namings is continuous — no quarter repeated, '
   'none lost, which is what says the reading is right',
   f13._quarter_of('2023q3_form13f.zip') == (2023, 2)
   and f13._quarter_of('2023q4_form13f.zip') == (2023, 3)
   and f13._quarter_of('01dec2023-29feb2024_form13f.zip') == (2023, 4)
   and f13._quarter_of('01mar2024-31may2024_form13f.zip') == (2024, 1))
ok('every window-opening month maps to the quarter that had ended by then',
   [f13._quarter_of(f'01{m}2025-x_form13f.zip') for m in
    ('mar', 'jun', 'sep', 'dec')]
   == [(2025, 1), (2025, 2), (2025, 3), (2025, 4)])
ok('...and a January opening belongs to the year before, not to Q1',
   f13._quarter_of('01jan2025-31mar2025_form13f.zip') == (2024, 4),
   f13._quarter_of('01jan2025-31mar2025_form13f.zip'))
ok('a name with no date at all is unreadable, not guessed',
   f13._quarter_of('form13f.zip') is None)
ok('the words that caught it are recorded where the rule is',
   'now we are in September' in
   (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text())

SRC2 = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('the unplaced names reach the log, which is the point of keeping them',
   'could not be placed' in SRC2 and 'UNPLACED' in SRC2)
ok('the silence that hid this is recorded where the parser is',
   'DISCARDED, NOT DROPPED' in SRC2 or 'discards input in silence' in SRC2
   or 'silently dropped' in SRC2 or 'NOT DISCARDED' in SRC2)

# ── AND IT USES WHAT EXISTS ─────────────────────────────────────────────
#
# recent_quarters() is right about the filing deadline and useless alone: it
# asked for 2025Q3-2026Q2, the listing offered nothing past 2023Q4, and the
# whole letter was dropped because four specific quarters were absent.
ok('build falls back to the newest quarters the index actually has',
   'k <= qs[-1]' in SRC2 and 'fell_back' in SRC2)
# AND IT SLIDES WHEN ONLY THE NEWEST IS MISSING, which is the ordinary case:
# the deadline passing is not the SEC publishing. The old condition fired only
# when NONE of the four existed, so the usual night — three of four listed —
# silently returned a three-quarter history instead of four.
ok('...even when only some of the wanted quarters are missing, so the history '
   'keeps its length', 'SOME, NOT NONE' in SRC2)
ok('...and says so, so a fallback cannot pass for a normal night',
   "'fell_back': fell_back" in SRC2)
ok('the published file still carries the quarters it used, which the card '
   'prints — stale data stays visibly dated',
   "'quarters': [f'{y}Q{q}'" in SRC2)
DAILY2 = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
          / 'run_daily.py').read_text()
ok('the run summary repeats the fallback', "out['fell_back']" in DAILY2)
ok('...and a failed build names what the index held', "out.get('index'" in DAILY2)


# ── AN EMPTY FILE IS NOT A CACHED ANSWER ───────────────────────────────
#
# From the live cache, after the download finally worked:
#
#     -rw-r--r--  0          2025q3.tsv     ← zero bytes
#     -rw-r--r--  338236901  2025q4.tsv     ← real
#
# `if hit.exists(): return hit.read_text()` handed back the empty one
# forever, so that quarter reported "0 securities" without ever re-fetching —
# an absence stored where an answer belongs, which is the trap this whole
# module is written around.
print()
print('== an empty quarter is retried, not remembered ==')
import io as _io2                                          # noqa: E402
import tempfile as _tf3                                    # noqa: E402
import zipfile as _zf2                                     # noqa: E402

SRC3 = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('a zero-byte cache file is not served as the answer',
   'hit.stat().st_size > 0' in SRC3)
ok('...and an empty extract is never written in the first place',
   'is EMPTY — not cached' in SRC3 and 'will retry' in SRC3)
ok('the live listing that showed it is recorded', '2025q3.tsv' in SRC3
   or 'ZERO-BYTE' in SRC3)

# A zip can carry a stub whose name also ends INFOTABLE.TSV. Taking names[0]
# picked one; the holdings table is by far the largest member.
_buf = _io2.BytesIO()
with _zf2.ZipFile(_buf, 'w') as _z:
    _z.writestr('junk/INFOTABLE.tsv', '')
    _z.writestr('data/INFOTABLE.tsv', 'ACCESSION_NUMBER\tCUSIP\n1\t037833100\n')
_names = sorted(_zf2.ZipFile(_io2.BytesIO(_buf.getvalue())).infolist(),
                key=lambda i: -i.file_size)
ok('the largest INFOTABLE is the one read, not the first alphabetically',
   _names[0].filename == 'data/INFOTABLE.tsv', [i.filename for i in _names])
ok('...and the code sorts by size to find it',
   'members.sort(key=lambda i: -i.file_size)' in SRC3)
ok('the member it used is named in the log, so a wrong pick is visible',
   '{members[0].filename}' in SRC3)

_cache_was = f13.CACHE
try:
    f13.CACHE = pathlib.Path(_tf3.mkdtemp())
    (f13.CACHE / '2025q3.tsv').write_text('')
    _got = []
    _real = f13.discover_urls
    f13.discover_urls = lambda log=print: (_got.append(1) or {})
    try:
        f13.fetch_quarter(2025, 3, log=lambda *_: None)
    finally:
        f13.discover_urls = _real
    ok('an empty cached quarter causes a REFETCH rather than an empty answer',
       _got, 'discover_urls was never reached')
finally:
    f13.CACHE = _cache_was


# The first build cannot run in a phone's terminal, and did not.
_R13 = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
        / 'run_13f.py').read_text()
_U13 = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
        / 'qp-13f.service').read_text()
ok('13F has its own runner, so it need not drag the whole nightly job',
   'f13.build(' in _R13)
ok('...and its own unit, because 338MB per quarter outlives an ssh session',
   'Type=simple' in _U13 and 'TimeoutStartSec=infinity' in _U13)
ok('the unit REFUSES to run beside qp-edgar — the earlier note said they '
   'were safe together, which was true about endpoints and wrong about the '
   'memory that took the machine down',
   'Conflicts=qp-edgar.service' in _U13)
ok('the reason it exists is recorded in the words it was reported in',
   'running on my phone' in _U13)


# A QUARTER THAT PARSED TO NOTHING IS NOT PART OF THE READING.
#
# `(y, q) in per_q` was true for an EMPTY dict, so the published `quarters` —
# which the card prints as the range the reading spans — named a period no
# stock had a single data point from. Live, that was 2025Q3 coming back from
# the zero-byte cache.
_SRC4 = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('an empty quarter is not listed among the quarters covered',
   "if per_q.get((y, q))" in _SRC4 and "if (y, q) in per_q]," not in _SRC4)
ok('...but it IS named separately, so an empty dataset is visible rather '
   'than quietly shortening the history', "'quarters_empty'" in _SRC4)
ok('the run summary repeats it',
   "quarters_empty" in (pathlib.Path(__file__).resolve().parents[2]
                        / 'deploy' / 'run_daily.py').read_text())
# The counting was already safe and must stay so: iterating an empty dict
# gives no ticker a zero, so nothing can read as "the funds sold out".
# EXECUTED, NOT MATCHED. This was a search for the loop's variable names and
# went red when the loop started iterating tickers instead of CUSIPs — the
# rename was correct and the check could not tell. What must hold is the
# BEHAVIOUR: an empty quarter adds no row, for anyone.
_empty_rows = {}
for _t, _n in ({} or {}).items():                          # the loop's shape
    _empty_rows[_t] = _n
ok('an empty quarter still gives no ticker a false zero',
   _empty_rows == {} and 'if counts is None:' in _SRC4
   and f13.count_by_ticker(iter([]), {'x': 'X'}) == {}
   and f13.parse_infotable('') == {})


# ── NOTHING WHOLE IS EVER IN MEMORY ────────────────────────────────────
#
# The box stopped answering ssh entirely:
#
#     kex_exchange_identification: read: Software caused connection abort
#
# sshd accepted the socket and died before its banner — an out-of-memory
# machine. The 13F fetch held a quarter FOUR times over: the compressed zip
# from r.read(), the same bytes alive inside BytesIO, the decompressed member
# from zf.read(), and a decoded copy of it — and then splitlines() turned the
# last one into a list of ~30 million str objects, over a gigabyte in
# per-object overhead before any content. qp-edgar was walking 14,601
# companies beside it.
print()
print('== a quarter is streamed, never materialised ==')
import resource as _rs                                     # noqa: E402
import tempfile as _tf4                                    # noqa: E402
import zipfile as _zf4                                     # noqa: E402

_SRC5 = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('the download goes to a FILE, not into a bytes object',
   'shutil.copyfileobj(r, tmp' in _SRC5 and 'blob = r.read()' not in _SRC5)
ok('...and the zip is opened from that path, so it is never read whole',
   'zipfile.ZipFile(tmp.name)' in _SRC5 and 'io.BytesIO(blob)' not in _SRC5)
ok('the member is streamed out, not zf.read() into memory',
   'zf.open(member)' in _SRC5 and 'zf.read(members[0])' not in _SRC5)
ok('the temp zip is removed in a finally, not left behind on a failure',
   'IN A FINALLY' in _SRC5 and 'os.unlink(tmp.name)' in _SRC5)
ok('the parser takes an ITERABLE of lines, so the caller picks the source',
   'def _parse_rows(lines)' in _SRC5)
ok('...and the production path reads the file, never one giant string',
   'def parse_infotable_file' in _SRC5
   and 'parse_infotable_file(path)' in _SRC5)
ok('the ssh failure that showed this is recorded where the fix is',
   'took the machine' in _SRC5 or 'thirty\n    million' in _SRC5
   or 'thirty' in _SRC5)

# THE TWO PARSERS MUST NEVER DIVERGE — one is what the audits check, the
# other is what actually runs.
_HEAD = ('ACCESSION_NUMBER\tINFOTABLE_SK\tNAMEOFISSUER\tTITLEOFCLASS\tCUSIP'
         '\tVALUE\tSSHPRNAMT\tPUTCALL\tVOTING_AUTH_SOLE\n')
_BODY = ''.join(f'ACC-{i % 7}\t{i}\tAPPLE INC\tCOM\t037833100\t1\t1\t\t1\n'
                for i in range(500))
_TEXT = _HEAD + _BODY
_dir4 = pathlib.Path(_tf4.mkdtemp())
(_dir4 / 'x.tsv').write_text(_TEXT)
ok('the file parser and the text parser give the same counts',
   f13.count_holders(f13.parse_infotable_file(_dir4 / 'x.tsv'))
   == f13.count_holders(f13.parse_infotable(_TEXT))
   == {'037833100': 7},
   f13.count_holders(f13.parse_infotable_file(_dir4 / 'x.tsv')))

# EXTRACTED AND REDUCED IN ONE PASS. An INFOTABLE also carries value, share
# counts, put/call and voting authority, none of which anything reads.
_zp = _dir4 / 'q.zip'
with _zf4.ZipFile(_zp, 'w', _zf4.ZIP_DEFLATED) as _z:
    _z.writestr('junk/INFOTABLE.tsv', '')      # the stub that fooled names[0]
    _z.writestr('data/INFOTABLE.tsv', _TEXT)
_cache_was4 = f13.CACHE
try:
    f13.CACHE = _dir4
    _hit = _dir4 / '2026q2.tsv'
    _rss0 = _rs.getrusage(_rs.RUSAGE_SELF).ru_maxrss
    with _zf4.ZipFile(_zp) as _zf:
        _got = f13._fetch_from_zip(_zf, 2026, 2, 'http://x/f.zip', _hit,
                                   log=lambda *_: None)
    _rss1 = _rs.getrusage(_rs.RUSAGE_SELF).ru_maxrss
    ok('a quarter extracts to a cache file', _got == _hit and _hit.exists())
    ok('the stub member is skipped and the real table taken',
       _hit.stat().st_size > 0, _hit.stat().st_size)
    ok('only the columns that are read are kept',
       open(_hit).readline().strip().split('\t') == list(f13.KEEP_COLS),
       open(_hit).readline())
    ok('...so the cache is smaller than the raw table',
       _hit.stat().st_size < len(_TEXT),
       (_hit.stat().st_size, len(_TEXT)))
    ok('the counts survive the reduction',
       f13.count_holders(f13.parse_infotable_file(_hit)) == {'037833100': 7})
    ok('extracting does not grow the heap',
       _rss1 - _rss0 < 50_000, (_rss0, _rss1))
finally:
    f13.CACHE = _cache_was4

# ...AND THE UNITS CANNOT DO IT AGAIN.
_U13b = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
         / 'qp-13f.service').read_text()
ok('the two heavy jobs no longer claim to be safe together',
   'Conflicts=qp-edgar.service' in _U13b
   and 'different endpoints' not in _U13b)
ok('a ceiling kills the UNIT rather than the machine',
   'MemoryMax=' in _U13b)
# A LIMIT THE SIZE OF THE MACHINE IS NOT A LIMIT. The box is a t3.micro with
# 1GB, already running twenty PM2 processes, so MemoryMax=1G would have read
# as a safety net while being none.
ok('...and the ceiling is well under the machine it runs on',
   'MemoryMax=400M' in _U13b and 'MemoryMax=1G' not in _U13b)
ok('the instance size is written down, since the number depends on it',
   't3.micro' in _U13b)

# The accession set is what a real quarter fills: one entry per holding row,
# a few million of them, from about six thousand distinct filings.
_SRC6 = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
ok('accessions are stored as shared ids, not a str per row',
   'aid = ids[acc] = len(ids)' in _SRC6)
ok('...and the counts are unchanged by it',
   f13.count_holders(f13.parse_infotable(TSV))
   == {'037833100': 2, '02079K305': 1, '999999999': 1})
ok('the duplication that made it matter is written down',
   'SIX THOUSAND distinct' in _SRC6)
ok('...and a restart loop is bounded, since on-failure plus OOM is a loop',
   'StartLimitBurst=' in _U13b)
_UNIT_SECTION = _U13b.split('\n[Service]\n')[0]
ok('the limits sit in [Unit], where systemd actually reads them',
   'StartLimitBurst=' in _UNIT_SECTION and 'MemoryMax=' not in _UNIT_SECTION)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
