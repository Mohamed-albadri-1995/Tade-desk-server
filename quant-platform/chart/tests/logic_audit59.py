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

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
