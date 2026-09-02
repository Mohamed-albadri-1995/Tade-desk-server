"""Audit 60 — history to compare against, and the newest data to compare.

    "we need the history to compare and check the progress but we need the
     most recent data keep this in mind in all CANSLIM related data not just
     this one"

Said about 13F and meant about all of it, so it is written down here as a rule
over every letter rather than as a fix to one.

TWO REQUIREMENTS THAT PULL AGAINST EACH OTHER, and each one alone is useless:

  HISTORY      A single reading is a fact and not a judgement. "EPS 1.42" is
               not growth, "94M shares" is not a buyback, "312 funds" is not
               sponsorship. Every one of them becomes a signal only when it is
               set beside the same measurement earlier, and CANSLIM is almost
               entirely a set of such comparisons — C against the same quarter
               a year back, A across five years, I across four quarters, L
               against a rank a quarter ago.

  RECENCY      And the comparison has to END at today. A perfectly kept
               five-year history whose last point is four months old describes
               a company that no longer exists, and it does it convincingly,
               with a chart.

The failure that prompted this had both halves at once: 13F had four quarters
of history, correctly counted, every one of them labelled a quarter too new.
The history was real and the reading of it was wrong.

So the two questions asked of every letter here are: what does it compare
against, and how does it learn that something newer exists.
"""

import datetime as dt
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import edgar, f13, groups, oneil               # noqa: E402

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


EDG = (pathlib.Path(__file__).resolve().parents[1] / 'edgar.py').read_text()
F13 = (pathlib.Path(__file__).resolve().parents[1] / 'f13.py').read_text()
CARD = (pathlib.Path(__file__).resolve().parents[3] / 'public'
        / 'index.html').read_text()


# ── 1. EVERY LETTER COMPARES AGAINST SOMETHING ─────────────────────────
print('== what each letter compares against ==')

ok('C keeps eight quarters, which is two years — enough that one bad quarter '
   'is a dip and not a trend',
   'def c_table(cf: dict, quarters: int = 8)' in EDG)
ok('...and each row carries the SAME quarter a year earlier, on the row, so '
   'the comparison is visible and not just its result',
   "'eps_yr_ago': eps_then" in EDG and "'sales_yr_ago': rev_then" in EDG)
ok('A keeps five years', 'def a_table(cf: dict, years: int = 5)' in EDG)
ok('I keeps four quarters, which is a year',
   'QUARTERS = int(os.environ.get' in F13 and "or 4)" in F13)
ok('L compares the group against its own rank a quarter back',
   groups.ROTATION_SESSIONS == 63, groups.ROTATION_SESSIONS)
ok('M counts distribution over a rolling 25 sessions, so it changes on a day '
   'the market does nothing', "'value': 25," in
   (pathlib.Path(__file__).resolve().parents[1] / 'oneil.py').read_text())

# S WAS THE ONE LETTER WITH NO HISTORY AT ALL. It printed a share count and
# stopped, which is the exact shape this rule is against: O'Neil does not read
# "how many shares", he reads whether the number is shrinking.
_CF = {'facts': {'dei': {'EntityCommonStockSharesOutstanding': {'units': {
    'shares': [
        {'end': '2024-06-30', 'val': 105_000_000, 'filed': '2024-08-01'},
        {'end': '2024-12-31', 'val': 102_000_000, 'filed': '2025-02-01'},
        {'end': '2025-06-30', 'val': 100_000_000, 'filed': '2025-08-01'},
        {'end': '2026-06-30', 'val': 94_000_000, 'filed': '2026-08-01'},
    ]}}}}}
_S = edgar.supply(_CF)
ok('S now keeps the share counts it has, not only the newest',
   len(_S['shares_history']) == 4, _S['shares_history'])
ok('...and reports the change over about a year, which is the only form in '
   'which a share count says anything',
   _S['shares_chg_1y']['pct'] == -6.0, _S['shares_chg_1y'])
ok('...against the count closest to a year back, not against the oldest one '
   'on file — a two-year change is not an annual rate',
   _S['shares_chg_1y']['from'] == '2025-06-30', _S['shares_chg_1y'])
