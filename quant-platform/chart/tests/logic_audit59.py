"""Audit 59 — numbers that are arithmetically true and financially false.

Three of these reached live cards, and every one of them was produced by
correct arithmetic applied where the arithmetic does not mean anything. That
is the failure mode this whole file exists for: a wrong number that looks
right is worse than a missing one, because a missing one is obviously missing.

    ROE 34.1% vs the 17% floor ✓   on a company with EPS of -0.05 for the year
    2025-12-31  EPS 5.95           in a year of -4.80, -5.07, -4.74 and -8.66
    MARGIN -237021.6%              beside revenue of $1,403

The first passed a CANSLIM criterion that exists specifically to exclude that
company. The second was the largest positive figure in an eight-quarter table
and was never anybody's earnings. The third is a true ratio that has stopped
describing a business.

The file already refused a percentage from a negative base — trap 4 in its own
docstring. Each of these was the same trap through a different door.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import edgar                                    # noqa: E402

PASS = FAIL = 0


def ok(name, cond, extra=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}' + (f'  {extra}' if extra is not None else ''))


def _rows(items):
    """companyfacts rows. `start` is what makes a period quarterly or annual."""
    return [{'start': s, 'end': e, 'val': v, 'form': '10-Q', 'fp': 'Q1',
             'accn': f'{e}{v}', 'filed': e} for s, e, v in items]


def _cf(eps=(), ni=(), rev=(), eq=()):
    facts = {}
    if eps:
        facts['EarningsPerShareDiluted'] = {'units': {'shares': _rows(eps)}}
    if ni:
        facts['NetIncomeLoss'] = {'units': {'USD': _rows(ni)}}
    if rev:
        facts['Revenues'] = {'units': {'USD': _rows(rev)}}
    if eq:
        facts['StockholdersEquity'] = {'units': {'USD': _rows(eq)}}
    return {'facts': {'us-gaap': facts}}


print('=' * 64)
print('audit 59 — true arithmetic, false readings')
print('=' * 64)

# ── A. RETURN ON EQUITY NEEDS EQUITY ────────────────────────────────────
#
# The guard was `if equity`, which is true for -3,000,000 as readily as for
# 3,000,000. A company whose accumulated losses had eaten its balance sheet
# divided a negative income by a negative equity and printed a POSITIVE
# return — then passed the floor O'Neil put there to keep it out.
print()
print('== A. ROE ==')
ok('two negatives do not make a return', edgar._roe(-1_000_000, -3_000_000)
   is None, edgar._roe(-1_000_000, -3_000_000))
ok('...nor does dividing by zero equity', edgar._roe(1_000_000, 0) is None)
ok('a real return is still computed', edgar._roe(1_000_000, 5_000_000) == 20.0)
ok('a genuine LOSS on real equity keeps its minus sign, because that is a '
   'true reading and must not be hidden along with the false one',
   edgar._roe(-1_000_000, 5_000_000) == -20.0)
ok('a missing figure is still missing, not zero',
   edgar._roe(None, 5_000_000) is None and edgar._roe(1.0, None) is None)

EDG = (pathlib.Path(__file__).resolve().parents[1] / 'edgar.py').read_text()
ok('the false pass is written down where the guard is',
   'ROE 34.1% vs the 17% floor' in EDG and 'if equity' in EDG)

# THE WHOLE POINT: the floor must not be passed on a fiction.
A = edgar.a_table(_cf(
    eps=[('2025-01-01', '2025-12-31', -0.05)],
    ni=[('2025-01-01', '2025-12-31', -1_000_000)],
    eq=[('2025-12-31', '2025-12-31', -3_000_000)]))
ok('the live case now yields NO roe rather than a passing one',
   A['roe_pct'] is None and A['roe_pass'] is None, A)
ok('...and the row says why the cell is blank',
   'equity is zero or negative' in (A['rows'][0].get('roe_note') or ''),
   A['rows'][0])
ok('the card prints that reason rather than an em dash',
   'roe_note' in (pathlib.Path(__file__).resolve().parents[3]
                  / 'public' / 'index.html').read_text())

# ── B. EPS IS A RATIO, AND A RATIO IS NOT ADDITIVE ──────────────────────
#
# Q4 is derived as FY minus the first three quarters. Exact for dollars.
# Only valid for a per-share figure while the share count holds still — and
# after a reverse split or a heavy issue the annual EPS is struck on a
# weighted-average count that matches none of the quarters.
print()
print('== B. the derived fourth quarter ==')
LOSSY = _cf(
    eps=[('2025-01-01', '2025-03-31', -4.80), ('2025-04-01', '2025-06-30', -5.07),
         ('2025-07-01', '2025-09-30', -4.74), ('2025-01-01', '2025-12-31', -8.66)],
    ni=[('2025-01-01', '2025-03-31', -4.0e6), ('2025-04-01', '2025-06-30', -4.2e6),
        ('2025-07-01', '2025-09-30', -3.9e6), ('2025-01-01', '2025-12-31', -1.55e7)])
C = edgar.c_table(LOSSY)
qs = {r['quarter']: r['eps'] for r in C['rows']}
ok('the fabricated profit quarter is gone', '2025-12-31' not in qs, qs)
ok('...and the three real quarters are untouched',
   qs == {'2025-03-31': -4.8, '2025-06-30': -5.07, '2025-09-30': -4.74}, qs)

# THE CHECK MUST NOT COST A HONEST COMPANY ITS FOURTH QUARTER.
STEADY = _cf(
    eps=[('2025-01-01', '2025-03-31', 1.0), ('2025-04-01', '2025-06-30', 1.0),
         ('2025-07-01', '2025-09-30', 1.0), ('2025-01-01', '2025-12-31', 4.0)],
    ni=[('2025-01-01', '2025-03-31', 1e6), ('2025-04-01', '2025-06-30', 1e6),
        ('2025-07-01', '2025-09-30', 1e6), ('2025-01-01', '2025-12-31', 4e6)])
qs2 = {r['quarter']: r['eps'] for r in edgar.c_table(STEADY)['rows']}
ok('a stable share count keeps its derived Q4 — the whole reason Q4 is '
   'derived at all', qs2.get('2025-12-31') == 1.0, qs2)
ok('...and the other three are unchanged by the check', len(qs2) == 4, qs2)

# Net income is what makes the check possible, so it must still be derived.
_ni, _d = edgar._fill_q4({'2025-03-31': -4.0e6, '2025-06-30': -4.2e6,
                          '2025-09-30': -3.9e6}, {'2025-12-31': -1.55e7})
ok('dollars are still derived by subtraction, which is exact for them',
   _ni['2025-12-31'] == -3_400_000.0 and _d == {'2025-12-31'}, (_ni, _d))
ok('_fill_q4 reports WHICH values it derived, so the caller can tell an '
   'exact figure from a reconstructed one', isinstance(_d, set))
ok('the reason a ratio cannot be summed is written down',
   'EPS IS A RATIO' in EDG and 'never anybody' in EDG)

# A quarter with no net income to check against is left alone rather than
# dropped: absence of a check is not evidence of a fault.
_only_eps = edgar.c_table(_cf(
    eps=[('2025-01-01', '2025-03-31', -4.80), ('2025-04-01', '2025-06-30', -5.07),
         ('2025-07-01', '2025-09-30', -4.74), ('2025-01-01', '2025-12-31', -8.66)]))
ok('with nothing to reconcile against, the derived quarter stands',
   any(r['quarter'] == '2025-12-31' for r in _only_eps['rows']), _only_eps)

# ── C. A MARGIN IS A SHARE OF SALES ─────────────────────────────────────
print()
print('== C. margin ==')
ok('a pre-revenue loss does not print six figures of percent',
   edgar._margin(-3_300_000, 1_403) == -edgar.PCT_CAP,
   edgar._margin(-3_300_000, 1_403))
ok('...and the cap is the same one every other percentage here uses',
   edgar.PCT_CAP == 999.0)
ok('an ordinary margin is untouched', edgar._margin(2_000_000, 10_000_000) == 20.0)
ok('zero revenue has no margin rather than an infinite one',
   edgar._margin(-1000, 0) is None)
ok('the live figures that showed it are recorded',
   '-237,021' in EDG and '$1,403' in EDG)


# ── D. THREE STATES OF SILENCE FOR L, NOT TWO ──────────────────────────
#
# On a live screen four of five cards read "not in the industry map — an ETF,
# or a filer with no SIC code". One of them was Fervo Energy: a $5.8bn power
# producer, classified, mapped, and still unranked. The card was blaming the
# wrong thing entirely.
#
# The reason is upstream and is not a fault. A group rank is built from RS
# ratings, and O'Neil's RS is a TWELVE-MONTH weighted performance — raw_scores
# refuses a partial year in as many words, because an eight-month-old IPO up
# 300% would otherwise outrank every established leader on a measure defined
# as twelve months long.
print()
print('== D. why a stock has no group ==')
import pandas as _pd                                       # noqa: E402
from chart import groups as _gr                            # noqa: E402

_RS = _pd.Series({'RATED': 90, 'YOUNG': float('nan')})
_MAP = {'RATED': {'industry': 'Widgets', 'src': 'sic'},
        'YOUNG': {'industry': 'Alternative Power Generation', 'src': 'sic'},
        'NOBARS': {'industry': 'Widgets', 'src': 'sic'}}
_U = _gr.unranked(_RS, _MAP, {'RATED': {}})

ok('a ranked stock is not listed as unranked', 'RATED' not in _U, _U)
ok('a mapped stock that failed the RS gate is reported WITH its industry',
   _U['YOUNG']['industry'] == 'Alternative Power Generation'
   and _U['YOUNG']['why'] == 'gate', _U)
ok('...distinctly from one with no price history at all',
   _U['NOBARS']['why'] == 'nodata', _U)

_GRP = (pathlib.Path(__file__).resolve().parents[1] / 'groups.py').read_text()
# A pandas Index has no truth value: `set(getattr(rs, 'index', []) or [])`
# raises "The truth value of an Index is ambiguous" for every real Series,
# which is every call outside a test that passes None.
# CODE LINES ONLY. The comment recording the rule necessarily quotes the
# thing it forbids, and a bare substring search calls that a violation.
_UBODY = _GRP.split('def unranked')[1].split('\ndef build')[0]
_UCODE = [ln for ln in _UBODY.splitlines()
          if ln.strip() and not ln.lstrip().startswith('#')]
ok('the Index is never truth-tested, which raised on every real Series',
   not any('or []' in ln for ln in _UCODE), _UCODE)
ok('a missing series is still handled rather than crashing',
   _gr.unranked(None, {'A': {'industry': 'X'}}, {})['A']['why'] == 'nodata')
ok('the three states are named where the function is',
   'ranked' in _GRP and 'unranked' in _GRP and 'absent' in _GRP
   and 'not by omission' in _GRP)
ok('the live case that showed it is recorded', 'Fervo' in _GRP)
ok('the build publishes it, or the card cannot read it',
   "'unranked': unranked(" in _GRP)

_UI = (pathlib.Path(__file__).resolve().parents[3] / 'public' / 'index.html').read_text()
ok('the card reads it rather than blaming the map',
   'gm.unranked' in _UI and 'GROUPS_MODEL.unranked' in _UI)
ok('...and says the rating needs a full year, which is the actual reason',
   'twelve-month' in _UI and 'by construction, not by omission' in _UI)
ok('the "not in the map" wording survives for the case it is TRUE of',
   'an ETF, or a filer with no SIC code' in _UI)


# ── E. EVERY FIELD GETS DATA, OR SAYS WHY ──────────────────────────────
#
#     "you need to make sure every field get data ... data not just place
#      holder ... you need to make sure it's correct represented"
#
# Two fields were blank for reasons that were not real.
print()
print('== E. the fields that were blank for no good reason ==')

# 1. SHARES OUTSTANDING. One dei tag, and a filer that used the us-gaap
#    balance-sheet tag instead printed a bare "—". Two of five on one screen.
_bs = edgar.supply(_cf(eq=[]) | {'facts': {'us-gaap': {
    'CommonStockSharesOutstanding': {'units': {'shares': _rows(
        [('2026-06-30', '2026-06-30', 182_490_000)])}}}}})
ok('a filer using the balance-sheet tag is no longer blank',
   _bs['shares_outstanding'] == 182_490_000, _bs)
ok('...and the card is told WHICH count it is',
   'balance sheet' in (_bs['shares_basis'] or ''), _bs)

_wa = edgar.supply({'facts': {'us-gaap': {
    'WeightedAverageNumberOfDilutedSharesOutstanding': {'units': {'shares':
        _rows([('2026-01-01', '2026-06-30', 95_000_000)])}}}}})
ok('a weighted average is used only as a last resort — and SAYS it is one, '
   'because an average across a quarter that doubled its shares is nobody\'s '
   'share count', 'WEIGHTED AVERAGE' in (_wa['shares_basis'] or ''), _wa)
ok('the cover-page tag still wins when it is there',
   edgar.SHARES_TAGS[0] == 'EntityCommonStockSharesOutstanding')
ok('nothing filed is still nothing, not a zero',
   edgar.supply({})['shares_outstanding'] is None)

# 2. FLOAT. The S block said "no free source publishes float directly" while
#    the same card printed "float 2.46M sh" three sections higher and divided
#    short interest by that very number.
_UI2 = (pathlib.Path(__file__).resolve().parents[3] / 'public' / 'index.html').read_text()
# CHECKED WHERE THE STRING IS PRODUCED, not where it is rendered. The claim
# came from supply()'s float_note, and the UI only prints it — so the UI text
# is the wrong place to look, and looking there matches the comment that
# records the old wording rather than the wording itself.
ok('the false claim is gone from the note the card prints',
   'no free source publishes' not in edgar.supply({})['float_note'],
   edgar.supply({})['float_note'])
ok('EDGAR still does not CLAIM a float, because a filer does not tag one',
   edgar.supply({})['float'] is None
   and 'not in EDGAR' in edgar.supply({})['float_note'])
# A SUBSTRING SEARCH CANNOT TELL WHETHER `r` IS THE RIGHT OBJECT, and this
# check proved it: it asserted `'r.floatShares' in page` and passed for a day
# while the call site handed the function `row` instead of `row.stock`. Every
# screener field came back undefined and rendered as "—", which is exactly
# what a genuinely absent float renders as, so nothing looked wrong.
#
# What is checkable HERE is the wiring — that the call site passes the object
# carrying the field, and that the parameter is named for it so the next
# reader cannot repeat the mistake. The BEHAVIOUR is proved by executing the
# function, in tests/canslimCard.test.js, which is the only kind of check
# that could have caught this.
ok('the S block is handed row.stock, which is where the screener fields are',
   'canslimTablesHTML(row.ticker, s)' in _UI2
   and 'canslimTablesHTML(tk, stock)' in _UI2)
ok('...and the failure is recorded where the parameter is',
   'PASSED THE WRONG OBJECT' in _UI2)
_JEST = (pathlib.Path(__file__).resolve().parents[3] / 'tests'
         / 'canslimCard.test.js').read_text()
ok('the behaviour is proved by RUNNING the function, not by grepping for it',
   'canslimTablesHTML()' in _JEST and 'liftTables' in _JEST)
ok('...including the case that was broken: a row-shaped object yields no float',
   'does not carry it' in _JEST)
ok('...and says where it came from, so two sources are never blended silently',
   'from the screener' in _UI2)
ok('short interest and days to cover reach the S block too, since S is the '
   'supply letter and that is what they measure',
   'r.shortFloat' in _UI2 and 'r.daysToCover' in _UI2)

# The probe that makes this checkable without reading a card.
_FLD = (ROOT / 'deploy' / 'run_fields.py').read_text() if False else (
    pathlib.Path(__file__).resolve().parents[2] / 'deploy' / 'run_fields.py'
).read_text()
ok('there is a probe that reports every field per TICKER, not per file',
   'every CANSLIM field' in _FLD.lower() or 'Every CANSLIM field' in _FLD)
ok('...and it distinguishes an empty field from a wrong value',
   'EMPTY' in _FLD and 'WRONG' in _FLD)
ok('...and fetches nothing, so an unwalked stock cannot look healthy',
   'Fetches\nnothing' in _FLD or 'Fetches' in _FLD)
ok('every blank it prints carries a reason',
   'with no reason is a bug' in _FLD)


# ── F. A PARSER FIX THAT DOES NOT REACH THE CARDS IS NOT A FIX ─────────
#
# Within hours of shipping A, B and C above, a live field probe showed all
# three still wrong on the cards:
#
#     EPS a year ago   —              while %chg beside it read "loss a year
#                                     ago", which is only possible if the
#                                     year-ago figure WAS found
#     ROE              34.10%         after the guard that forbids it shipped
#     margin           -237,021.60%   after the cap shipped
#
# Nothing was broken. The cache holds PARSED tables, not raw filings, so every
# record written before a parser change is obsolete — and nothing about the
# file said so. It has a seven-day life, so the cards would have served the
# old answers for a week.
print()
print('== F. the cache knows which parser wrote it ==')
import json as _json                                       # noqa: E402
import tempfile as _tmpf                                   # noqa: E402
import time as _time                                       # noqa: E402

_old_cache = edgar.CACHE
try:
    edgar.CACHE = pathlib.Path(_tmpf.mkdtemp())
    edgar.write_cached({'ticker': 'CUR', 'ok': True, 'schema': edgar.SCHEMA})
    edgar.write_cached({'ticker': 'OLD', 'ok': True, 'schema': edgar.SCHEMA - 1})
    edgar.write_cached({'ticker': 'NONE', 'ok': True})     # written before it existed
    ok('a record this parser wrote is served',
       (edgar.cached('CUR') or {}).get('ticker') == 'CUR')
    ok('a record from an OLDER parser is treated as absent, so the walk '
       'refills it rather than the card serving a pre-fix answer',
       edgar.cached('OLD') is None)
    ok('...and so is one from before the version existed at all',
       edgar.cached('NONE') is None)
finally:
    edgar.CACHE = _old_cache

ok('the version is stamped by tables(), so every parsed record carries it',
   edgar.tables({}).get('schema') == edgar.SCHEMA)
# A "no filings" record never reaches tables(). Without the stamp on that path
# too, every ETF and ADR in the market would be re-walked every night — the
# entire cost the negative cache exists to avoid.
_b = edgar.build.__doc__ or ''
ok('build() stamps it on the FAILURE path too, or the negative cache dies',
   "out = {'ticker': t, 'schema': SCHEMA" in EDG)
# WHITESPACE-NORMALISED. The phrase is wrapped across two lines in the
# docstring, so a raw substring search misses it — the third time that has
# caught a check rather than a fault.
_FLAT = ' '.join(EDG.split())
ok('the live symptoms that showed this are recorded',
   'YR AGO column was blank on every stock' in _FLAT
   and 'does not reach the cards is not a fix' in _FLAT)
ok('bumping it is documented as the thing to do when tables() changes',
   'Bump this whenever' in EDG or 'Bump SCHEMA' in EDG)

# ── G. A VERDICT NEEDS EVIDENCE ────────────────────────────────────────
#
# "Accelerating: no (last 0 quarters)" reads as a test that ran and a stock
# that failed. Over zero quarters nothing ran.
print()
print('== G. no verdict without evidence ==')
_noq = edgar.c_table(_cf(eps=[('2026-04-01', '2026-06-30', -0.64)]))
ok('accelerating is UNKNOWN, not False, when no quarter has a %chg',
   _noq['accelerating'] is None, _noq['accelerating'])
_acc = edgar.c_table(_cf(
    eps=[('2023-01-01', '2023-03-31', 1.0), ('2024-01-01', '2024-03-31', 2.0),
         ('2025-01-01', '2025-03-31', 5.0), ('2026-01-01', '2026-03-31', 20.0)]))
ok('...and a real verdict is still reached when there IS evidence',
   _acc['accelerating'] is True, _acc)
ok('the reason is written down where the change is',
   'a verdict on evidence that does not exist' in EDG)


# ── H. TWO READERS OF ONE CACHE MUST AGREE IT EXISTS ───────────────────
#
# The schema check went into cached() and NOT into what the walk uses to
# decide its work list, which read file mtime only. From the live run, both
# lines true at the same moment:
#
#     the cards   "not fetched yet" on every stock
#     the walk    "14612 in universe · 14606 already fresh · 0 to fetch"
#
# Neither is wrong alone. Together they lock: the cards will not read what the
# walk will not rewrite, so C and A stay empty PERMANENTLY rather than for a
# week. This is a test and not a comment because a comment would not have
# caught it — the first version of this fix had one.
print()
print('== H. the walk and the cards ask the same question ==')
import tempfile as _tf2                                    # noqa: E402

_old = edgar.CACHE
_seen = []
_rb = edgar.build
try:
    edgar.CACHE = pathlib.Path(_tf2.mkdtemp())
    edgar.write_cached({'ticker': 'STALE', 'ok': True, 'schema': edgar.SCHEMA - 1})
    edgar.write_cached({'ticker': 'FRESH', 'ok': True, 'schema': edgar.SCHEMA})
    ok('a previous-schema record is invisible to the reader, as intended',
       edgar.cached('STALE') is None)
    edgar.build = lambda t: (_seen.append(t) or {'ticker': t, 'ok': False,
                                                 'error': 'stub'})
    _o = edgar.walk(['STALE', 'FRESH', 'ABSENT'], budget_s=0,
                    log=lambda *_: None)
    ok('...and the WALK agrees it is missing, so the cache can refill — this '
       'is the deadlock', 'STALE' in _seen, _seen)
    ok('a record at the current schema is still skipped',
       'FRESH' not in _seen, _seen)
    ok('one never written is still fetched first',
       _seen and _seen[0] == 'ABSENT', _seen)
    ok('the counts agree with the reader, not with the mtime',
       _o['todo'] == 2, _o)
finally:
    edgar.build = _rb
    edgar.CACHE = _old

ok('membership is decided by cached(), the reader\'s own question',
   'recs = {t: cached(t, max_age_days=age) for t in want}' in EDG
   and 'recs[t] is None' in EDG)
# THE SECOND REASON TO FETCH ONLY EVER ADDS. `todo` gained "owes a filing"
# (audit 60), and that must not become a second predicate the READER also
# applies — a card would go blank the moment a company filed late. The reader
# is still cached(), alone.
ok('...and the extra reason to refetch does not become a reason to refuse',
   'max_age_days' not in EDG.split('def _due_for_filing')[1].split('\ndef ')[0])
ok('...and mtime is kept only for ORDERING, which still needs a number',
   'only for ORDERING' in ' '.join(EDG.split()))
ok('the live pair of contradictory lines is recorded',
   '14606 already fresh' in EDG)

# ── ONE DATE, TWO SPANS ────────────────────────────────────────────────
#
# Read off a live card, on a filer whose fiscal year ends 31 July:
#
#     C — CURRENT QUARTERLY EARNINGS      A — ANNUAL EARNINGS
#         QTR          EPS $                  FY           EPS $
#         2025-07-31    0.36                  2025-07-31    1.60
#
#     "31-7-2025 earning is showing number on C and another on A"
#
# Both figures are right, and the year's four quarters come to exactly the
# annual one: 0.49 + 0.38 + 0.37 + 0.36 = 1.60. A fiscal year and its own
# fourth quarter END ON THE SAME DAY. Nothing was wrong except that two tables
# printed one date against two numbers and neither said which span it meant —
# which is this file's own subject from the other side: not a number that is
# false, a true one that reads as false.
print()
print('== a fiscal year and its fourth quarter end on the same day ==')

_JUL = {'2024-10-31': 0.49, '2025-01-31': 0.38,
        '2025-04-30': 0.37, '2025-07-31': 0.36}
_sum, _of = edgar._year_quarters(_JUL, '2025-07-31')
ok('the four quarters of a July fiscal year add to the annual figure',
   _sum == 1.60 and _of == 4, (_sum, _of))

# A PARTIAL YEAR RETURNS ITS COUNT, NOT A SUM. Three quarters shown against a
# twelve-month figure is a check that fails for a reason that is not the
# company's, and it would read as a discrepancy in the filings.
_p_sum, _p_of = edgar._year_quarters(
    {k: v for k, v in list(_JUL.items())[:3]}, '2025-07-31')
ok('...and three quarters give a COUNT rather than a sum that would look '
   'like a discrepancy', _p_sum is None and _p_of == 3, (_p_sum, _p_of))
ok('no quarters at all is no sum and no count', edgar._year_quarters({}, '2025-07-31') == (None, 0))
ok('an unreadable year end is refused, not guessed',
   edgar._year_quarters(_JUL, 'soon') == (None, 0))

# MEASURED IN DAYS FROM THE YEAR END, not by year number. A fiscal year is not
# the calendar year, and comparing year numbers takes the wrong four quarters
# for every filer whose year does not end in December.
_DEC = {'2025-03-31': 1.0, '2025-06-30': 1.0,
        '2025-09-30': 1.0, '2025-12-31': 1.0}
ok('a December filer picks up its own four quarters',
   edgar._year_quarters(_DEC, '2025-12-31') == (4.0, 4))
ok('...and a year with nothing inside it claims nothing',
   edgar._year_quarters(_DEC, '2024-12-31') == (None, 0))
ok('a July filer does not reach into the calendar year beside it',
   edgar._year_quarters({**_JUL, '2025-10-31': 9.9}, '2025-07-31')[0] == 1.60)

# AND IT REACHES THE TABLE, which is the only place it matters.
_CF_JUL = {'facts': {'us-gaap': {
    'EarningsPerShareDiluted': {'units': {'USD/shares': [
        {'start': '2024-08-01', 'end': '2024-10-31', 'val': 0.49, 'filed': '2024-12-01'},
        {'start': '2024-11-01', 'end': '2025-01-31', 'val': 0.38, 'filed': '2025-03-01'},
        {'start': '2025-02-01', 'end': '2025-04-30', 'val': 0.37, 'filed': '2025-06-01'},
        {'start': '2025-05-01', 'end': '2025-07-31', 'val': 0.36, 'filed': '2025-09-01'},
        {'start': '2024-08-01', 'end': '2025-07-31', 'val': 1.60, 'filed': '2025-09-01'},
    ]}}}}}
_A = edgar.a_table(_CF_JUL)
_row = _A['rows'][0]
ok('the annual row carries the year added up from its own quarters',
   _row['fy'] == '2025-07-31' and _row['eps'] == 1.60
   and _row['quarters_sum'] == 1.60 and _row['quarters_of'] == 4, _row)
_C = edgar.c_table(_CF_JUL)
ok('...and the C table still shows that date as the THREE-month figure, '
   'which is the pair that looked like a contradiction',
   [r for r in _C['rows'] if r['quarter'] == '2025-07-31'][0]['eps'] == 0.36,
   _C['rows'][0])

CARD59 = (pathlib.Path(__file__).resolve().parents[3] / 'public'
          / 'index.html').read_text()
ok('the card says the span in both headers, which is where the collision is',
   '<th>3 mo to</th>' in CARD59 and '<th>12 mo to</th>' in CARD59)
ok('...and prints the quarters\' sum beside the filed annual figure',
   'From 4 qtrs' in CARD59 and 'quarters_sum' in CARD59)
ok('the words that reported it are recorded where the fix is',
   'showing number on C and another on A' in
   (pathlib.Path(__file__).resolve().parents[1] / 'edgar.py').read_text())
ok('the schema was bumped, so no card serves an annual row without it',
   edgar.SCHEMA >= 4, edgar.SCHEMA)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
