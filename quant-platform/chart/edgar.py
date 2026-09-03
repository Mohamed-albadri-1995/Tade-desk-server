"""C and A — the earnings tables, from SEC EDGAR.

WHY EDGAR AND NOT A VENDOR. EDGAR is the authoritative source the paid vendors
resell. It is free, it needs no key, and `companyfacts` returns every number a
company has ever filed in XBRL, tagged with the period it covers and the filing
that reported it. What it costs is care: the raw payload is a pile of
overlapping facts, and turning it into O'Neil's tables is where the mistakes
live.

THE FIVE THAT MATTER, in the order they bite:

1. C IS YEAR-OVER-YEAR, NEVER SEQUENTIAL. The current quarter against the SAME
   quarter one year earlier. Comparing it to the previous quarter reintroduces
   exactly the seasonality the year-ago comparison exists to remove — a
   retailer's December against its September is a fact about Christmas.

2. Q4 IS USUALLY NOT FILED AS A QUARTER. A 10-K reports the full year, so the
   fourth quarter exists only as FY minus Q1 minus Q2 minus Q3. An
   implementation that reads only what is tagged quarterly silently drops every
   Q4 — a quarter of the table, and the one containing most retailers' year.

3. THE SAME PERIOD IS FILED MORE THAN ONCE. Restatements, amended filings, and
   the comparative columns inside later filings all re-report old periods. The
   most recently FILED value wins; taking the first match returns whatever
   happened to be earliest in the array.

4. A PERCENTAGE FROM A NEGATIVE BASE IS NOT A NUMBER. If the year-ago quarter
   was a loss, "growth" is arithmetic without meaning. MarketSmith prints N/A
   and so does this.

5. UNITS AND CONCEPTS ARE NOT UNIFORM. Revenue is filed under at least four
   different tags depending on the era and the filer, and a company that used
   one in 2019 and another in 2023 has a hole in the middle of its table unless
   all of them are tried.

PARSING IS SEPARATE FROM FETCHING, as everywhere else here: `tables()` takes a
companyfacts dict and returns the tables, so the audit can hand it a payload
built by hand and know what should come out. `fetch()` is the only thing that
touches the network.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import time
import urllib.request
from pathlib import Path

# EDGAR REQUIRES A DESCRIPTIVE User-Agent and returns 403 without one. This is
# their published condition of use, not a nicety.
UA = os.environ.get('EDGAR_UA') or 'Tade-desk-server data@tade-desk.local'

# ...and asks for no more than 10 requests a second. One company is one
# request, so the gap only matters when walking a list.
MIN_GAP_S = 0.15
_last_call = 0.0

BASE = 'https://data.sec.gov'
TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'

# Revenue has been filed under all of these. Tried in order of preference: the
# newest standard first, then the older ones, so a company that switched tags
# mid-history still produces a table with no hole in it.
REVENUE_TAGS = (
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
)
EPS_TAGS = ('EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted',
            'EarningsPerShareBasic')
NET_INCOME_TAGS = ('NetIncomeLoss', 'ProfitLoss')
EQUITY_TAGS = ('StockholdersEquity',
               'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest')

# O'Neil's floor for return on equity, and the growth bar a quarter has to
# clear to count as one of the good ones.
ROE_FLOOR = 17.0
QUARTER_BAR = 25.0

# Beyond this the number is noise and the point has been made. MarketSmith
# caps; so does this, and the cap is visible in the output rather than silently
# changing a 4000% into a 999%.
PCT_CAP = 999.0


def _get(url: str, tries: int = 3) -> dict:
    """One EDGAR request. Raises with a readable message rather than a stack."""
    global _last_call
    last = None
    for attempt in range(tries):
        gap = time.time() - _last_call
        if gap < MIN_GAP_S:
            time.sleep(MIN_GAP_S - gap)
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Accept': 'application/json',
                'Accept-Encoding': 'gzip, deflate',
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
                if r.headers.get('Content-Encoding') == 'gzip':
                    import gzip
                    raw = gzip.decompress(raw)
                _last_call = time.time()
                return json.loads(raw)
        except Exception as e:                            # noqa: BLE001
            last = e
            _last_call = time.time()
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f'EDGAR {url}: {last}')


# ---------------------------------------------------------------------------
# Parsing — pure, and where every one of the five traps is handled
# ---------------------------------------------------------------------------

def _facts(cf: dict, tags, unit_hint: str | None = None) -> list[dict]:
    """Every filed fact for these tags, MERGED across them. Newest filing wins.

    TWO RESOLUTIONS, AND THE FIRST WAS MISSING.

    1. ACROSS TAGS. A filer that used `EarningsPerShareDiluted` until 2024 and
       `EarningsPerShareBasicAndDiluted` afterwards has its history split in
       two, and the first version of this returned "the first tag that has
       any" — so one of the two halves was silently dropped.

       That is exactly the trap this module's own docstring describes, and it
       was not fixed by the code under it. Found on real data: SYRE came back
       with 2026 and 2024 in its table and NO 2025 AT ALL, and the gap looked
       like a company that had stopped filing.

       So every tag is read and merged, and where the same period appears
       under two, the tag EARLIER in the caller's list wins — that is what the
       ordering of REVENUE_TAGS and EPS_TAGS is for.

    2. WITHIN A TAG. The same period is re-reported by restatements,
       amendments and the comparative columns inside later filings, so an
       array from EDGAR routinely holds three values for one quarter. Keyed on
       (start, end) and resolved by `filed`, which is the only field that says
       which one is current.
    """
    facts = (cf or {}).get('facts', {})
    best: dict[tuple, dict] = {}
    rank: dict[tuple, tuple] = {}          # key -> (scope index, tag index)
    for si, scope in enumerate(('us-gaap', 'ifrs-full', 'dei')):
        block = facts.get(scope, {})
        for ti, tag in enumerate(tags):
            node = block.get(tag)
            if not node:
                continue
            here = (si, ti)
            for unit, rows in (node.get('units') or {}).items():
                if unit_hint and unit_hint not in unit:
                    continue
                for row in rows:
                    key = (row.get('start'), row.get('end'))
                    prev_rank = rank.get(key)
                    if prev_rank is not None:
                        if prev_rank < here:
                            continue       # a preferred tag already has it
                        if prev_rank == here and str(row.get('filed', '')) <= str(
                                best[key].get('filed', '')):
                            continue       # same tag, an older filing
                    best[key] = {**row, 'unit': unit, 'tag': tag}
                    rank[key] = here
    return sorted(best.values(), key=lambda r: str(r.get('end') or ''))


def _days(row) -> int | None:
    try:
        s = _dt.date.fromisoformat(row['start'])
        e = _dt.date.fromisoformat(row['end'])
        return (e - s).days
    except Exception:                                     # noqa: BLE001
        return None


def _series(rows, lo: int, hi: int):
    """({end: value}, {end: filed}) for facts covering `lo`..`hi` days.

    TWO MAPS BUILT IN ONE PASS, SO THEIR KEYS CANNOT DISAGREE.

    The value map is what every calculation in this file has always used. The
    filed map is what tells a BACKTEST whether the number existed yet: a
    quarter ending 31 March is not public on 1 April, it is public when the
    10-Q lands six weeks later, and a strategy gated on "EPS up 25%" in
    mid-April was reading a figure nobody had.

    `_facts` already resolves overlapping periods BY `filed` (see its second
    resolution), so the date is in hand at this point and was simply being
    dropped on the floor. Keeping it costs one dict.

    Two maps rather than one map of dicts, deliberately: every arithmetic
    site downstream — `_fill_q4`'s subtraction, `_year_ago`, `pct_change`,
    `_year_quarters`' sum — reads these values directly, and changing what a
    value IS would mean editing each of them and getting every one right. The
    keys are identical by construction because both are written in the same
    loop.
    """
    vals: dict = {}
    filed: dict = {}
    for r in rows:
        if not (r.get('start') and r.get('end') and r.get('val') is not None):
            continue
        d = _days(r) or 0
        if not d or not lo <= d <= hi:
            continue
        vals[r['end']] = r['val']
        filed[r['end']] = r.get('filed')
    return vals, filed


def _quarterly(rows) -> dict:
    """end-date → value, for facts covering roughly one quarter."""
    return _series(rows, 60, 120)[0]


def _annual(rows) -> dict:
    """end-date → value, for facts covering roughly one year."""
    return _series(rows, 300, 400)[0]


def _fill_q4(quarters: dict, years: dict, filed: dict | None = None,
             y_filed: dict | None = None) -> dict:
    """Derive the missing fourth quarter as FY minus the first three.

    A 10-K reports the full year, so for most filers Q4 is never tagged as a
    quarter and simply is not in the data. Reading only what is tagged
    quarterly drops a QUARTER OF EVERY TABLE, and for a retailer that is the
    quarter containing most of the year.

    Only filled when all three earlier quarters of that fiscal year are
    present — a subtraction with a hole in it is a wrong number rather than a
    missing one, and a wrong number is the thing this file exists to avoid.

    Returns (series, derived_keys). WHICH VALUES WERE DERIVED IS NOT AN
    IMPLEMENTATION DETAIL: subtraction is exact for dollars and only
    conditionally valid for anything per-share, so the caller has to be able
    to tell the two apart. See the reconciliation in c_table.

    WHEN A DERIVED Q4 BECAME KNOWABLE. `filed`, if given, is updated in place
    for each derived key with the LATEST of the four filings it was computed
    from — the three quarters and the 10-K. Not the earliest and not the
    year-end: this quarter is a subtraction, and a subtraction is not knowable
    until its last term is. Taking the year-end date instead would hand a
    backtest a Q4 six to ten weeks before the annual report existed, which is
    the exact look-ahead the field is here to prevent. Any of the four with no
    date leaves the result dateless, so it refuses rather than guesses.
    """
    derived: set = set()
    out = dict(quarters)
    for fy_end, fy_val in years.items():
        try:
            end = _dt.date.fromisoformat(fy_end)
        except Exception:                                 # noqa: BLE001
            continue
        if fy_end in out:
            continue                       # Q4 really was filed as a quarter
        # The three quarters ending inside the twelve months before this
        # year-end, give or take a fortnight on each boundary.
        inside = []
        for q_end, q_val in quarters.items():
            try:
                qd = _dt.date.fromisoformat(q_end)
            except Exception:                             # noqa: BLE001
                continue
            if end - _dt.timedelta(days=350) <= qd <= end - _dt.timedelta(days=45):
                inside.append((qd, q_val, q_end))
        inside.sort()
        if len(inside) == 3:
            out[fy_end] = round(fy_val - sum(v for _, v, _k in inside), 6)
            derived.add(fy_end)
            if filed is not None:
                stamps = [(filed or {}).get(k) for _d, _v, k in inside]
                stamps.append((y_filed or {}).get(fy_end))
                filed[fy_end] = (max(stamps) if all(stamps) else None)
    return {k: v for k, v in out.items() if not str(k).startswith('_')}, derived


def pct_change(now, then, kind: str = 'eps'):
    """Year-over-year change, with O'Neil's conventions.

    Returns (value, label). `None` means N/A and the label says why, because
    "no growth number" and "growth of zero" are opposite readings of the same
    blank space.

    `kind` only changes the wording, and it matters: a pre-revenue biotech was
    printing "n/a (loss a year ago)" against its SALES column, and sales are
    not a loss. Zero revenue is zero revenue.
    """
    if now is None or then is None:
        return None, 'n/a'
    if then <= 0:
        # A PERCENTAGE FROM A NEGATIVE OR ZERO BASE IS NOT A NUMBER. It is
        # arithmetic without meaning, and it is the single most common way a
        # screen surfaces a company that lost money last year as a 500%
        # grower. MarketSmith prints N/A; so does this.
        if kind == 'sales':
            return None, ('n/a (no sales a year ago)' if then == 0
                          else 'n/a (negative a year ago)')
        # Zero is not a loss either. A company that broke exactly even is a
        # different fact from one that lost money, and the reason the number
        # is missing is division by zero, not a negative base.
        return None, ('n/a (no earnings a year ago)' if then == 0
                      else 'n/a (loss a year ago)')
    v = (now - then) / abs(then) * 100.0
    if v > PCT_CAP:
        return PCT_CAP, f'+{PCT_CAP:.0f}%+'
    return round(v, 1), f'{"+" if v >= 0 else ""}{v:.1f}%'


def _year_ago(d: dict, end: str):
    """The value for the same quarter one year earlier, matched with slack.

    Fiscal quarters do not land on the same calendar date each year — a 52/53
    week filer moves by up to a week, and a changed year-end moves further. A
    window of about a month either side of "one year before" finds the right
    quarter without ever reaching the one beside it.
    """
    try:
        want = _dt.date.fromisoformat(end) - _dt.timedelta(days=365)
    except Exception:                                     # noqa: BLE001
        return None
    best, gap = None, 999
    for k, v in d.items():
        try:
            kd = _dt.date.fromisoformat(k)
        except Exception:                                 # noqa: BLE001
            continue
        g = abs((kd - want).days)
        # 45 DAYS, NOT 35. Quarter-ends drift more than a month between years:
        # a filer whose Q1 ended 30 April last year and 31 March this year is
        # 30 days out before any 52/53-week drift is added, and 35 left no
        # room for both. 45 is the widest that still cannot reach the quarter
        # beside it — adjacent quarter-ends are about 91 days apart, so the
        # halfway point is 45 and anything under it is unambiguous.
        if g < gap and g <= 45:
            best, gap = v, g
    return best


def _margin(ni, rev):
    """After-tax margin, bounded. See the note at the call site."""
    if ni is None or not rev:
        return None
    v = ni / rev * 100.0
    if v > PCT_CAP:
        return PCT_CAP
    if v < -PCT_CAP:
        return -PCT_CAP
    return round(v, 1)


def c_table(cf: dict, quarters: int = 8) -> dict:
    """C — the last eight quarters, each against the SAME quarter a year ago."""
    eps_rows = _facts(cf, EPS_TAGS, 'shares')
    rev_rows = _facts(cf, REVENUE_TAGS, 'USD')
    ni_rows = _facts(cf, NET_INCOME_TAGS, 'USD')

    _eq, eps_filed = _series(eps_rows, 60, 120)
    _ey, eps_y_filed = _series(eps_rows, 300, 400)
    _rq, rev_filed = _series(rev_rows, 60, 120)
    _ry, rev_y_filed = _series(rev_rows, 300, 400)
    _nq, ni_filed = _series(ni_rows, 60, 120)
    _ny, ni_y_filed = _series(ni_rows, 300, 400)

    # `_fill_q4` extends the filed maps in place for the quarters it derives.
    eps_q, eps_derived = _fill_q4(_eq, _ey, eps_filed, eps_y_filed)
    rev_q, _ = _fill_q4(_rq, _ry, rev_filed, rev_y_filed)
    ni_q, ni_derived = _fill_q4(_nq, _ny, ni_filed, ni_y_filed)

    # EPS IS A RATIO, AND A RATIO IS NOT ADDITIVE.
    #
    # Deriving Q4 as FY minus the first three quarters is exact for dollars —
    # revenue and net income really do sum. It is only valid for a PER-SHARE
    # figure while the share count holds still, and the moment a company
    # reverse-splits or issues heavily it stops being valid: the annual EPS is
    # struck on a weighted-average count that matches none of the quarters, so
    # the subtraction returns a number that was never anybody's earnings.
    #
    # Live, and it was the largest positive figure in the table: a company
    # that lost money in every quarter of 2025 — -4.80, -5.07, -4.74 against a
    # full year of -8.66 — printed Q4 as +5.95. Arithmetically consistent,
    # financially fictional, and the one row a reader would stop on.
    #
    # Net income for the same quarter IS a sound derivation, so it is the
    # check: if the two disagree about whether the quarter made money, the
    # share count moved and the EPS subtraction means nothing. Dropped rather
    # than printed, because a missing quarter is honest and this is not.
    for end in list(eps_derived):
        eps_v, ni_v = eps_q.get(end), ni_q.get(end)
        if eps_v is None or ni_v is None:
            continue
        if (eps_v > 0) != (ni_v > 0):
            eps_q.pop(end, None)

    ends = sorted(set(eps_q) | set(rev_q), reverse=True)[:quarters]
    rows = []
    for end in ends:
        eps, rev, ni = eps_q.get(end), rev_q.get(end), ni_q.get(end)
        eps_then = _year_ago(eps_q, end)
        rev_then = _year_ago(rev_q, end)
        eps_chg, eps_lab = pct_change(eps, eps_then)
        rev_chg, rev_lab = pct_change(rev, rev_then, kind='sales')
        # WHEN THIS ROW BECAME PUBLIC. The LATEST of the filings its figures
        # came from, never the earliest: a row is not knowable until its last
        # component is, and taking the earliest would let a backtest read a
        # quarter's sales weeks before they were reported. None means the date
        # was not recorded, and a caller asking "as of" must refuse the row
        # rather than assume the quarter-end — a quarter ends six weeks before
        # anybody sees it, which is exactly the gap that flatters a backtest.
        # A PRESENT VALUE WITH NO DATE MAKES THE WHOLE ROW DATELESS. Taking the
        # max of the dates that happen to exist would date the row by its
        # earlier components and hide the one that had not been filed yet.
        _st = [m.get(end) for v, m in ((eps, eps_filed), (rev, rev_filed),
                                       (ni, ni_filed)) if v is not None]
        rows.append({
            'quarter': end,
            'filed': (max(_st) if _st and all(_st) else None),
            'eps': eps,
            # THE NUMBER THE COMPARISON WAS MADE AGAINST, on the row.
            #
            # Reported from live use, looking straight at eight rows of
            # "n/a (loss a year ago)": "how year ago is not exist and it's in
            # front of me in the table". The label was right — every one of
            # those year-ago quarters WAS a loss, and a percentage from a
            # negative base is arithmetic without meaning — but it reads as
            # "the year-ago quarter is missing", which is a completely
            # different claim and the one thing this must never say.
            #
            # Printing the value ends the ambiguity: -0.64 against -5.07 is
            # visibly a comparison that was made and could not be expressed as
            # a percentage, not a comparison that could not be made.
            'eps_yr_ago': eps_then,
            'sales_yr_ago': rev_then,
            'eps_chg': eps_chg, 'eps_chg_label': eps_lab,
            # SALES BESIDE EPS, ALWAYS. O'Neil's warning is earnings growth
            # without sales growth — buybacks, margin games, one-offs. The pair
            # is the check, and showing EPS alone hides exactly what he is
            # warning about.
            'sales': rev,
            'sales_chg': rev_chg, 'sales_chg_label': rev_lab,
            # After-tax margin, because rising margin AND rising sales is the
            # combination he wants.
            #
            # CAPPED, LIKE EVERY OTHER PERCENTAGE HERE. A margin is a share of
            # sales, and a pre-revenue company divides a real loss by almost
            # nothing: live figures of -49,482% and -237,021% appeared beside
            # revenues of $113,000 and $1,403. Both are arithmetically true
            # and neither is a margin — past a few hundred percent the number
            # has stopped describing a business and started describing a
            # denominator. The cap is the same PCT_CAP the growth columns use,
            # and it is visible in the value rather than silently reshaping it.
            'margin_pct': _margin(ni, rev),
        })

    return {'rows': rows, **c_summary(rows)}


def c_summary(rows) -> dict:
    """C's verdicts over a list of quarter rows. Newest first.

    SPLIT OUT SO THE AS-OF PATH CANNOT DRIFT FROM THE CARD. `chart/canslim.py`
    answers "what was C on 14 March" by taking the rows filed by then and
    asking this the same question — the alternative was a second copy of the
    arithmetic below, which is how two readings of one stock start disagreeing.
    """
    # ACCELERATION IS INVISIBLE IN ANY SINGLE NUMBER, and O'Neil weights it
    # heavily: each of the last quarters growing FASTER than the one before.
    chgs = [r['eps_chg'] for r in rows if r.get('eps_chg') is not None]
    # None, NOT False, when there is nothing to measure. "Accelerating: no"
    # over ZERO quarters is a verdict on evidence that does not exist, and it
    # reads on a card as though the test ran and the stock failed it. A
    # loss-maker has no comparable quarters at all, so this was printing a
    # judgement about every one of them.
    accelerating = ((chgs[0] > chgs[1] > chgs[2]) if len(chgs) >= 3 else None)
    return {
        'accelerating': accelerating,
        'accelerating_of': min(3, len(chgs)),
        'beat_25': sum(1 for c in chgs if c >= QUARTER_BAR),
        'beat_25_of': len(chgs),
        'bar_pct': QUARTER_BAR,
        'note': ('%Chg is always against the SAME quarter one year earlier, '
                 'and that quarter\'s figure is in the YR AGO column — n/a '
                 'never means it is missing. It means the base was a loss or '
                 'zero, and a percentage from a negative base is arithmetic '
                 f'without meaning. Capped at +{PCT_CAP:.0f}%.'),
    }


def _roe(ni, equity):
    """Return on equity — NEVER computed from negative or zero equity.

    THE FALSE PASS THIS EXISTS TO STOP. The guard used to be `if equity`,
    which is true for -3,000,000 as readily as for 3,000,000. A company that
    had lost money for years — negative income AND negative equity, because
    the accumulated losses had eaten the balance sheet — divided one by the
    other and printed a POSITIVE return. Live: a stock with EPS of -0.05 for
    the year showed "ROE 34.1% vs the 17% floor ✓" and passed the one
    criterion O'Neil put there to keep exactly that company out.

    Two negatives making a positive is arithmetic; it is not a return. It is
    the same trap as a percentage from a negative base, which this file has
    always refused to print, and it had a second door open.
    """
    if ni is None or equity is None or equity <= 0:
        return None
    return round(ni / equity * 100, 1)


def _year_quarters(quarters: dict, fy_end: str):
    """(sum of the quarters inside this fiscal year, how many were found).

    THE SAME DATE ENDS TWO DIFFERENT PERIODS, AND THE CARD DID NOT SAY SO.
    Read off a live card, on a filer whose year ends 31 July:

        C — CURRENT QUARTERLY EARNINGS      A — ANNUAL EARNINGS
            QTR          EPS $                  FY           EPS $
            2025-07-31    0.36                  2025-07-31    1.60

        "31-7-2025 earning is showing number on C and another on A"

    Both figures are right. 2025-07-31 is the end of a three-month period AND
    the end of a twelve-month one, and the year's four quarters come to
    exactly the annual figure: 0.49 + 0.38 + 0.37 + 0.36 = 1.60. Nothing was
    wrong except that two tables printed one date against two numbers and
    neither said which span it meant.

    So the sum travels with the annual row and the card prints it beside the
    filed figure — the same move as C's YR AGO column, added after the same
    kind of report: printing the number a comparison was made against is what
    ends the ambiguity.

    A PARTIAL YEAR RETURNS ITS COUNT, NOT A SUM. Three quarters added up and
    shown against a twelve-month figure is a check that fails for a reason
    that is not the company's, and it would read as a discrepancy in the
    filings. The caller prints the count instead.
    """
    try:
        end = _dt.date.fromisoformat(fy_end)
    except Exception:                                     # noqa: BLE001
        return None, 0
    # Inside the year, by DAYS from the year end — a fiscal year is not the
    # calendar year, and comparing year numbers would take the wrong four for
    # every filer whose year does not end in December.
    inside = []
    for q_end, val in quarters.items():
        try:
            gap = (end - _dt.date.fromisoformat(q_end)).days
        except Exception:                                 # noqa: BLE001
            continue
        if 0 <= gap <= 366 and val is not None:
            inside.append(val)
    if len(inside) != 4:
        return None, len(inside)
    return round(sum(inside), 2), 4


def _yr(end: str) -> int | None:
    try:
        return _dt.date.fromisoformat(end).year
    except Exception:                                     # noqa: BLE001
        return None


def _days_apart(a: str, b: str) -> int | None:
    try:
        return (_dt.date.fromisoformat(a) - _dt.date.fromisoformat(b)).days
    except Exception:                                     # noqa: BLE001
        return None


def _apart(a: str, b: str, years: int = 1) -> bool:
    """Are these two fiscal year-ends `years` apart?

    MEASURED IN DAYS, NOT CALENDAR YEARS. Subtracting the year numbers looks
    equivalent and is not: a filer whose year ends 31 January files 2026-01-31
    against 2024-12-31 — thirteen months apart, which the year numbers call TWO
    years and the table then refused to compare. Fiscal year-ends drift; a
    52/53-week filer moves by up to a week, a changed year-end moves by a month
    or more, and none of that stops it being the next year. The window is wide
    enough for that drift and far too narrow to reach the year beside it.
    """
    d = _days_apart(a, b)
    return d is not None and abs(d - years * 365) <= 75


def a_table(cf: dict, years: int = 5) -> dict:
    """A — annual EPS over 3-5 years, the growth rate, stability and ROE."""
    eps_rows = _facts(cf, EPS_TAGS, 'shares')
    eps_y, eps_y_filed = _series(eps_rows, 300, 400)
    ni_rows = _facts(cf, NET_INCOME_TAGS, 'USD')
    ni_y, ni_y_filed = _series(ni_rows, 300, 400)
    eq = _facts(cf, EQUITY_TAGS, 'USD')
    eq_by_end = {r['end']: r['val'] for r in eq if r.get('val') is not None}
    eq_filed = {r['end']: r.get('filed') for r in eq if r.get('val') is not None}
    # THE QUARTERS THAT MAKE UP EACH YEAR, so the two tables can be read
    # against each other. See `_year_quarters` below.
    eps_q_only = _quarterly(eps_rows)

    ends = sorted(eps_y, reverse=True)[:years]

    # THE ROW BELOW IS NOT NECESSARILY THE YEAR BEFORE. A filer that stopped
    # tagging annual EPS for a stretch leaves a HOLE, and the list closes over
    # it: FTAI's rows ran 2025, 2024, 2023, 2018, 2017, so comparing each row
    # with the next one printed 2023 against 2018 and called the result a
    # year-over-year change. It was +2914%, over five years, labelled as one.
    # A comparison is only a year-over-year comparison when the two ends are
    # about a year apart; anything else says so instead of pretending. See
    # `_apart` above — lifted out of this function so the as-of path in
    # `chart/canslim.py` measures a year the same way this does.
    rows = []
    for i, end in enumerate(ends):
        nxt = ends[i + 1] if i + 1 < len(ends) else None
        prev = nxt if (nxt and _apart(end, nxt)) else None
        if nxt and prev is None:
            chg, lab = None, 'n/a (no prior year filed)'
        else:
            chg, lab = pct_change(eps_y.get(end), eps_y.get(prev) if prev else None)
        ni, equity = ni_y.get(end), eq_by_end.get(end)
        q_sum, q_of = _year_quarters(eps_q_only, end)
        # WHEN THIS YEAR BECAME PUBLIC — the same rule as C's row date: the
        # latest of the filings behind the figures on the row, and dateless if
        # any figure that IS on the row has no date. A fiscal year ends weeks
        # or months before the 10-K, and a backtest that reads the year on its
        # last day is reading a report that had not been written.
        _st = [m.get(end) for v, m in ((eps_y.get(end), eps_y_filed),
                                       (ni, ni_y_filed), (equity, eq_filed))
               if v is not None]
        rows.append({
            'fy': end,
            'filed': (max(_st) if _st and all(_st) else None),
            'eps': eps_y.get(end),
            # THE SAME YEAR ADDED UP FROM THE C TABLE, so the two tables can
            # be checked against each other on the card rather than looking
            # like they disagree. See `_year_quarters`.
            'quarters_sum': q_sum,
            'quarters_of': q_of,
            'eps_chg': chg, 'eps_chg_label': lab,
            'roe_pct': _roe(ni, equity),
            # WHY it is absent, since "no filing" and "the arithmetic has no
            # meaning here" are opposite readings of the same blank cell.
            'roe_note': (None if _roe(ni, equity) is not None
                         else 'equity is zero or negative — a return ON equity '
                              'needs equity' if (equity is not None
                                                 and equity <= 0)
                         else None),
        })

    return {'rows': rows, **a_summary(rows)}


def a_summary(rows) -> dict:
    """A's verdicts over a list of annual rows. Newest first.

    SPLIT OUT FOR THE SAME REASON AS `c_summary`: the as-of path recomputes
    these over the years that had actually been filed by a past date, and it
    must arrive at them through this code and not a copy of it. A 3-year growth
    rate is exactly the kind of number that reads fine while being computed
    over the wrong three years.
    """
    # 3-YEAR GROWTH RATE as a compound annual rate, not an average of the
    # yearly changes: averaging +100% and -50% gives +25% for a company that
    # ended where it started.
    # Same hole, same trap: the fourth row is only three years back when no
    # year is missing. FTAI's printed 303.5% a year, which was 2025 over 2018
    # compounded as though it were three years.
    growth3 = None
    kept = [r for r in rows if r['eps'] is not None]
    vals = [r['eps'] for r in kept]
    if (len(kept) >= 4 and _apart(kept[0]['fy'], kept[3]['fy'], 3)
            and vals[3] and vals[3] > 0 and vals[0] > 0):
        growth3 = round(((vals[0] / vals[3]) ** (1 / 3) - 1) * 100, 1)

    # EARNINGS STABILITY — how much the series WOBBLES around its own trend.
    # LOW IS GOOD, which is the opposite of every other number on the card, and
    # it is why it is named and labelled rather than left as a bare figure.
    # O'Neil wants a straight line, not an average that happens to be high.
    stability = None
    if len(kept) >= 4:
        seq = list(reversed(vals))                # oldest first
        # THE X AXIS IS THE YEAR, NOT THE ROW NUMBER. Regressing on position
        # spaces 2017 and 2023 one step apart when six years separate them,
        # which flattens the fitted trend and reports a gappy series as
        # steadier than it is. Steadiness is the one number here where high is
        # bad, so an understatement flatters the stock.
        xs = [_yr(r['fy']) or 0 for r in reversed(kept)]
        n = len(seq)
        mx = sum(xs) / n
        my = sum(seq) / n
        den = sum((x - mx) ** 2 for x in xs)
        if den:
            slope = sum((xs[i] - mx) * (seq[i] - my) for i in range(n)) / den
            resid = [seq[i] - (my + slope * (xs[i] - mx)) for i in range(n)]
            scale = abs(my) or 1.0
            stability = int(round(min(99, (sum(r * r for r in resid) / n) ** 0.5
                                      / scale * 100)))

    roes = [r['roe_pct'] for r in rows if r.get('roe_pct') is not None]
    roe = roes[0] if roes else None
    return {
        'growth_3yr_pct': growth3,
        'stability': stability,
        'stability_note': 'how much the earnings series wobbles around its own '
                          'trend. LOW IS GOOD — the opposite of every other '
                          'number here.',
        'roe_pct': roe,
        'roe_floor': ROE_FLOOR,
        'roe_pass': (None if roe is None else roe >= ROE_FLOOR),
    }


# S — shares outstanding, in the order they are preferred.
#
# ONE TAG WAS NOT ENOUGH. `EntityCommonStockSharesOutstanding` is the cover
# page of a filing and it is the right answer when it is there — but it is a
# dei tag and not every filer carries it in XBRL, so the card printed a bare
# "—" for real companies that had filed the number under a us-gaap tag
# instead. Live: two of five stocks on one screen.
#
# The last two are WEIGHTED AVERAGES over a period, not a count on a date.
# They are a different measurement and only a last resort, which is why the
# basis travels with the value instead of all four being called the same
# thing: a weighted average across a quarter in which a company doubled its
# share count is nobody's share count.
SHARES_TAGS = (
    'EntityCommonStockSharesOutstanding',           # cover page, point in time
    'CommonStockSharesOutstanding',                 # balance sheet, same idea
    'CommonStockSharesIssued',                      # issued ≥ outstanding
    'WeightedAverageNumberOfDilutedSharesOutstanding',
    'WeightedAverageNumberOfSharesOutstandingBasic',
)
SHARES_BASIS = {
    'EntityCommonStockSharesOutstanding': 'outstanding, from the filing cover',
    'CommonStockSharesOutstanding': 'outstanding, from the balance sheet',
    'CommonStockSharesIssued': 'ISSUED, not outstanding — includes treasury '
                               'stock, so this is an upper bound',
    'WeightedAverageNumberOfDilutedSharesOutstanding':
        'a WEIGHTED AVERAGE over the period, diluted — not a count on a date',
    'WeightedAverageNumberOfSharesOutstandingBasic':
        'a WEIGHTED AVERAGE over the period, basic — not a count on a date',
}


# HOW MANY SHARE COUNTS TO KEEP, AND WHY KEEP ANY.
#
# One number is a fact and says nothing. O'Neil's S is not "how many shares" —
# it is whether the count is SHRINKING: a company buying its own stock back is
# reducing supply into the same demand, and one issuing heavily is doing the
# opposite to its own shareholders. Neither is visible in a single figure, and
# both are already in the data that was downloaded to get it.
#
# Eight points is two years, which is long enough for a buyback programme to
# show and short enough that a split five years ago is not read as dilution.
SHARES_HISTORY = 8

# The span a change is measured over: one year, give or take a quarter. A
# percentage over an arbitrary gap is not a rate, and comparing across
# whatever two dates happen to exist is how a nine-month change gets read as
# an annual one.
_SHARES_SPAN = (290, 440)


def _shares_change(points):
    """Change in share count over ~a year, or None if there is no such pair.

    LIKE FOR LIKE OR NOTHING. `points` must already come from a SINGLE tag: a
    cover-page count in one period against a weighted average in another
    differs by the measurement and not by the company, and subtracting them
    manufactures a buyback that never happened. The caller does that filtering
    — this only chooses the dates.
    """
    if len(points) < 2:
        return None
    last = points[-1]
    try:
        to = _dt.date.fromisoformat(last['end'])
    except Exception:                                     # noqa: BLE001
        return None
    best = None
    for r in points[:-1]:
        try:
            gap = (to - _dt.date.fromisoformat(r['end'])).days
        except Exception:                                 # noqa: BLE001
            continue
        if not _SHARES_SPAN[0] <= gap <= _SHARES_SPAN[1]:
            continue
        if best is None or abs(gap - 365) < abs(best[0] - 365):
            best = (gap, r)
    if best is None:
        return None
    gap, then = best
    now_v, then_v = last.get('val'), then.get('val')
    # A count of zero is not a base to divide by, and a negative one is not a
    # share count at all.
    if not now_v or not then_v or then_v <= 0:
        return None
    return {'pct': round((now_v - then_v) / then_v * 100, 2),
            'from': then['end'], 'from_val': then_v,
            'to': last['end'], 'to_val': now_v, 'days': gap}


def supply(cf: dict) -> dict:
    """S — shares outstanding, what kind of count it is, and its direction."""
    rows = _facts(cf, SHARES_TAGS, 'shares')
    latest = rows[-1] if rows else None
    tag = (latest or {}).get('tag')
    # ONE TAG, NEVER MIXED — see _shares_change. Keyed on the end date so a
    # period re-reported under the same tag appears once.
    seen: dict[str, float] = {}
    for r in rows:
        if (r.get('tag') == tag and r.get('end')
                and r.get('val') is not None):
            seen[r['end']] = r['val']
    points = [{'end': e, 'val': v} for e, v in sorted(seen.items())]
    return {
        'shares_outstanding': latest.get('val') if latest else None,
        'as_of': latest.get('end') if latest else None,
        'shares_tag': tag,
        'shares_basis': SHARES_BASIS.get(tag),
        # THE HISTORY, so the number can be compared with itself. Same tag as
        # the headline figure, oldest first.
        'shares_history': points[-SHARES_HISTORY:],
        'shares_chg_1y': _shares_change(points),
        # FLOAT IS NOT IN EDGAR, and that is all this says now.
        #
        # It used to say "no free source publishes float directly", which was
        # wrong in this system's own terms and visibly so: the same card
        # printed "float 2.46M sh" three sections higher, from the screener,
        # and short interest is already divided by a float this file claimed
        # did not exist. EDGAR is a filings API and a filer does not tag its
        # own float; the screener does have it. The card merges the two.
        'float': None,
        'float_note': 'not in EDGAR — filers do not tag float; '
                      'the screener supplies it',
    }


# WHAT `tables()` PRODUCES. Bump this whenever that changes — a new column, a
# corrected calculation, a value that used to be printed and no longer is.
# `cached()` treats any record with a different number as absent, so the walk
# refills it and the cards stop serving answers from before the fix.
#
#   1  the original C, A and S tables
#   2  2026-09-02 — eps_yr_ago and sales_yr_ago; ROE refused on non-positive
#      equity; a derived Q4 EPS dropped when it disagrees with net income;
#      margin capped at PCT_CAP; shares outstanding gained four fallback tags
#      and a basis
#   3  2026-09-02 — shares_history and shares_chg_1y: S was the one letter
#      with no history at all, and a share count that is not compared with
#      itself cannot show a buyback or a dilution, which is the whole of what
#      O'Neil reads it for
#   4  2026-09-02 — quarters_sum and quarters_of on every annual row. A
#      fiscal year and its own fourth quarter END ON THE SAME DATE, so the C
#      and A tables printed one date against two numbers and neither said
#      which span it meant
#   5  2026-09-03 — `filed` on every C and A row: the date the figure became
#      public, which the parse had in hand and threw away. Without it there is
#      no way to tell what a reader knew on a past day, so a backtest gated on
#      C or A was using earnings that had not been reported — see
#      chart/canslim.py, which refused those letters outright until this
SCHEMA = 5


def tables(cf: dict) -> dict:
    """Everything, from one companyfacts payload. Pure."""
    return {
        'schema': SCHEMA,
        'entity': (cf or {}).get('entityName'),
        'cik': (cf or {}).get('cik'),
        'c': c_table(cf),
        'a': a_table(cf),
        's': supply(cf),
    }


# ---------------------------------------------------------------------------
# Fetching, and the per-ticker cache
# ---------------------------------------------------------------------------

CACHE = Path(os.environ.get('ONEIL_FUNDAMENTALS_DIR')
             or (Path(__file__).resolve().parents[2] / 'data' / 'oneil'))
_TICKER_MAP = Path(os.environ.get('EDGAR_TICKER_MAP')
                   or (CACHE / '_tickers.json'))


def ticker_map(refresh: bool = False) -> dict:
    """ticker → CIK, cached. One request for the whole market."""
    try:
        if not refresh and _TICKER_MAP.exists():
            age_d = (time.time() - _TICKER_MAP.stat().st_mtime) / 86400
            if age_d < 30:
                return json.loads(_TICKER_MAP.read_text())
    except Exception:                                     # noqa: BLE001
        pass
    raw = _get(TICKERS_URL)
    out = {str(v['ticker']).upper(): int(v['cik_str'])
           for v in raw.values() if v.get('ticker')}
    try:
        _TICKER_MAP.parent.mkdir(parents=True, exist_ok=True)
        _TICKER_MAP.write_text(json.dumps(out))
    except Exception:                                     # noqa: BLE001
        pass
    return out


def fetch(ticker: str) -> dict:
    """companyfacts for one ticker. The only thing here that goes out."""
    cik = ticker_map().get(str(ticker).upper())
    if not cik:
        raise RuntimeError(f'{ticker}: not in EDGAR\'s ticker list — an ETF, '
                           f'an ADR without a filer, or delisted')
    return _get(f'{BASE}/api/xbrl/companyfacts/CIK{cik:010d}.json')


def build(ticker: str) -> dict:
    """Fetch and parse, and stamp WHEN — filings land weeks after quarter-end,
    so a card in May may legitimately be showing a February filing and the
    as-of date is the difference between that and a bug."""
    t = str(ticker).upper()
    # STAMPED ON BOTH PATHS. tables() carries the schema for a successful
    # parse, but a "no filings" record never reaches tables() — and without
    # the stamp `cached()` would treat every one of those as absent and
    # re-walk the market's ETFs and ADRs every single night, which is the
    # whole cost the negative cache exists to avoid.
    out = {'ticker': t, 'schema': SCHEMA,
           'built_at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}
    try:
        out.update(tables(fetch(t)))
        out['ok'] = True
    except Exception as e:                                # noqa: BLE001
        out.update({'ok': False, 'error': str(e)[:300]})
    return out


def cached(ticker: str, max_age_days: float = 7.0) -> dict | None:
    """What is on disk, if it is fresh enough AND was parsed by this code.

    Fundamentals move quarterly, so a week is nowhere near stale.
    And a card must never trigger a fetch: this reads, and never builds.

    TWO WAYS TO BE STALE, and only one of them is about time.

    The cache holds PARSED tables, not raw filings, so every change to the
    parser makes every stored record obsolete — and nothing about the file
    says so. Live, within hours of three parser fixes: the YR AGO column was
    blank on every stock while the %chg beside it still read "loss a year
    ago", which is only possible if the year-ago figure was found; a false
    "ROE 34.1% ✓" was still being served after the guard that forbids it
    shipped; and a margin of -237,021% was still on the card after the cap.
    Each fix was live and each card was showing the answer from before it.

    So the schema version is written into every record and checked here. Bump
    SCHEMA whenever `tables()` changes what it produces, and the next read
    treats every old record as absent — the nightly walk then refills it in
    the ordinary way. A parser fix that does not reach the cards is not a fix.
    """
    p = CACHE / f'{str(ticker).upper()}.json'
    try:
        if not p.exists():
            return None
        if (time.time() - p.stat().st_mtime) / 86400 > max_age_days:
            return None
        rec = json.loads(p.read_text())
        if (rec or {}).get('schema') != SCHEMA:
            return None
        return rec
    except Exception:                                     # noqa: BLE001
        return None


def write_cached(data: dict) -> str | None:
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        p = CACHE / f"{data['ticker']}.json"
        tmp = p.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, default=str))
        tmp.replace(p)
        return str(p)
    except Exception:                                     # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# The nightly walk
# ---------------------------------------------------------------------------
#
# WHY A WALK AND NOT ON-DEMAND FETCHING.
#
# Reported from live use, and it is the whole point:
#
#     "what will I do with it after the market close — tomorrow new scan and
#      new stock, I don't have any stocks that stay in the screener 2 days"
#
# Warming the cache with the names a scan just returned helps the SECOND time
# that name is scanned. If the screener returns a different set every morning
# — and it does, that is what a screener is — then the second time never
# comes, and every card is a first sighting with empty C and A tables.
#
# So the cache cannot be filled from what was scanned. It has to be filled
# from what COULD be scanned, ahead of time, which is the whole universe that
# has price history. Then tomorrow's new name is already answered before the
# screener has picked it.
#
# The costs this is shaped around:
#   · one request per company, at EDGAR's published rate limit
#   · a companyfacts payload is megabytes, so this is bandwidth-bound long
#     before it is rate-limit-bound
#   · only the PARSED tables are stored, a few KB each, so the disk cost is
#     small even though the transfer is not

# Refreshed sooner than a card will accept it. If the walk used the same seven
# days the reader does, a record refreshed at 6.9 days would be "fresh" to the
# walk tonight and expired for the cards tomorrow — a stock would lose its
# tables on a day nothing was wrong. Two days of margin.
REFRESH_DAYS = float(os.environ.get('QP_EDGAR_REFRESH_DAYS') or 5)

# A ceiling on the night, not on the job. The first pass over a whole universe
# is hours; the walk is ordered and resumable, so stopping partway is simply a
# shorter night and the next one continues from where it left off.
WALK_BUDGET_S = float(os.environ.get('QP_EDGAR_WALK_SECONDS') or 5400)


# A COMPANY THAT OWES A FILING IS STALE NO MATTER HOW YOUNG THE FILE IS.
#
# REFRESH_DAYS is a clock, and a clock knows nothing about earnings. A company
# that reports on the first day of its five-day window shows the PREVIOUS
# quarter for the next five days — and earnings day is precisely the day the C
# letter changes and the day a card is worth looking at. "We need the most
# recent data" is not satisfied by a cache that is merely young.
#
# So a second, independent reason to re-fetch: the newest quarter on file
# ended long enough ago that the next one must already exist. A quarter is
# about 91 days, and a 10-Q is due 40-45 days after it ends (60 for a 10-K),
# so a record whose last quarter ended more than ~136 days ago is behind.
#
# MEASURED FROM THE COMPANY'S OWN LAST QUARTER, not from the calendar. A filer
# whose year ends in January has quarters ending Jan/Apr/Jul/Oct, and judging
# it against 31 March would call it late four times a year for being itself.
_QUARTER_DAYS = 91
FILING_DUE_DAYS = float(os.environ.get('QP_EDGAR_DUE_DAYS') or 45)


def _last_quarter_end(rec) -> str | None:
    """The newest quarter this cached record knows about."""
    rows = (((rec or {}).get('c') or {}).get('rows')) or []
    ends = [r.get('quarter') for r in rows if r.get('quarter')]
    return max(ends) if ends else None


def _due_for_filing(rec, today=None) -> bool:
    """Has a quarter come and gone that this record has never seen?

    Only ever ADDS work. The card's predicate is `cached()` and this does not
    touch it: a company that owes a filing keeps showing the last one it made,
    which is the right answer until a newer one exists. Making the reader
    reject it too would blank a good table over a filing that is merely late —
    the same shape as the deadlock in `walk`, arrived at from the other side.
    """
    last = _last_quarter_end(rec)
    # No quarters at all is the no-filings case, already cached as such and
    # not a company that is behind.
    if not last:
        return False
    try:
        end = _dt.date.fromisoformat(last)
    except Exception:                                     # noqa: BLE001
        return False
    d = today or _dt.date.today()
    return (d - end).days >= _QUARTER_DAYS + FILING_DUE_DAYS


def _cache_age_days(ticker: str) -> float | None:
    """Age of what is on disk, or None if nothing is."""
    p = CACHE / f'{str(ticker).upper()}.json'
    try:
        return (time.time() - p.stat().st_mtime) / 86400 if p.exists() else None
    except Exception:                                     # noqa: BLE001
        return None


def _permanent(err: str) -> bool:
    """Is this a company EDGAR will never have facts for, or a bad night?

    THE DISTINCTION IS THE WHOLE REASON FAILURES ARE CACHED AT ALL. Around a
    fifth of a price universe is ETFs, ADRs without a filer, and delisted
    shells — EDGAR has no XBRL for any of them and never will. Retried every
    night, they are a thousand pointless requests standing in front of the
    companies that do have filings.

    A timeout or a 503 is the opposite: nothing has been learned, and writing
    "no facts" for it would blank a real company's tables for five days over
    one bad minute.
    """
    e = str(err or '')
    return 'not in EDGAR' in e or '404' in e


def walk(symbols, refresh_days: float | None = None,
         budget_s: float | None = None, limit: int | None = None,
         prefer=None, log=print) -> dict:
    """Fill the fundamentals cache for a whole universe, oldest first.

    ORDERED, so it is resumable and so coverage only ever grows: names with
    nothing on disk go first, then the stalest. An interrupted run has done
    the most valuable part of its work, and the next run does not repeat it.
    """
    want = [str(s).upper() for s in (symbols or []) if s]
    want = list(dict.fromkeys(want))
    if not want:
        return {'ok': False, 'error': 'no universe'}
    age = float(REFRESH_DAYS if refresh_days is None else refresh_days)
    budget = float(WALK_BUDGET_S if budget_s is None else budget_s)

    # ONE PREDICATE DECIDES WHAT IS MISSING, AND IT IS THE READER'S.
    #
    # THE DEADLOCK THIS FIXES. `cached()` gained a schema check, so every
    # record written by an older parser became invisible to the cards — which
    # was the point. But this filter asked `_cache_age_days`, which reads FILE
    # MTIME and knows nothing about the schema. The two then disagreed about
    # whether the same 14,606 records existed:
    #
    #     the cards      "not fetched yet" on every stock
    #     the walk       "14606 already fresh · 0 to fetch"
    #
    # Neither is wrong alone. Together they lock: the cards will not read what
    # the walk will not rewrite, and C and A stay empty PERMANENTLY rather
    # than for a week. A cache with two readers that disagree about what is in
    # it is worse than a cache with none.
    #
    # So membership is `cached()` — the same question, asked once. The mtime
    # is still computed, but only for ORDERING: "nothing on disk first, then
    # the stalest" needs a number, and a rejected record still has a date.
    ages = {t: _cache_age_days(t) for t in want}
    recs = {t: cached(t, max_age_days=age) for t in want}
    # TWO REASONS TO FETCH, AND THE CLOCK IS ONLY ONE OF THEM. See
    # _due_for_filing: a record can be a day old and already a quarter behind.
    due = {t for t in want if recs[t] is not None and _due_for_filing(recs[t])}
    todo = [t for t in want if recs[t] is None or t in due]

    # KNOWN FILERS FIRST, and this is worth far more than it looks.
    #
    # The price universe is every ticker that trades: ETFs, warrants, units,
    # preferred, closed-end funds. None of them file XBRL, and the first live
    # run proved the cost — 462 built against 338 with no filings, so nearly
    # HALF the night was spent learning that an ETF is an ETF.
    #
    # `prefer` is the SIC map: every symbol there was classified from a real
    # SEC filer, so it is exactly the set with something to fetch. Ordering by
    # it does not skip anything — the rest are still walked, and their "no
    # filings" answer is still cached so tomorrow skips them — but a night
    # that runs out of time has spent its hours on companies.
    known = {str(s).upper() for s in (prefer or ())}
    # -inf, NOT -1. The key is the negated age, so a 30-day-old record sorts
    # at -30 and a never-fetched one at -1 landed BEHIND every stale record —
    # the exact opposite of what is wanted, and invisible until a universe
    # that had grown spent its whole night refreshing names it already had.
    # Nothing on disk outranks any age.
    #
    # AND THE ORDER INSIDE THAT IS WORST-CARD-FIRST, on a night that runs out
    # of hours:
    #
    #   0  nothing on disk        the card has no tables at all
    #   1  on disk, rejected      too old or too old a schema — the reader
    #                             will not show it, so the card is blank too
    #   2  readable, owes a filing  the card is right, and a quarter behind
    #
    # 2 is last because it is the only one of the three that still renders.
    def _tier(t):
        if ages[t] is None:
            return 0
        return 1 if recs[t] is None else 2

    todo.sort(key=lambda t: (0 if t in known else 1, _tier(t),
                             float('-inf') if ages[t] is None else -ages[t]))
    log(f'  {len(want)} in universe · {len(want) - len(todo)} already fresh '
        f'· {len(todo)} to fetch'
        + (f' · {len(due)} of them owe a filing' if due else '')
        + (f' · {sum(1 for t in todo if t in known)} of them known filers'
           if known else ''))

    started = time.time()
    built = failed = dead = 0
    for i, t in enumerate(todo):
        if limit and built + failed + dead >= limit:
            log(f'  stopping at the {limit}-company limit')
            break
        if budget and time.time() - started > budget:
            log(f'  out of time after {i} of {len(todo)} — the rest are '
                f'first in line tomorrow')
            break
        rec = build(t)
        if rec.get('ok'):
            write_cached(rec)
            built += 1
        elif _permanent(rec.get('error')):
            # CACHED AS AN ANSWER, because it is one: we asked, and EDGAR has
            # nothing to give. The card can say so instead of "not fetched
            # yet", and tomorrow's walk spends its requests elsewhere.
            write_cached(rec)
            dead += 1
        else:
            failed += 1
        if (built + failed + dead) % 100 == 0:
            log(f'{built + failed + dead}/{len(todo)} · {built} built '
                f'· {dead} no filings · {failed} failed')

    return {
        'ok': True, 'universe': len(want), 'todo': len(todo),
        'built': built, 'no_filings': dead, 'failed': failed,
        'seconds': round(time.time() - started),
        'remaining': max(0, len(todo) - (built + failed + dead)),
    }
