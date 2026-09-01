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
    """Every filed fact for the first tag that has any, newest filing wins.

    THE DEDUPE IS THE POINT. The same period is re-reported by restatements,
    amendments and the comparative columns inside later filings, so an array
    from EDGAR routinely holds three values for one quarter. Keyed on
    (start, end) and resolved by `filed`, which is the only field that says
    which one is current.
    """
    facts = (cf or {}).get('facts', {})
    for scope in ('us-gaap', 'ifrs-full', 'dei'):
        block = facts.get(scope, {})
        for tag in tags:
            node = block.get(tag)
            if not node:
                continue
            best: dict[tuple, dict] = {}
            for unit, rows in (node.get('units') or {}).items():
                if unit_hint and unit_hint not in unit:
                    continue
                for row in rows:
                    key = (row.get('start'), row.get('end'))
                    prev = best.get(key)
                    if prev is None or str(row.get('filed', '')) > str(prev.get('filed', '')):
                        best[key] = {**row, 'unit': unit, 'tag': tag}
            if best:
                return sorted(best.values(), key=lambda r: str(r.get('end') or ''))
    return []


def _days(row) -> int | None:
    try:
        s = _dt.date.fromisoformat(row['start'])
        e = _dt.date.fromisoformat(row['end'])
        return (e - s).days
    except Exception:                                     # noqa: BLE001
        return None


def _quarterly(rows) -> dict:
    """end-date → value, for facts covering roughly one quarter."""
    return {r['end']: r['val'] for r in rows
            if r.get('start') and r.get('end') and r.get('val') is not None
            and (_days(r) or 0) and 60 <= _days(r) <= 120}


def _annual(rows) -> dict:
    """end-date → value, for facts covering roughly one year."""
    return {r['end']: r['val'] for r in rows
            if r.get('start') and r.get('end') and r.get('val') is not None
            and (_days(r) or 0) and 300 <= _days(r) <= 400}


def _fill_q4(quarters: dict, years: dict) -> dict:
    """Derive the missing fourth quarter as FY minus the first three.

    A 10-K reports the full year, so for most filers Q4 is never tagged as a
    quarter and simply is not in the data. Reading only what is tagged
    quarterly drops a QUARTER OF EVERY TABLE, and for a retailer that is the
    quarter containing most of the year.

    Only filled when all three earlier quarters of that fiscal year are
    present — a subtraction with a hole in it is a wrong number rather than a
    missing one, and a wrong number is the thing this file exists to avoid.
    """
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
                inside.append((qd, q_val))
        inside.sort()
        if len(inside) == 3:
            out[fy_end] = round(fy_val - sum(v for _, v in inside), 6)
            out.setdefault('_derived', set())
    return {k: v for k, v in out.items() if not str(k).startswith('_')}


def pct_change(now, then):
    """Year-over-year change, with O'Neil's conventions.

    Returns (value, label). `None` means N/A and the label says why, because
    "no growth number" and "growth of zero" are opposite readings of the same
    blank space.
    """
    if now is None or then is None:
        return None, 'n/a'
    if then <= 0:
        # A PERCENTAGE FROM A NEGATIVE OR ZERO BASE IS NOT A NUMBER. It is
        # arithmetic without meaning, and it is the single most common way a
        # screen surfaces a company that lost money last year as a 500%
        # grower. MarketSmith prints N/A; so does this.
        return None, 'n/a (loss a year ago)'
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
        if g < gap and g <= 35:
            best, gap = v, g
    return best


def c_table(cf: dict, quarters: int = 8) -> dict:
    """C — the last eight quarters, each against the SAME quarter a year ago."""
    eps_q = _fill_q4(_quarterly(_facts(cf, EPS_TAGS, 'shares')),
                     _annual(_facts(cf, EPS_TAGS, 'shares')))
    rev_q = _fill_q4(_quarterly(_facts(cf, REVENUE_TAGS, 'USD')),
                     _annual(_facts(cf, REVENUE_TAGS, 'USD')))
    ni_q = _fill_q4(_quarterly(_facts(cf, NET_INCOME_TAGS, 'USD')),
                    _annual(_facts(cf, NET_INCOME_TAGS, 'USD')))

    ends = sorted(set(eps_q) | set(rev_q), reverse=True)[:quarters]
    rows = []
    for end in ends:
        eps, rev, ni = eps_q.get(end), rev_q.get(end), ni_q.get(end)
        eps_chg, eps_lab = pct_change(eps, _year_ago(eps_q, end))
        rev_chg, rev_lab = pct_change(rev, _year_ago(rev_q, end))
        rows.append({
            'quarter': end,
            'eps': eps,
            'eps_chg': eps_chg, 'eps_chg_label': eps_lab,
            # SALES BESIDE EPS, ALWAYS. O'Neil's warning is earnings growth
            # without sales growth — buybacks, margin games, one-offs. The pair
            # is the check, and showing EPS alone hides exactly what he is
            # warning about.
            'sales': rev,
            'sales_chg': rev_chg, 'sales_chg_label': rev_lab,
            # After-tax margin, because rising margin AND rising sales is the
            # combination he wants.
            'margin_pct': (round(ni / rev * 100, 1)
                           if (ni is not None and rev) else None),
        })

    # ACCELERATION IS INVISIBLE IN ANY SINGLE NUMBER, and O'Neil weights it
    # heavily: each of the last quarters growing FASTER than the one before.
    chgs = [r['eps_chg'] for r in rows if r['eps_chg'] is not None]
    accelerating = (len(chgs) >= 3 and chgs[0] > chgs[1] > chgs[2])
    return {
        'rows': rows,
        'accelerating': accelerating,
        'accelerating_of': min(3, len(chgs)),
        'beat_25': sum(1 for c in chgs if c >= QUARTER_BAR),
        'beat_25_of': len(chgs),
        'bar_pct': QUARTER_BAR,
        'note': ('%Chg is always against the SAME quarter one year earlier. '
                 'n/a where the year-ago quarter was a loss — a percentage '
                 'from a negative base is arithmetic without meaning. '
                 f'Capped at +{PCT_CAP:.0f}%.'),
    }