ok('...and it says which two figures it used, so the number can be checked',
   _S['shares_chg_1y']['from_val'] == 100_000_000
   and _S['shares_chg_1y']['to_val'] == 94_000_000, _S['shares_chg_1y'])
ok('the card prints the direction, not only the count',
   'Share count' in CARD and 'shares_chg_1y' in CARD)
ok('...and names it: a shrinking count is a buyback and a growing one is '
   'dilution', 'buying back' in CARD and 'diluting' in CARD)


# ── 2. AND THE COMPARISON MUST NOT BE BUILT OUT OF UNLIKE THINGS ───────
#
# The share count is filed under five different tags, two of which are
# WEIGHTED AVERAGES over a period rather than a count on a date. Reading the
# newest under one tag against last year's under another gives a difference
# that is entirely the measurement — a manufactured buyback, from real data,
# with both figures correct.
print()
print('== a comparison is only as good as its two ends ==')

_MIXED = {'facts': {
    'dei': {'EntityCommonStockSharesOutstanding': {'units': {'shares': [
        {'end': '2026-06-30', 'val': 94_000_000, 'filed': '2026-08-01'}]}}},
    'us-gaap': {'WeightedAverageNumberOfDilutedSharesOutstanding': {'units': {
        'shares': [{'start': '2025-04-01', 'end': '2025-06-30',
                    'val': 130_000_000, 'filed': '2025-08-01'}]}}}}}
_M = edgar.supply(_MIXED)
ok('a weighted average is not compared against a cover-page count, however '
   'neatly the dates line up', _M['shares_chg_1y'] is None, _M['shares_chg_1y'])
ok('...and the headline figure still comes through',
   _M['shares_outstanding'] == 94_000_000, _M)
ok('the history is from the SAME tag as the headline figure',
   [p['end'] for p in _M['shares_history']] == ['2026-06-30'],
   _M['shares_history'])

_SHORT = edgar.supply({'facts': {'dei': {
    'EntityCommonStockSharesOutstanding': {'units': {'shares': [
        {'end': '2026-03-31', 'val': 100_000_000, 'filed': '2026-05-01'},
        {'end': '2026-06-30', 'val': 94_000_000, 'filed': '2026-08-01'}]}}}}})
ok('two counts one quarter apart give NO annual change — a 3-month move is '
   'not a year\'s', _SHORT['shares_chg_1y'] is None, _SHORT['shares_chg_1y'])
ok('...and the card says which reason it is, because "no comparison yet" and '
   '"no data" are different facts about different companies',
   'too bunched to give a rate' in CARD and 'only one count on file' in CARD)

ok('a zero or negative base is refused, as everywhere else in this module',
   edgar._shares_change([{'end': '2025-06-30', 'val': 0},
                         {'end': '2026-06-30', 'val': 5}]) is None)


# ── 3. AND THE NEWEST END OF THE HISTORY IS ACTUALLY NEW ───────────────
#
# A cache with a TTL is a clock, and a clock knows nothing about earnings. A
# company that reports on the first morning of its five-day window showed the
# PREVIOUS quarter for the following five days — and the day it reports is the
# day C changes and the day the card is worth opening.
print()
print('== how each letter learns that something newer exists ==')

_REC = {'c': {'rows': [{'quarter': '2026-03-31'}, {'quarter': '2026-06-30'}]}}
ok('a company whose last quarter ended nine weeks ago owes nothing',
   edgar._due_for_filing(_REC, dt.date(2026, 9, 2)) is False)
ok('...and once the next quarter is filed-and-then-some, it does',
   edgar._due_for_filing(_REC, dt.date(2026, 11, 20)) is True)
# MEASURED FROM THE COMPANY'S OWN QUARTER, NOT FROM THE CALENDAR. A filer
# whose year ends in January has quarters ending Jan/Apr/Jul/Oct; judged
# against 31 March it would be "late" four times a year for being itself.
ok('a fiscal-year filer is judged on its own quarter ends',
   edgar._due_for_filing({'c': {'rows': [{'quarter': '2026-07-31'}]}},
                         dt.date(2026, 9, 2)) is False)
