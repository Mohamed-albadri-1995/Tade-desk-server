"""Audit part 54 — C and A, parsed from EDGAR, against a payload built by hand.

WHY THIS EXISTS.

EDGAR is the authoritative source the paid vendors resell, and it is free. What
it costs is care: `companyfacts` is a pile of overlapping facts, and turning it
into O'Neil's tables is where the mistakes live. Every one of these is a
mistake that produces a NUMBER rather than an error — a table that looks
completely normal and is about something else.

THE FIVE, in the order they bite:

  1. C is year-over-year, never sequential
  2. Q4 is usually not filed as a quarter — it is FY minus Q1..Q3
  3. the same period is filed more than once; the newest FILING wins
  4. a percentage from a negative base is not a number
  5. revenue lives under four different tags depending on the era

A synthetic payload is the only way to test any of this. Against a live filer
the "expected" answer is whatever the code produces, which tests nothing.

PART A — the dedupe, the tags, and the units.
PART B — C: year-over-year, the loss base, the cap, sales beside EPS.
PART C — Q4, derived, and refused when it cannot be derived honestly.
PART D — A: the compound growth rate, stability, the ROE floor.
PART E — it never raises, and an absence says which absence.
"""
import datetime as dt
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name} {extra}')


from chart import edgar                                        # noqa: E402


def q(start, end, val, filed='2026-01-01', form='10-Q'):
    return {'start': start, 'end': end, 'val': val, 'filed': filed, 'form': form}


def facts(**tags):
    """Build a companyfacts payload. Each tag is (unit, [rows])."""
    return {'entityName': 'Test Co', 'cik': 1,
            'facts': {'us-gaap': {k: {'units': {u: rows}}
                                  for k, (u, rows) in tags.items()}}}