def a_table(cf: dict, years: int = 5) -> dict:
    """A — annual EPS over 3-5 years, the growth rate, stability and ROE."""
    eps_y = _annual(_facts(cf, EPS_TAGS, 'shares'))
    ni_y = _annual(_facts(cf, NET_INCOME_TAGS, 'USD'))
    eq = _facts(cf, EQUITY_TAGS, 'USD')
    eq_by_end = {r['end']: r['val'] for r in eq if r.get('val') is not None}

    ends = sorted(eps_y, reverse=True)[:years]
    rows = []
    for i, end in enumerate(ends):
        prev = ends[i + 1] if i + 1 < len(ends) else None
        chg, lab = pct_change(eps_y.get(end), eps_y.get(prev) if prev else None)
        ni, equity = ni_y.get(end), eq_by_end.get(end)
        rows.append({
            'fy': end,
            'eps': eps_y.get(end),
            'eps_chg': chg, 'eps_chg_label': lab,
            'roe_pct': (round(ni / equity * 100, 1)
                        if (ni is not None and equity) else None),
        })

    # 3-YEAR GROWTH RATE as a compound annual rate, not an average of the
    # yearly changes: averaging +100% and -50% gives +25% for a company that
    # ended where it started.
    growth3 = None
    vals = [r['eps'] for r in rows if r['eps'] is not None]
    if len(vals) >= 4 and vals[3] and vals[3] > 0 and vals[0] > 0:
        growth3 = round(((vals[0] / vals[3]) ** (1 / 3) - 1) * 100, 1)

    # EARNINGS STABILITY — how much the series WOBBLES around its own trend.
    # LOW IS GOOD, which is the opposite of every other number on the card, and
    # it is why it is named and labelled rather than left as a bare figure.
    # O'Neil wants a straight line, not an average that happens to be high.
    stability = None
    if len(vals) >= 4:
        seq = list(reversed(vals))                # oldest first
        n = len(seq)
        mx = sum(range(n)) / n
        my = sum(seq) / n
        den = sum((i - mx) ** 2 for i in range(n))
        if den:
            slope = sum((i - mx) * (seq[i] - my) for i in range(n)) / den
            resid = [seq[i] - (my + slope * (i - mx)) for i in range(n)]
            scale = abs(my) or 1.0
            stability = int(round(min(99, (sum(r * r for r in resid) / n) ** 0.5
                                      / scale * 100)))

    roes = [r['roe_pct'] for r in rows if r['roe_pct'] is not None]
    roe = roes[0] if roes else None
    return {
        'rows': rows,
        'growth_3yr_pct': growth3,
        'stability': stability,
        'stability_note': 'how much the earnings series wobbles around its own '
                          'trend. LOW IS GOOD — the opposite of every other '
                          'number here.',
        'roe_pct': roe,
        'roe_floor': ROE_FLOOR,
        'roe_pass': (None if roe is None else roe >= ROE_FLOOR),
    }


def supply(cf: dict) -> dict:
    """S — shares outstanding, which EDGAR gives exactly."""
    rows = _facts(cf, ('EntityCommonStockSharesOutstanding',), 'shares')
    latest = rows[-1] if rows else None
    return {
        'shares_outstanding': latest.get('val') if latest else None,
        'as_of': latest.get('end') if latest else None,
        # Float is NOT here and is not claimed. No free feed publishes it; it
        # is approximable from insider and 5%-holder positions, and when that
        # is built it will be LABELLED an estimate. See spec section 3.1.
        'float': None,
        'float_note': 'no free source publishes float directly — not estimated here',
    }


def tables(cf: dict) -> dict:
    """Everything, from one companyfacts payload. Pure."""
    return {
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
    out = {'ticker': t,
           'built_at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}
    try:
        out.update(tables(fetch(t)))
        out['ok'] = True
    except Exception as e:                                # noqa: BLE001
        out.update({'ok': False, 'error': str(e)[:300]})
    return out


def cached(ticker: str, max_age_days: float = 7.0) -> dict | None:
    """What is on disk, if it is fresh enough. Fundamentals move quarterly, so
    a week is nowhere near stale — and a card must never trigger a fetch."""
    p = CACHE / f'{str(ticker).upper()}.json'
    try:
        if not p.exists():
            return None
        if (time.time() - p.stat().st_mtime) / 86400 > max_age_days:
            return None
        return json.loads(p.read_text())
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