ok('a record stuck a quarter behind is due, however young the FILE is',
   edgar._due_for_filing({'c': {'rows': [{'quarter': '2026-03-31'}]}},
                         dt.date(2026, 9, 2)) is True)
ok('a company with no quarters at all is not "late" — that is the no-filings '
   'case and it is already cached as such',
   edgar._due_for_filing({'c': {'rows': []}}) is False)
ok('an unparseable date is not a reason to refetch every night forever',
   edgar._due_for_filing({'c': {'rows': [{'quarter': 'soon'}]}}) is False)

ok('the walk fetches on either reason — rejected by the reader, OR owing a '
   'filing', 'recs[t] is None or t in due' in EDG)
# AND IT ONLY EVER ADDS WORK. If `cached()` also refused a record that owed a
# filing, a card would go BLANK the moment a company was a week late — the
# same deadlock as audit 59, entered from the other side.
ok('...and the READER is not made to reject it, so a late filer keeps showing '
   'the last quarter it did file', 'Only ever ADDS work' in EDG)
ok('the reason a due record still renders is written down where it is decided',
   'arrived at from the other side' in EDG)
ok('the log says how many owe a filing, so a night of them is visible',
   'owe a filing' in EDG)

# I — the listing is read every run, so a newly published quarter is picked up
# the first night after it appears rather than whenever a pattern is guessed.
ok('I re-reads the SEC listing on every run', 'One page fetch per run' in F13)
ok('...and slides its window to the newest quarters that exist, instead of '
   'silently returning a shorter history', 'SOME, NOT NONE' in F13)
ok('...and dates each file by what it REPORTS, not by when it arrived',
   f13._quarter_of('01mar2026-31may2026_form13f.zip') == (2026, 1))
ok('the quarters used are published with the file, so the card cannot show '
   'stale sponsorship undated', "'quarters': [f'{y}Q{q}'" in F13)

# ── 4. AND THE CHECKER HAS TO SEE THE FIELDS IT IS CHECKING ────────────
#
# deploy/run_fields.py is the tool that answers "does this STOCK have a number
# in this field", which is the question a card raises. A field it does not
# print reads as a clean bill of health, so every new field has to reach it or
# the check quietly narrows while looking unchanged.
#
# It would not have caught either of the last two faults. It printed the share
# count with nothing to compare it to, and it printed 13F's holders, change
# and direction — all three CORRECT, and all three about the wrong quarters.
print()
print('== the field checker covers the fields ==')

FIELDS = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
          / 'run_fields.py').read_text()
ok('S\'s share-count direction is checked, not only the count',
   "'share count 1yr'" in FIELDS and 'shares_chg_1y' in FIELDS)
ok('...with both figures and both dates, so the percentage can be checked on '
   'its own line', "_sc['from_val']" in FIELDS and "_sc['to_val']" in FIELDS
   and "_sc['days']" in FIELDS)
ok('...and a blank names which reason it is',
   'only one count on file' in FIELDS and 'no pair 290-440 days apart'
   in FIELDS)
ok('I reports WHICH QUARTERS, the field that was wrong all along',
   "'quarters'" in FIELDS and "add('I', 'quarters'" in FIELDS)
ok('...and says when the window slid, so a fallback is visible here too',
   "'fell_back'" in FIELDS)
ok('the reason this line exists is recorded beside it',
   'correct ABOUT THE WRONG QUARTERS' in FIELDS)

DAILY = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
         / 'run_daily.py').read_text()
ok('nothing in the chain is built once and left', 'NOTHING HERE IS BUILT '
   'ONCE' in DAILY)
ok('...and the reason each link goes stale on its own clock is written down',
   'each goes stale on its own clock' in DAILY)
for letter in ('rs universe top-up', 'market model (M)',
               'institutional sponsorship (I)', 'group ranks (L)',
               'earnings tables (C, A)'):
    ok(f'  {letter} is rebuilt every night', f"'{letter}'" in DAILY)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