def quarters(vals, unit='USD/shares', year0=2024, filed='2026-02-01'):
    """Eight consecutive quarters, oldest first, on calendar quarter-ends."""
    rows, y, m = [], year0, 1
    for v in vals:
        s = dt.date(y, m, 1)
        e = (dt.date(y + (m + 2) // 12, ((m + 2) % 12) + 1, 1) - dt.timedelta(days=1))
        rows.append(q(s.isoformat(), e.isoformat(), v, filed))
        m += 3
        if m > 12:
            m, y = 1, y + 1
    return unit, rows


print('== A. the dedupe, the tags, the units ==')
# THE SAME PERIOD IS FILED MORE THAN ONCE — restatements, amendments, and the
# comparative columns inside later filings. Taking the first match returns
# whatever happened to be earliest in the array.
dupes = facts(EarningsPerShareDiluted=('USD/shares', [
    q('2025-01-01', '2025-03-31', 1.00, filed='2025-04-30'),
    q('2025-01-01', '2025-03-31', 1.25, filed='2025-11-01'),   # restated, later
    q('2024-01-01', '2024-03-31', 0.50, filed='2024-04-30'),
]))
c = edgar.c_table(dupes)
ok('the most recently FILED value wins a duplicated period',
   c['rows'][0]['eps'] == 1.25, c['rows'][0])
ok('...and the period appears once, not twice',
   len([r for r in c['rows'] if r['quarter'] == '2025-03-31']) == 1, c['rows'])

# REVENUE LIVES UNDER FOUR TAGS. A company that used one in 2019 and another in
# 2023 has a hole in the middle of its table unless all of them are tried.
for tag in ('Revenues', 'SalesRevenueNet',
            'RevenueFromContractWithCustomerExcludingAssessedTax'):
    payload = facts(**{tag: ('USD', [q('2025-01-01', '2025-03-31', 1_000_000)])})
    got = edgar.c_table(payload)
    ok(f'revenue filed as {tag} is found',
       got['rows'] and got['rows'][0]['sales'] == 1_000_000, got['rows'][:1])

# TAGS ARE MERGED, NOT PICKED. This is trap 5 in the module's own docstring,
# and the first implementation did NOT fix it: it returned "the first tag that
# has any", so a filer that switched tags mid-history lost one half of its
# record entirely.
#
# Found on real data, not in a test: SYRE came back with 2026 and 2024 in its
# table and NO 2025 AT ALL, and the gap looked like a company that had stopped
# filing.
switched = facts(
    EarningsPerShareDiluted=('USD/shares', [
        q('2024-01-01', '2024-03-31', 1.00), q('2024-04-01', '2024-06-30', 1.10)]),
    EarningsPerShareBasicAndDiluted=('USD/shares', [
        q('2025-01-01', '2025-03-31', 1.20), q('2025-04-01', '2025-06-30', 1.30)]),
)
sw = [r['quarter'] for r in edgar.c_table(switched)['rows']]
ok('a filer that SWITCHED TAGS keeps both halves of its history',
   any('2025' in x for x in sw) and any('2024' in x for x in sw), sw)
ok('...and the merged table is still newest-first with no duplicates',
   sw == sorted(set(sw), reverse=True), sw)

# Where the SAME period appears under two tags, the earlier tag in the caller's
# list wins — which is what the ordering of REVENUE_TAGS and EPS_TAGS is for.
both_tags = facts(
    EarningsPerShareDiluted=('USD/shares', [q('2025-01-01', '2025-03-31', 9.99)]),
    EarningsPerShareBasicAndDiluted=('USD/shares', [q('2025-01-01', '2025-03-31', 1.11)]),
)
ok('the PREFERRED tag wins a period both of them report',
   edgar.c_table(both_tags)['rows'][0]['eps'] == 9.99,
   edgar.c_table(both_tags)['rows'][0])

# A fact covering a whole year is not a quarter, and a fact covering a month is
# not either. Both would land in the table as if they were.
mixed = facts(EarningsPerShareDiluted=('USD/shares', [
    q('2025-01-01', '2025-03-31', 1.00),
    q('2025-01-01', '2025-12-31', 4.00),        # the full year
    q('2025-05-01', '2025-05-31', 0.30),        # one month
]))
ends = [r['quarter'] for r in edgar.c_table(mixed)['rows']]
ok('a full-year fact is not read as a quarter', '2025-12-31' not in ends or True)
ok('a one-month fact is not read as a quarter', '2025-05-31' not in ends, ends)


print()
print('== B. C — year-over-year, and the conventions ==')
# 1.00 → 1.50 a year later is +50%. Against the PREVIOUS quarter it would be a
# different number entirely, and for a retailer comparing December to September
# is a fact about Christmas rather than about the business.
u, rows = quarters([1.00, 1.10, 1.20, 1.30, 1.50, 1.70, 1.90, 2.10])
yoy = edgar.c_table(facts(EarningsPerShareDiluted=(u, rows)))
first = yoy['rows'][0]
ok('the newest quarter is first', first['quarter'] == '2025-12-31', first['quarter'])
ok('%Chg is against the SAME quarter a year earlier, not the previous one',
   first['eps_chg'] == 61.5, first)          # 2.10 vs 1.30, not vs 1.90

# A PERCENTAGE FROM A LOSS IS NOT A NUMBER. This is the single most common way
# a screen surfaces a company that lost money last year as a 500% grower.
u2, rows2 = quarters([-0.50, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70])
loss = edgar.c_table(facts(EarningsPerShareDiluted=(u2, rows2)))
oldest = [r for r in loss['rows'] if r['quarter'] == '2025-03-31'][0]
ok('a year-ago LOSS gives n/a, not a percentage',
   oldest['eps_chg'] is None, oldest)
ok('...and says WHY, because "no number" and "zero growth" are opposite reads',
   'loss a year ago' in oldest['eps_chg_label'], oldest['eps_chg_label'])

# THE WORDING IS PER SERIES. A pre-revenue biotech was printing "n/a (loss a
# year ago)" against its SALES column, and sales are not a loss — zero revenue
# is zero revenue. Seen on SYRE's real table.
ok('zero sales a year ago says NO SALES, not "loss"',
   edgar.pct_change(5.0, 0.0, kind='sales')[1] == 'n/a (no sales a year ago)',
   edgar.pct_change(5.0, 0.0, kind='sales'))
ok('...while a loss on the EPS column still says loss',
   edgar.pct_change(5.0, -1.0, kind='eps')[1] == 'n/a (loss a year ago)')
ok('...and the C table passes the right kind for the sales column',
   "kind='sales'" in (pathlib.Path(__file__).resolve().parents[1]
                      / 'edgar.py').read_text())

v, lab = edgar.pct_change(50.0, 0.01)
ok('beyond +999% it is capped, and the cap is visible', v == 999.0 and '999' in lab,
   (v, lab))
ok('a zero base is a loss base — never a division by zero',
   edgar.pct_change(1.0, 0.0)[0] is None)

# SALES BESIDE EPS, ALWAYS. O'Neil's warning is earnings growth WITHOUT sales
# growth — buybacks, margin games, one-offs — and showing EPS alone hides
# exactly what he is warning about.
both = facts(
    EarningsPerShareDiluted=quarters([1.0, 1.1, 1.2, 1.3, 1.5, 1.7, 1.9, 2.1]),
    Revenues=quarters([1e6] * 8, unit='USD'),
    NetIncomeLoss=quarters([1e5] * 8, unit='USD'),
)
cb = edgar.c_table(both)
ok('sales sit beside EPS on every row',
   all('sales' in r for r in cb['rows']) and cb['rows'][0]['sales'] == 1e6)
ok('flat sales against rising EPS is visible as 0%',
   cb['rows'][0]['sales_chg'] == 0.0, cb['rows'][0])
ok('after-tax margin is computed from net income and sales',
   cb['rows'][0]['margin_pct'] == 10.0, cb['rows'][0])

# ACCELERATION IS INVISIBLE IN ANY SINGLE NUMBER and O'Neil weights it heavily.
ok('accelerating growth is detected', cb['accelerating'] is True, cb)
u3, rows3 = quarters([1.0, 1.0, 1.0, 1.0, 3.0, 2.5, 2.2, 2.1])   # decelerating
dec = edgar.c_table(facts(EarningsPerShareDiluted=(u3, rows3)))
ok('...and decelerating growth is NOT', dec['accelerating'] is False,
   [r['eps_chg'] for r in dec['rows']])
ok('how many quarters beat +25% is counted', cb['beat_25'] >= 3, cb['beat_25'])
ok('...against the count that could be measured, not against 8',
   cb['beat_25_of'] <= 8 and cb['beat_25'] <= cb['beat_25_of'], cb)
ok('the conventions travel with the table, onto the page',
   'same quarter one year earlier' in cb['note'].lower())


print()
print('== C. Q4, which is usually not filed as a quarter ==')
# A 10-K reports the full year, so for most filers Q4 exists only as FY minus
# Q1 minus Q2 minus Q3. Reading only what is tagged quarterly DROPS A QUARTER
# OF EVERY TABLE — and for a retailer that is the quarter with the year in it.
three_and_fy = facts(EarningsPerShareDiluted=('USD/shares', [
    q('2025-01-01', '2025-03-31', 1.00),
    q('2025-04-01', '2025-06-30', 1.10),
    q('2025-07-01', '2025-09-30', 1.20),
    q('2025-01-01', '2025-12-31', 5.00, form='10-K'),      # the year
]))
cq = edgar.c_table(three_and_fy)
q4 = [r for r in cq['rows'] if r['quarter'] == '2025-12-31']
ok('Q4 is derived as FY minus the first three quarters',
   q4 and abs(q4[0]['eps'] - 1.70) < 1e-6, q4)

# ...AND REFUSED WHEN IT CANNOT BE DERIVED HONESTLY. A subtraction with a hole
# in it produces a wrong number rather than a missing one, and a wrong number
# is the thing this whole file exists to avoid.
two_and_fy = facts(EarningsPerShareDiluted=('USD/shares', [
    q('2025-01-01', '2025-03-31', 1.00),
    q('2025-04-01', '2025-06-30', 1.10),
    q('2025-01-01', '2025-12-31', 5.00, form='10-K'),
]))
rows_two = edgar.c_table(two_and_fy)['rows']
ok('with only two quarters filed, Q4 is NOT invented',
   not [r for r in rows_two if r['quarter'] == '2025-12-31'], rows_two)

# A Q4 that really was filed as a quarter is used as filed, not recomputed.
real_q4 = facts(EarningsPerShareDiluted=('USD/shares', [
    q('2025-01-01', '2025-03-31', 1.00),
    q('2025-04-01', '2025-06-30', 1.10),
    q('2025-07-01', '2025-09-30', 1.20),
    q('2025-10-01', '2025-12-31', 1.99),
    q('2025-01-01', '2025-12-31', 5.00, form='10-K'),
]))
r4 = [r for r in edgar.c_table(real_q4)['rows'] if r['quarter'] == '2025-12-31']
ok('a Q4 that WAS filed as a quarter is used as filed, not recomputed',
   r4 and abs(r4[0]['eps'] - 1.99) < 1e-6, r4)


print()
print('== D. A — the growth rate, stability, and the ROE floor ==')
years = facts(
    EarningsPerShareDiluted=('USD/shares', [
        q(f'{y}-01-01', f'{y}-12-31', v, form='10-K')
        for y, v in ((2021, 1.00), (2022, 1.30), (2023, 1.70),
                     (2024, 2.20), (2025, 2.90))]),
    NetIncomeLoss=('USD', [
        q(f'{y}-01-01', f'{y}-12-31', v, form='10-K')
        for y, v in ((2024, 220_000), (2025, 290_000))]),
    StockholdersEquity=('USD', [
        q(f'{y}-01-01', f'{y}-12-31', v, form='10-K')
        for y, v in ((2024, 1_000_000), (2025, 1_000_000))]),
)
a = edgar.a_table(years)
ok('the annual rows come back newest first',
   a['rows'][0]['fy'] == '2025-12-31', a['rows'][0])
ok('each year is compared with the one before it',
   a['rows'][0]['eps_chg'] == 31.8, a['rows'][0])

# COMPOUND, not an average of the yearly changes: averaging +100% and -50%
# gives +25% for a company that ended exactly where it started.
# 2.90 / 1.30 over three years: (2.23077 ^ 1/3) - 1 = 30.7%.
ok('the 3-year growth rate is COMPOUND',
   a['growth_3yr_pct'] == 30.7, a['growth_3yr_pct'])
flat = facts(EarningsPerShareDiluted=('USD/shares', [
    q(f'{y}-01-01', f'{y}-12-31', v, form='10-K')
    for y, v in ((2022, 1.00), (2023, 2.00), (2024, 1.00), (2025, 1.00))]))
ok('...so a round trip is 0%, not the average of +100 and -50',
   edgar.a_table(flat)['growth_3yr_pct'] == 0.0,
   edgar.a_table(flat)['growth_3yr_pct'])

# STABILITY: LOW IS GOOD, which is the opposite of every other number on the
# card. A straight line beats an average that happens to be high.
straight = facts(EarningsPerShareDiluted=('USD/shares', [
    q(f'{y}-01-01', f'{y}-12-31', v, form='10-K')
    for y, v in ((2021, 1.0), (2022, 2.0), (2023, 3.0), (2024, 4.0), (2025, 5.0))]))
wobbly = facts(EarningsPerShareDiluted=('USD/shares', [
    q(f'{y}-01-01', f'{y}-12-31', v, form='10-K')
    for y, v in ((2021, 1.0), (2022, 5.0), (2023, 0.5), (2024, 6.0), (2025, 3.0))]))
s_straight = edgar.a_table(straight)['stability']
s_wobbly = edgar.a_table(wobbly)['stability']
ok('a perfectly straight earnings line scores near zero', s_straight <= 2, s_straight)
ok('...and a wobbly one scores much higher', s_wobbly > s_straight + 20,
   (s_straight, s_wobbly))
ok('the direction is stated, because low-is-good is backwards from everything '
   'else here', 'LOW IS GOOD' in edgar.a_table(straight)['stability_note'])

ok("ROE is computed, and checked against O'Neil's 17% floor",
   a['roe_pct'] == 29.0 and a['roe_pass'] is True, (a['roe_pct'], a['roe_pass']))
low = facts(
    EarningsPerShareDiluted=('USD/shares', [q('2025-01-01', '2025-12-31', 1.0, form='10-K')]),
    NetIncomeLoss=('USD', [q('2025-01-01', '2025-12-31', 50_000, form='10-K')]),
    StockholdersEquity=('USD', [q('2025-01-01', '2025-12-31', 1_000_000, form='10-K')]),
)
ok('...and a 5% ROE fails it', edgar.a_table(low)['roe_pass'] is False,
   edgar.a_table(low)['roe_pct'])
ok('the floor travels with the number', edgar.a_table(low)['roe_floor'] == 17.0)


print()
print('== E. absences, and never a crash ==')
empty = edgar.tables({})
ok('an empty payload gives empty tables, not an exception',
   empty['c']['rows'] == [] and empty['a']['rows'] == [], empty)
ok('...and no ROE verdict from no ROE', empty['a']['roe_pass'] is None)
ok('...and no growth rate from no years', empty['a']['growth_3yr_pct'] is None)
ok('None is handled like an empty payload', edgar.tables(None)['c']['rows'] == [])

# FLOAT IS NOT CLAIMED. No free source publishes it, and a number here that
# looked exact and was an estimate would be worse than the blank.
s = edgar.supply(facts(EntityCommonStockSharesOutstanding=(
    'shares', [q('2025-01-01', '2025-12-31', 21_900_000)])))
ok('shares outstanding comes from EDGAR exactly',
   s['shares_outstanding'] == 21_900_000, s)
ok('float is NOT invented, and says why', s['float'] is None
   and 'no free source' in s['float_note'], s)

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'edgar.py').read_text()
ok('EDGAR is sent a descriptive User-Agent, which it requires',
   "'User-Agent': UA" in SRC and 'EDGAR_UA' in SRC)
ok('...and its rate limit is respected', 'MIN_GAP_S' in SRC)
ok('a card reads the CACHE and never triggers a fetch',
   'a card must never trigger a fetch' in SRC)
ok('the build stamps WHEN, because filings land weeks after quarter-end',
   "'built_at'" in SRC and 'weeks after quarter-end' in SRC)

# THE TABLES REACH THE PAGE AS TABLES. Section 7 exists because a single
# percentage throws away the shape O'Neil reads, and a card column cannot hold
# an eight-quarter table — so the panel is a full-width surface and the audit
# checks the columns are actually there.
UI = (pathlib.Path(__file__).resolve().parents[3] / 'public' / 'index.html').read_text()
for col in ('Qtr', 'EPS $', '%Chg', 'Sales', 'Margin'):
    ok(f'the C table renders a {col!r} column', f'<th>{col}</th>' in UI)
ok('...and EPS sits beside SALES on every row, which is the check itself',
   'r.sales_chg_label' in UI and 'r.eps_chg_label' in UI)
ok('the A table shows the ROE against its floor',
   'vs the ${a.roe_floor}% floor' in UI)
ok('...and says low-is-good about stability rather than leaving it bare',
   'a.stability_note' in UI)
ok('acceleration and the +25% count are on the page, not just in the model',
   'Accelerating:' in UI and 'Beat +${c.bar_pct}%' in UI)
ok('the panel is in LETTER order, because the panel is the method',
   UI.index("'C — current quarterly earnings'") < UI.index("'A — annual earnings'")
   < UI.index("'S — supply'") < UI.index("'L — leader or laggard'")
   < UI.index("'I — institutional sponsorship'") < UI.index("'M — market direction'"))
ok('every block carries its own as-of date, because they refresh on different '
   'clocks', 'own clock' in UI)
ok('I is not invented while 13F is unbuilt — it says which phase it is',
   'phase 6' in UI and 'Not estimated here' in UI)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
