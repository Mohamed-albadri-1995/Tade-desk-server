"""I — institutional sponsorship, counted from SEC Form 13F.

WHAT O'NEIL MEANS BY I, AND WHAT HE DOES NOT.

    "A stock needs a few institutional sponsors with better-than-average
     recent performance."

Two halves, and the second is the one that carries the signal:

  PRESENT   Some funds own it. A stock no institution owns has not been
            found yet, and it is institutional buying that moves price —
            an individual cannot lift a stock, a fund building a position
            over weeks can.
  INCREASING  The COUNT is rising quarter over quarter. That is the whole
            point. A flat count means the sponsorship is already in and the
            fuel is spent; a rising count is money still arriving.

And the trap he is equally clear about: a stock EVERY fund already owns is
over-owned, not well-sponsored. There is nobody left to buy it. So this
reports the number and its direction and refuses to score it — "more is
better" is false at both ends, and a single letter grade would hide that.

WHY THE FILER COUNT AND NOT THE SHARE COUNT. Shares held is dominated by the
three or four giant index funds, which own everything and tell you nothing
about this stock. The NUMBER OF DISTINCT MANAGERS is the measure that moves
when a new fund decides to own something, which is the event worth seeing.

THE SOURCE, AND WHY THIS ONE. Every manager with $100M+ in 13(f) securities
files a holdings list within 45 days of each quarter end. Counting holders per
stock means reading ALL of them — about six thousand filings a quarter. Fetched
one at a time that is six thousand requests per quarter and unworkable.

The SEC publishes the same data as a quarterly structured data set: one ZIP
holding every filing's INFOTABLE as a TSV. One download per quarter instead of
six thousand requests, and it is the identical data.

THE CUSIP PROBLEM, STATED PLAINLY. 13F identifies securities by CUSIP; our
universe is tickers; and the CUSIP-to-ticker table is licensed and not free.
So the issuer NAME on the filing is matched against the company names EDGAR
already gave us during the SIC walk, normalised on both sides. A CUSIP that
matches once is remembered, so later quarters keep working even when a filer
writes the name differently.

Nothing is guessed. A stock whose CUSIP never matched a name reports NO DATA
rather than a number, and the build reports its own coverage so a thin match
rate is visible rather than silently becoming "no institutions own this".

PARSING IS SEPARATE FROM FETCHING. Everything below `parse_` and `count_` is
pure and provable offline against a hand-built TSV; only `fetch_` touches the
network.
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from pathlib import Path

# WHERE THE SEC LISTS THE FILES. The links are read from here rather than
# constructed, and that is the whole fix.
#
# The comment that used to sit here said the name "is not guessable from the
# quarter alone" — and then guessed it three ways. Which is one guess written
# out three times, and it was wrong every night for as long as this existed:
#
#   2025Q3: no dataset found. Tried: [three urls]   404, 404, 404
#   2025Q4 … 2026Q1 … 2026Q2                        all 404
#   [ok  ] institutional sponsorship (I): not built
#
# Twelve 404s and not one 403, so the paths were wrong rather than the
# User-Agent — EDGAR answered 14,583 requests on the same UA in the same run
# with nothing refused. A filename that is not guessable has to be READ.
INDEX_URL = ('https://www.sec.gov/data-research/sec-markets-data/'
             'form-13f-data-sets')

# KEPT AS A FALLBACK, NOT AS THE PLAN. These may still be right for older
# quarters, and swapping a path that might work for another that might work is
# not progress — the discovered link is tried first, these only after it.
URL_PATTERNS = (
    'https://www.sec.gov/files/structureddata/data/form-13f-data-sets/{y}q{q}_form13f.zip',
    'https://www.sec.gov/files/dera/data/form-13f-data-sets/{y}q{q}_form13f.zip',
    'https://www.sec.gov/files/structureddata/data/form-13f-data-sets/{y}q{q}_form13f_data.zip',
)

SHARED = Path(os.environ.get('ONEIL_13F_FILE')
              or (Path(__file__).resolve().parents[2] / 'data' / 'oneil-13f.json'))

CACHE = Path(os.environ.get('QP_13F_CACHE')
             or (Path.home() / '.qp-cache' / 'f13'))

# How many quarters of history to keep on the card. Four is a year: enough to
# see a direction rather than one quarter's noise, and short enough that a
# position built two years ago does not read as news.
QUARTERS = int(os.environ.get('QP_13F_QUARTERS') or 4)

# Words that appear in a company name without identifying it. Stripped from
# both sides before matching, because "APPLE INC" and "APPLE INC." and
# "APPLE INC COM" are one company and three strings.
_NOISE = re.compile(
    r'\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|LP|LLC|'
    r'HLDGS?|HOLDINGS?|GROUP|GRP|THE|CLASS|CL|COM|COMMON|STOCK|SHS|SHARES|'
    r'NEW|ORD|ADR|ADS|SA|NV|AG|TR|TRUST)\b')


def normalize_name(s: str) -> str:
    """A company name reduced to what identifies it.

    Both sides of the match go through this. It is deliberately blunt: the
    alternative is fuzzy matching, and a fuzzy match that is wrong attributes
    one company's institutional ownership to another — a worse outcome than
    reporting nothing, which is what a miss does here.
    """
    s = str(s or '').upper()
    s = s.replace('&', ' AND ')
    s = re.sub(r'[^A-Z0-9 ]+', ' ', s)
    # THE CLASS LETTER GOES WITH THE WORD "CLASS", not after it. Stripping CL
    # and CLASS on their own left the letter stranded — "ALPHABET INC CL A"
    # normalised to "ALPHABET A" and stopped matching "Alphabet Inc.", which
    # silently dropped every dual-class company from the count.
    s = re.sub(r'\b(?:CL|CLASS|SER|SERIES)\s+[A-Z]\b', ' ', s)
    s = _NOISE.sub(' ', s)
    return ' '.join(s.split())


# The three columns anything downstream uses. Everything else in an INFOTABLE
# — value, share counts, put/call, discretion, voting authority — is weight we
# carry through memory and disk for no reading.
KEEP_COLS = ('ACCESSION_NUMBER', 'CUSIP', 'NAMEOFISSUER')
# WHO FILED IT, AND WHAT PERIOD IT DESCRIBES. INFOTABLE knows neither: it
# identifies a holding by the FILING it arrived in, so an amendment reads as a
# second holder, and it says nothing at all about which quarter the holdings
# are as of — that has been INFERRED from the SEC's filename, twice, wrongly
# once. Both facts are in SUBMISSION.tsv, a few thousand rows.
SUB_COLS = ('ACCESSION_NUMBER', 'CIK', 'SUBMISSIONTYPE', 'PERIODOFREPORT')


def _sub_path(hit):
    """The submissions file that belongs to this quarter's INFOTABLE cache.

    A SIBLING, AND THE PAIR IS THE CACHE UNIT. Either one alone is a quarter
    that cannot be counted properly, so `fetch_quarter` re-fetches unless both
    are present and non-empty.
    """
    return hit.with_name(hit.stem + '.sub.tsv')


def _parse_rows(lines) -> dict:
    """The counting, over ANY iterable of lines.

    STREAMED, NEVER MATERIALISED. This took a single `str` and called
    `.splitlines()` on it — for a 338MB quarter that is a list of about thirty
    million string objects, well over a gigabyte in per-object overhead alone
    before any content. Combined with the download holding the whole zip and
    the whole decompressed member in RAM at the same time, one quarter peaked
    at several gigabytes and took the machine's ssh down with it.

    So the caller decides where lines come from: a small hand-built string in
    the audits, a file handle in production. Nothing here ever holds more than
    one row.

    One row per holding. The same manager filing the same quarter appears once
    per position, so holders are counted by DISTINCT ACCESSION NUMBER — a
    manager reporting three share classes of one issuer is one holder, not
    three, and counting rows instead would inflate exactly the widely-held
    names that are already over-owned.
    """
    out: dict[str, dict] = {}
    it = iter(lines)
    try:
        header = next(it)
    except StopIteration:
        return out
    head = [h.strip().upper() for h in header.rstrip('\n').split('\t')]
    try:
        i_acc = head.index('ACCESSION_NUMBER')
        i_cusip = head.index('CUSIP')
    except ValueError:
        return out
    i_name = head.index('NAMEOFISSUER') if 'NAMEOFISSUER' in head else None

    # ACCESSIONS ARE STORED AS SHARED IDS, NOT AS THEIR OWN STRINGS.
    #
    # There is one (cusip, accession) pair per holding row and a real quarter
    # is a few million of them, but only about SIX THOUSAND distinct
    # accessions — every manager's filing appears once per position it holds.
    # Adding `parts[i_acc].strip()` gave each row its own str object: about
    # 300MB of duplicates per quarter, on a box with 1GB in total and twenty
    # other processes already on it.
    #
    # Mapping each accession to an int once means the sets hold repeated
    # pointers to ~6,000 shared objects instead. Same count, a third of the
    # memory. `count_holders` only ever takes len(), so what is IN the set is
    # this function's business alone.
    ids: dict = {}
    for line in it:
        line = line.rstrip('\n')
        if not line.strip():
            continue
        parts = line.split('\t')
        if len(parts) <= max(i_acc, i_cusip):
            continue
        cusip = parts[i_cusip].strip().upper()
        if not cusip:
            continue
        rec = out.setdefault(cusip, {'name': '', 'accessions': set()})
        acc = parts[i_acc].strip()
        aid = ids.get(acc)
        if aid is None:
            aid = ids[acc] = len(ids)
        rec['accessions'].add(aid)
        if i_name is not None and not rec['name'] and len(parts) > i_name:
            rec['name'] = parts[i_name].strip()
    return out


def parse_infotable(text: str) -> dict:
    """INFOTABLE.tsv text → {cusip: {'name', 'accessions'}}.

    For hand-built fixtures. Production reads the file — see
    `parse_infotable_file` — because a real quarter does not fit in memory
    as one string, let alone as a list of its lines.
    """
    return _parse_rows((text or '').splitlines())


def parse_infotable_file(path) -> dict:
    """The same answer, read a line at a time from disk. Flat memory."""
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return _parse_rows(fh)


def count_holders(parsed: dict) -> dict:
    """{cusip: number of distinct managers holding it}."""
    return {c: len(r['accessions']) for c, r in (parsed or {}).items()}


def _columns(header: str):
    """(accession index, cusip index, name index or None), or None."""
    head = [h.strip().upper() for h in (header or '').rstrip('\n').split('\t')]
    try:
        return (head.index('ACCESSION_NUMBER'), head.index('CUSIP'),
                head.index('NAMEOFISSUER') if 'NAMEOFISSUER' in head else None)
    except ValueError:
        return None


def parse_issuers(lines) -> dict:
    """{cusip: issuer name}, and nothing else.

    THE CHEAP HALF OF THE FILE, and it has to be read on its own.

    Working out which ticker a CUSIP belongs to needs only its NAME. Counting
    holders needs its ACCESSION NUMBERS, which are the millions of rows. Split
    apart, the whole name map can be built across every quarter before any
    counting starts — and it has to be, because the map only ever grows: an
    issuer whose name is spelled recognisably in the newest quarter is the
    same issuer in the oldest, and rolling counts up before the map is
    complete attributes the oldest quarter's holders to nobody.
    """
    out: dict[str, str] = {}
    it = iter(lines)
    try:
        cols = _columns(next(it))
    except StopIteration:
        return out
    if not cols:
        return out
    _, i_cusip, i_name = cols
    if i_name is None:
        return out
    for line in it:
        parts = line.rstrip('\n').split('\t')
        if len(parts) <= max(i_cusip, i_name):
            continue
        cusip = parts[i_cusip].strip().upper()
        if cusip and cusip not in out:
            name = parts[i_name].strip()
            if name:
                out[cusip] = name
    return out


def count_by_ticker(lines, cusip_ticker: dict) -> dict:
    """{ticker: distinct managers holding this ISSUER}, over any line source.

    AN ISSUER IS NOT A CUSIP, AND THAT IS THE WHOLE CORRECTION.

    13F identifies securities, not companies. One company routinely appears
    under several CUSIPs in the same quarter — the common stock, a convertible
    note, and the listed options all carry NAMEOFISSUER "APPLE INC" — so
    matching by name maps several CUSIPs to one ticker, correctly.

    The old code then counted holders PER CUSIP and appended one entry per
    CUSIP per quarter to the ticker's history. Live, on every mega-cap:

        I  holders 1 · change -5956 · falling

    "1" was whichever CUSIP happened to sort last among the newest quarter's
    entries — a bond nobody holds — and the -5956 was a trend computed across
    a list that mixed different securities with different quarters. Every
    number was arithmetically correct about the wrong thing.

    Counting the UNION of accessions across a ticker's CUSIPs is the answer,
    and summing them is not: a fund holding both the stock and the converts
    files one 13F and is one holder. That is the rule this module already
    states for share classes within a CUSIP — "a manager reporting three share
    classes of one issuer is one holder, not three" — applied one level up,
    where it was being broken.

    STREAMED, and lighter than what it replaces: only the ~3,500 tickers that
    matched are accumulated, not all ~34,000 securities, and the accession ids
    are interned exactly as in `_parse_rows`.
    """
    return count_quarter(lines, cusip_ticker)[0]


def count_quarter(lines, cusip_ticker: dict, acc_cik: dict | None = None):
    """({ticker: managers}, how many managers filed AT ALL this quarter).

    `acc_cik` MAPS FILING → MANAGER, and without it this counts filings. A
    manager that files 13F-HR and corrects it with 13F-HR/A has two accession
    numbers and was one holder all along. Live, the "managers filing" count
    that made this visible:

        2025Q3  8570      2025Q4  9364      2026Q1  9716

    Thirteen percent in three quarters, where the real population moves a few
    percent a year. The excess is amendments, and the same inflation was
    inside every per-ticker count.

    Passing nothing still works and still answers — a quarter cached before
    SUBMISSION.tsv was extracted has no map — but the caller must then say the
    unit is the filing, because an approximation that is not labelled is
    indistinguishable from the measurement.

    THE SECOND NUMBER IS WHAT MAKES THE FIRST READABLE.

    From the field check, after the per-CUSIP fault above was fixed:

        AAPL  6693  +729 rising      NVDA  6343  +792 rising
        MSFT  6807  +635 rising      AMD   3442  +736 rising
        PLTR  3209  +483 rising

    Five different companies, five different industries, all rising, all by
    roughly the same amount. That is the shape of the POPULATION growing —
    more managers crossing the $100M threshold and filing at all — and not of
    five stocks independently attracting sponsors. Read as sponsorship it says
    "everything is being accumulated", which is never true and is exactly the
    kind of confident wrong number this module exists to refuse.

    Whether it IS that cannot be settled by looking at the counts, because the
    denominator was never published. So it is published: the number of
    distinct filings in the quarter, counted in the same pass, at the cost of
    interning the accessions of unmapped securities too — a few thousand
    strings against the millions of rows already being read.

    The reading is left alone for now. A count of 6,693 out of 7,400 filers is
    a different fact from 6,693 out of 12,000, and until the two are side by
    side there is nothing to decide.
    """
    acc: dict[str, set] = {}
    it = iter(lines)
    try:
        cols = _columns(next(it))
    except StopIteration:
        return {}, 0
    if not cols:
        return {}, 0
    i_acc, i_cusip, _ = cols
    # EVERY FILER IS INTERNED, whether or not it holds anything we matched —
    # that is what makes `ids` the population rather than "filers who hold
    # something we recognise", a number that moves when the NAME MATCHING
    # improves and would read as institutions arriving.
    #
    # The id is per MANAGER when the submissions map is present and per FILING
    # when it is not, and interning both through the same dict keeps the two
    # paths identical everywhere below this line.
    ids: dict = {}
    for line in it:
        parts = line.rstrip('\n').split('\t')
        if len(parts) <= max(i_acc, i_cusip):
            continue
        a = parts[i_acc].strip()
        if not a:
            continue
        who = (acc_cik or {}).get(a, a)
        aid = ids.get(who)
        if aid is None:
            aid = ids[who] = len(ids)
        t = cusip_ticker.get(parts[i_cusip].strip().upper())
        if t is None:
            continue
        s = acc.get(t)
        if s is None:
            acc[t] = {aid}
        else:
            s.add(aid)
    return {t: len(s) for t, s in acc.items()}, len(ids)


def parse_submissions(lines):
    """({accession: cik}, {period: how many filings said so}).

    WHO FILED, AND WHAT THEY SAY THE PERIOD IS. Both facts were being
    substituted for by something close but not equal:

      the manager   was the ACCESSION NUMBER, which is the FILING. A manager
                    that amends files twice and was counted as two holders.
      the quarter   was INFERRED from the SEC's filename. That inference has
                    been made twice in this file and was wrong once, printing
                    2026Q2 on a card in September for holdings as of 31 March.

    PERIODOFREPORT is what the filer itself states, so the second stops being
    an argument and becomes a measurement.

    Every submission is counted, amendments included: an amendment is still a
    filing about that period, and dropping them here would only move the
    guessing somewhere else. The CIK map is what removes the double count.
    """
    cik: dict[str, str] = {}
    periods: dict[str, int] = {}
    it = iter(lines)
    try:
        header = next(it)
    except StopIteration:
        return cik, periods
    head = [h.strip().upper() for h in header.rstrip('\n').split('\t')]
    try:
        i_acc = head.index('ACCESSION_NUMBER')
    except ValueError:
        return cik, periods
    i_cik = head.index('CIK') if 'CIK' in head else None
    i_per = head.index('PERIODOFREPORT') if 'PERIODOFREPORT' in head else None
    if i_cik is None:
        return cik, periods
    want = max(i for i in (i_acc, i_cik, i_per) if i is not None)
    for line in it:
        parts = line.rstrip('\n').split('\t')
        if len(parts) <= want:
            continue
        acc, c = parts[i_acc].strip(), parts[i_cik].strip()
        if not acc or not c:
            continue
        cik[acc] = c
        if i_per is not None:
            per = parts[i_per].strip()
            if per:
                periods[per] = periods.get(per, 0) + 1
    return cik, periods


def period_quarter(periods: dict):
    """The (year, quarter) the FILERS say this dataset is about, or None.

    THE MODE, NOT THE MAXIMUM AND NOT THE FIRST. A filing window catches late
    filers for the quarter before and a handful of early ones after, so a
    dataset always holds a few stray periods. The one the overwhelming
    majority state is the dataset's period; a scattering of others is normal
    and must not move the label.

    Refuses rather than guesses when no period is clearly dominant — below
    two-thirds, something is wrong with the assumption and a label would be
    the confident kind of wrong.
    """
    if not periods:
        return None
    total = sum(periods.values())
    best, n = max(periods.items(), key=lambda kv: kv[1])
    if not total or n / total < 0.66:
        return None
    # 03-31-2026, 2026-03-31, 31-MAR-2026 — the SEC has written it more than
    # one way, so the year and month are picked out rather than parsed.
    m = re.search(r'(20\d\d)\D(\d{1,2})\D', best) or None
    if m:
        yy, mm = int(m.group(1)), int(m.group(2))
    else:
        m = re.search(r'(\d{1,2})\D(\d{1,2})\D(20\d\d)', best)
        if not m:
            return None
        yy, mm = int(m.group(3)), int(m.group(1))
    if not 1 <= mm <= 12:
        return None
    return yy, (mm - 1) // 3 + 1


def parse_issuers_file(path) -> dict:
    """`parse_issuers`, a line at a time from disk. Flat memory."""
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return parse_issuers(fh)


def parse_submissions_file(path):
    """`parse_submissions`, a line at a time from disk. Flat memory."""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            return parse_submissions(fh)
    except OSError:
        # A quarter cached before submissions were extracted. Not an error —
        # the caller falls back to counting filings and says which it did.
        return {}, {}


def count_by_ticker_file(path, cusip_ticker: dict) -> dict:
    """`count_by_ticker`, a line at a time from disk. Flat memory."""
    return count_quarter_file(path, cusip_ticker)[0]


def count_quarter_file(path, cusip_ticker: dict, acc_cik: dict | None = None):
    """`count_quarter`, a line at a time from disk. Flat memory."""
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return count_quarter(fh, cusip_ticker, acc_cik)


def match_cusips(parsed: dict, name_to_tickers: dict) -> dict:
    """{cusip: ticker}, by exact match on the normalised issuer name.

    EXACT, after normalising — never nearest. A name that normalises to
    something two companies share is dropped rather than assigned to either:
    attributing Ford's sponsorship to Forward Industries is a worse answer
    than no answer, and no answer is what the card is built to show.
    """
    out = {}
    for cusip, rec in (parsed or {}).items():
        key = normalize_name(rec.get('name'))
        if not key:
            continue
        hit = name_to_tickers.get(key)
        if not hit or len(hit) != 1:
            continue                       # missing, or ambiguous → no claim
        out[cusip] = hit[0]
    return out


# HOW FAR THE SHARE MUST MOVE BEFORE IT IS A DIRECTION. Managers join and
# leave the $100M threshold every quarter and a stock's share of them wobbles
# by a percent or so on nobody's decision. Below this it is called flat, which
# is a real answer and the commonest one.
SHARE_BAND_PCT = 3.0


def trend(counts: list, filers: list | None = None) -> dict:
    """Oldest-first fund counts → the reading O'Neil actually wants.

    Direction, not a score. "More is better" is false at both ends: no
    sponsorship means undiscovered, and universal sponsorship means there is
    nobody left to buy. So this says which way it is moving and by how much,
    and leaves the judgement where it belongs.

    THE DIRECTION IS THE SHARE OF FILERS, NOT THE COUNT, and that is the
    correction. The population of managers filing 13F is not constant:

        2025Q2 8,060 · 2025Q3 8,034 · 2025Q4 8,636 · 2026Q1 8,759

    +8.7% in three quarters, and every widely-held name rides it up. Live, all
    five mega-caps on the screen printed "rising":

        MSFT  +431 rising      but  71.2% -> 70.4% of filers   FALLING
        AAPL  +537 rising           68.6% -> 69.2%             flat
        NVDA  +605 rising           64.9% -> 66.6%             flat
        AMD   +649 rising           31.4% -> 36.3%             rising, +15.7%
        PLTR  +411 rising           32.1% -> 34.2%             rising, +6.6%

    Microsoft was LOSING sponsors relative to the managers who could hold it
    while the card said money was arriving. O'Neil's I is new funds DECIDING
    to buy this stock; a manager that starts filing this quarter and indexes
    everything has decided nothing about Microsoft, and dividing by the
    population is what removes it.

    RELATIVE, NOT IN POINTS. Half a point is noise at 70% and a sixth of the
    position at 3%, so the move is measured against where it started.

    THE RAW CHANGE STAYS. It is a true fact about the stock and dropping it
    would hide as much as normalising reveals — the card prints both.

    Without `filers` — an older file, or a quarter whose population is not
    known — this falls back to the count and says so in `direction_basis`, on
    the same principle as `holder_unit`: an approximation that is not labelled
    is indistinguishable from the measurement.

    `quarters_counted`, NOT `quarters`. The caller does

        row['quarters'] = [{'q': ..., 'funds': ...}, ...]   the history
        row.update(trend([...]))

    and this returned a key called `quarters` holding a COUNT, so `update`
    replaced the history with the integer 4. The four-quarter history has
    therefore never once reached the published file, for any stock — and the
    card, reading `(fs.quarters || []).map(...)`, was handed a number and
    threw, taking the whole CANSLIM fold down on exactly the 24% of stocks
    that HAVE 13F data. Reported at the time as "no can slim inside cards".

    Two dictionaries merged by `update` share one namespace. A name that is
    right in isolation can still be the wrong name there.
    """
    vals = [c for c in (counts or []) if c is not None]
    if len(vals) < 2:
        return {'direction': None, 'change': None, 'change_pct': None,
                'change_share_pct': None, 'direction_basis': None,
                'note': 'needs two quarters to have a direction'}
    first, last = vals[0], vals[-1]
    change = last - first
    pct = round(change / first * 100, 1) if first else None

    # THE SHARE SERIES, when the population of every quarter is known. A
    # partial one is refused rather than patched: mixing a share against one
    # quarter's filers with a count against another's is the same fault as
    # comparing a cover-page share count with a weighted average.
    shares = None
    if filers and len(filers) == len(vals) and all(f for f in filers):
        shares = [round(c / f * 100, 1) for c, f in zip(vals, filers)]

    if shares and shares[0]:
        move = (shares[-1] / shares[0] - 1) * 100
        basis = 'share'
    else:
        move = pct if pct is not None else 0.0
        basis = 'count'
    band = SHARE_BAND_PCT if basis == 'share' else 0.0
    direction = ('rising' if move > band
                 else 'falling' if move < -band else 'flat')

    # STILL CLIMBING, OR ROSE ONCE AND FADED? Two stocks with the same
    # year-over-year gain, live:
    #
    #     AMD    31.4 → 33.1 → 35.6 → 36.3     +15.6%   every quarter up
    #     PLTR   32.1 → 34.9 → 34.8 → 34.2      +6.5%   up once, down three
    #
    # Both read "rising", because only the first quarter and the last were
    # compared and everything between was thrown away. But O'Neil's I is money
    # STILL ARRIVING — a stock that gained sponsors a year ago and has been
    # losing them for three quarters is not being accumulated, it is being
    # distributed, and the word that hides the difference is the one a reader
    # acts on.
    #
    # This is the same shape as C's `accelerating`, which already refuses to
    # judge a trend from its endpoints: chgs[0] > chgs[1] > chgs[2].
    #
    # THE LAST STEP DECIDES, not the last two out of four. A year's gain that
    # is over is still a year's gain — `change_share_pct` keeps saying so —
    # and what changes is only whether it is still happening.
    last_step = None
    if shares and len(shares) >= 2 and shares[-2]:
        last_step = round((shares[-1] / shares[-2] - 1) * 100, 1)
        if direction == 'rising' and last_step < 0:
            direction = 'peaked'
        elif direction == 'falling' and last_step > 0:
            # THE MIRROR, AND IT MATTERS MORE. A stock down over the year but
            # turning up in the newest quarter is the one being picked up
            # again, which is the whole event worth catching.
            direction = 'turning up'
    return {
        'direction': direction,
        'direction_basis': basis,
        # BOTH NUMBERS. The raw change is what happened; the share change is
        # what it means once the population is taken out.
        'change': change,
        'change_pct': pct,
        'change_share_pct': round(move, 1) if basis == 'share' else None,
        # AND THE NEWEST STEP ON ITS OWN, so "peaked" can be checked rather
        # than believed.
        'last_step_pct': last_step,
        'share_pct': shares,
        'quarters_counted': len(vals),
    }


def recent_quarters(n: int = QUARTERS, today=None) -> list:
    """The n most recently FILED quarters, newest last.

    A 13F is due 45 days after the quarter ends, so the quarter that just
    finished is not published yet and asking for it gets a 404. The current
    quarter is skipped and so is the one before it until that window has
    passed — a card showing an empty quarter reads as "the funds sold out",
    which is the opposite of "it has not been filed".
    """
    import datetime as _dt
    d = today or _dt.date.today()
    q = (d.month - 1) // 3 + 1
    y = d.year
    # Step back to the last quarter whose 45-day filing window has closed.
    # Measured from the END of the previous quarter, which is what the
    # deadline is actually counted from — measuring from the start of the
    # current one is a day out and puts the boundary on the wrong side.
    prev_q_end = _dt.date(y, q * 3 - 2, 1) - _dt.timedelta(days=1)
    back = 1 if (d - prev_q_end).days >= 45 else 2
    for _ in range(back):
        q -= 1
        if q == 0:
            q, y = 4, y - 1
    out = []
    for _ in range(n):
        out.append((y, q))
        q -= 1
        if q == 0:
            q, y = 4, y - 1
    return list(reversed(out))


def _name_index() -> dict:
    """{normalised company name: [tickers]}, from the SIC walk's own cache.

    Reuses what is already on disk rather than fetching anything: the SIC pass
    stored every filer's name and tickers, which is exactly the table needed
    to turn an issuer name into a symbol.
    """
    from chart import sic
    idx: dict[str, list] = {}
    if not sic.CACHE.exists():
        return idx
    for p in sic.CACHE.glob('*.json'):
        try:
            rec = json.loads(p.read_text())
        except Exception:                                 # noqa: BLE001
            continue
        key = normalize_name(rec.get('name'))
        tickers = rec.get('tickers') or []
        if not key or not tickers:
            continue
        idx.setdefault(key, [])
        for t in tickers:
            if t not in idx[key]:
                idx[key].append(t)
    return idx


_ZIP_HREF = re.compile(r'href\s*=\s*["\']([^"\']+\.zip)["\']', re.I)
# 2026q2, 2026Q2, 2026-q2, "2026 Q2" — the SEC has written it every way.
_QUARTER = re.compile(r'(20\d\d)\D{0,3}[qQ]([1-4])')
# ...AND SOMETIMES NOT AS A QUARTER AT ALL. The newer sets are named for the
# period they cover — 01dec2025-28feb2026_form13f.zip — which carries the same
# fact in a shape the pattern above cannot see.
_DATED = re.compile(r'(\d{1,2})([a-z]{3})(20\d\d)', re.I)
_MONTHS = {m: i + 1 for i, m in enumerate(
    ('jan', 'feb', 'mar', 'apr', 'may', 'jun',
     'jul', 'aug', 'sep', 'oct', 'nov', 'dec'))}


def _report_quarter(year: int, month: int):
    """The quarter a filing window opening in (year, month) REPORTS ON.

    THE SEC NAMES THESE FILES FOR WHEN THE FILINGS ARRIVED, NEVER FOR WHAT
    THEY DESCRIBE, and the two are never the same quarter: a 13F is due 45
    days after the quarter it reports on ends. So the report quarter is the
    one whose deadline falls inside the window — which is the last quarter to
    have ENDED by the time the window opens:

        window opens Mar 2026 → Q1 2026 ended 31 Mar, due 15 May → Q1 2026
        window opens Dec 2025 → Q4 2025 ends 31 Dec, due 14 Feb  → Q4 2025
        window opens Oct 2023 → Q3 2023 ended 30 Sep, due 14 Nov → Q3 2023

    A window that opens ON a quarter end (the newer Mar/Jun/Sep/Dec sets)
    reports that quarter; one that opens after it (the older calendar-quarter
    sets, which open in Jan/Apr/Jul/Oct) reports the quarter before.

    WHY THIS IS THE RULE FOR BOTH NAMINGS. The listing runs 2013q2 … 2023q4 —
    43 files, every calendar quarter — and then continues 01dec2023-29feb2024,
    01mar2024-31may2024, and on. Read as filing windows the two sets are one
    unbroken run of report quarters with no gap and no repeat; read any other
    way the seam either duplicates a quarter or loses one. The SEC re-cut the
    windows by a month so that each one captures a single deadline cleanly,
    which is the same fact stated twice.

    This was wrong here for as long as 13F worked at all. Every card said
    2026Q2 in September 2026, for holdings as of 31 March. Caught by being
    read: "it's until q2 2026 now we are in September?"
    """
    if month % 3 == 0:                       # opens on a quarter end
        return year, month // 3
    q = (month - 1) // 3 + 1                 # the quarter it opens in
    return (year - 1, 4) if q == 1 else (year, q - 1)


def _qname(k) -> str:
    """(2026, 1) → '2026Q1'. One spelling, so log and file cannot disagree."""
    return f'{k[0]}Q{k[1]}'


def _quarter_of(name: str):
    """The (year, quarter) a data set's HOLDINGS are as of, from its filename.

    Not the quarter in the filename. See _report_quarter — the name is the
    filing window, the answer is what was filed in it.
    """
    m = _QUARTER.search(name)
    if m:
        # A calendar-quarter set opens on that quarter's first month.
        return _report_quarter(int(m.group(1)), int(m.group(2)) * 3 - 2)
    # THE START OF THE RANGE, NOT THE END. The window is three months long and
    # holds one deadline; where it finishes says nothing about which.
    dates = _DATED.findall(name)
    if dates:
        _, mon, year = dates[0]
        mi = _MONTHS.get(mon.lower())
        if mi:
            return _report_quarter(int(year), mi)
    return None


def parse_index(html: str):
    """((year, quarter) → absolute URL, [names it could not place]).

    PURE, so the parsing is provable without the network — which matters more
    here than anywhere else in this module, because the network is exactly
    what could not be checked when the guessed patterns were written.

    WHAT IT COULD NOT PLACE IS RETURNED, NOT DISCARDED. The first version did
    `if not m: continue`, and that silence was the whole bug: the page listed
    43 zips it could read, all of them 2023Q4 or older, and however many it
    could not — while the job asked for 2026Q2 and reported only that its own
    guesses had 404'd. A parser that drops input without saying so is the same
    fault as a URL that is guessed without being checked.

    Only links that look like 13F data are considered: the page carries other
    zips, and a quarter number alone does not tell them apart.
    """
    out, unplaced = {}, []
    for href in _ZIP_HREF.findall(html or ''):
        if '13f' not in href.lower():
            continue
        name = href.rsplit('/', 1)[-1]
        key = _quarter_of(name)
        if key is None:
            if name not in unplaced:
                unplaced.append(name)
            continue
        # RELATIVE LINKS ARE THE COMMON CASE on sec.gov — the page writes
        # "/files/…", and a bare join would produce a path with no host.
        url = href if href.startswith('http') else 'https://www.sec.gov' + (
            href if href.startswith('/') else '/' + href)
        # First link for a quarter wins: the page lists newest first, and a
        # later duplicate is an archive copy of the same data.
        out.setdefault(key, url)
    return out, unplaced


# One page fetch per run, not one per quarter.
_INDEX = {'html': None, 'urls': None, 'error': None, 'unplaced': []}


def discover_urls(log=print) -> dict:
    """Read the listing page once and remember what it offered."""
    if _INDEX['urls'] is not None or _INDEX['error'] is not None:
        return _INDEX['urls'] or {}
    from chart import edgar as _edgar
    import urllib.request
    try:
        req = urllib.request.Request(
            INDEX_URL, headers={'User-Agent': _edgar.UA,
                                'Accept': 'text/html'})
        with urllib.request.urlopen(req, timeout=60) as r:
            _INDEX['html'] = r.read().decode('utf-8', 'replace')
    except Exception as e:                                # noqa: BLE001
        # A LISTING PAGE THAT IS ITSELF GONE is a different fault from a
        # quarter that is not published, and must not be reported as one.
        _INDEX['error'] = f'{INDEX_URL} — {str(e)[:80]}'
        log(f'  13F index unreachable: {_INDEX["error"]}')
        return {}
    _INDEX['urls'], _INDEX['unplaced'] = parse_index(_INDEX['html'])
    log(f'  13F index: {len(_INDEX["urls"])} quarterly zips listed'
        + (f' — newest {max(_INDEX["urls"])}' if _INDEX['urls'] else '')
        # NAMED, NOT COUNTED. If the SEC has moved to a naming this cannot
        # read, these are the filenames that say so — and one line of them
        # ends the guessing for good.
        + (f' · {len(_INDEX["unplaced"])} could not be placed: '
           f'{", ".join(_INDEX["unplaced"][:4])}' if _INDEX['unplaced'] else ''))
    return _INDEX['urls']


def _index_summary() -> str:
    """What the index actually offered, for the failure message."""
    if _INDEX['error']:
        return f'index unreachable ({_INDEX["error"]})'
    urls = _INDEX['urls'] or {}
    if not urls:
        return ('index reachable but listed no 13F zips — the page layout or '
                f'its address has changed ({INDEX_URL})')
    names = [u.rsplit('/', 1)[-1] for _, u in sorted(urls.items(), reverse=True)]
    out = f'{len(urls)} listed, newest: {", ".join(names[:4])}'
    if _INDEX.get('unplaced'):
        out += (f' · {len(_INDEX["unplaced"])} UNPLACED: '
                f'{", ".join(_INDEX["unplaced"][:4])}')
    return out


def _reduce_member(zf, member, dest, keep=None) -> int:
    """Stream one INFOTABLE out of the zip, keeping only the columns read.

    NOTHING WHOLE IS EVER IN MEMORY. `zf.read(member)` returned the entire
    decompressed table — 338MB for one live quarter — and `.decode()` then
    made a second copy of it. Here the member is a file object, the
    destination is a file, and one row is resident at a time.

    REDUCED WHILE IT PASSES THROUGH. An INFOTABLE also carries value, share
    counts, put/call, discretion and voting authority, none of which anything
    downstream reads. Dropping them turns a 338MB cache entry into tens of MB,
    which is the difference between four quarters fitting on the disk and not.

    The kept columns keep their names, so a full INFOTABLE cached by the older
    code still parses and nothing has to be re-downloaded.

    Returns the number of data rows written.
    """
    import io as _io
    rows = 0
    with zf.open(member) as raw:
        text = _io.TextIOWrapper(raw, encoding='utf-8', errors='replace')
        header = text.readline()
        if not header:
            return 0
        head = [h.strip().upper() for h in header.rstrip('\n').split('\t')]
        idx = [head.index(c) for c in (keep or KEEP_COLS)
               if c in head]
        if not idx:
            # No recognisable columns. Written as-is rather than reduced to
            # nothing, so the failure is a parse error later with the real
            # file to look at, not a silently emptied cache.
            dest.write(header)
            for line in text:
                dest.write(line)
                rows += 1
            return rows
        kept = [head[i] for i in idx]
        dest.write('\t'.join(kept) + '\n')
        for line in text:
            parts = line.rstrip('\n').split('\t')
            if len(parts) <= idx[-1]:
                continue
            dest.write('\t'.join(parts[i] for i in idx) + '\n')
            rows += 1
    return rows



def _extract(zf, suffix, dest_path, keep, log, label):
    """Reduce the largest member ending `suffix` into `dest_path`. Rows, or 0.

    THE BIGGEST MATCH, NOT THE FIRST. A zip can carry a stub or a directory
    entry whose name also ends INFOTABLE.TSV, and taking `names[0]` picked one
    of those — the real table is by a wide margin the largest member, so size
    is the reliable way to find it.

    WRITTEN THROUGH A TEMP AND RENAMED, so an interrupted extraction cannot
    leave a short file that the next run would serve as complete.
    """
    members = [i for i in zf.infolist()
               if i.filename.upper().endswith(suffix)]
    if not members:
        return 0
    members.sort(key=lambda i: -i.file_size)
    part = dest_path.with_suffix('.part')
    try:
        with open(part, 'w', encoding='utf-8') as dest:
            rows = _reduce_member(zf, members[0], dest, keep)
        if not rows:
            log(f'  {label}: {members[0].filename} is EMPTY — not cached')
            return 0
        part.replace(dest_path)
    finally:
        try:
            part.unlink()
        except Exception:                                 # noqa: BLE001
            pass
    return rows


def _fetch_from_zip(zf, y, q, url, hit, log):
    """Extract the quarter's INFOTABLE and SUBMISSION. Returns `hit`, or None.

    BOTH MEMBERS, AND THE SECOND IS THE ONE THAT MAKES THE FIRST MEAN
    ANYTHING.

    INFOTABLE identifies a holding by ACCESSION_NUMBER — the FILING it came
    in. A manager that files 13F-HR and then corrects it with 13F-HR/A has two
    accession numbers and was being counted as two holders. Live, the number
    of "managers" filing:

        2025Q3  8570      2025Q4  9364      2026Q1  9716

    Thirteen percent in three quarters. The real population of 13F filers
    moves a few percent a YEAR; the rest is amendments, and the same inflation
    sat inside every per-ticker count.

    SUBMISSION.tsv maps each accession to the CIK that filed it — the MANAGER
    — and carries PERIODOFREPORT, the quarter the filer says the holdings are
    as of. A few thousand rows against INFOTABLE's millions.

    Split out so the temp-zip cleanup can live in one `finally` around the
    whole download rather than being repeated at every early exit.
    """
    rows = _extract(zf, 'INFOTABLE.TSV', hit, KEEP_COLS, log, f'{y}Q{q}')
    if not rows:
        # NOT KEPT, so the next run fetches again instead of inheriting an
        # empty answer. Named, so a genuinely empty dataset is visible rather
        # than being read as "no institutions own anything".
        log(f'  {y}Q{q}: no usable INFOTABLE in '
            f'{url.rsplit("/", 1)[-1]} — will retry. '
            f'members: {zf.namelist()[:4]}')
        return None
    subs = _extract(zf, 'SUBMISSION.TSV', _sub_path(hit), SUB_COLS, log,
                    f'{y}Q{q} submissions')
    log(f'  {y}Q{q}: {rows:,} rows, {hit.stat().st_size // 1_000_000}MB kept '
        f'from {url.rsplit("/", 1)[-1]}'
        + (f' · {subs:,} submissions' if subs else
           ' · NO SUBMISSION.tsv — holders will be counted by filing, not by '
           'manager'))
    return hit


def fetch_quarter(y: int, q: int, log=print):
    """The path to one quarter's reduced INFOTABLE, or None.

    A PATH, NOT THE TEXT. Returning the text meant the caller held a 338MB
    string and then called `.splitlines()` on it. See `_parse_rows`.
    """
    from chart import edgar as _edgar
    CACHE.mkdir(parents=True, exist_ok=True)
    hit = CACHE / f'{y}q{q}.tsv'
    # AN EMPTY FILE IS NOT A CACHED ANSWER.
    #
    # `if hit.exists()` returned whatever was on disk, and one quarter had
    # written a ZERO-BYTE tsv — so that quarter answered '' forever, without
    # ever re-fetching, and reported "0 securities" as though the SEC had
    # published an empty dataset. The same trap this system keeps finding:
    # an absence stored where an answer belongs.
    # AND THE PAIR IS THE UNIT. A quarter cached before SUBMISSION.tsv was
    # extracted has an INFOTABLE and no way to tell a manager from a filing,
    # so it re-fetches rather than being counted in the weaker unit forever.
    sub = _sub_path(hit)
    if (hit.exists() and hit.stat().st_size > 0
            and sub.exists() and sub.stat().st_size > 0):
        return hit

    import shutil
    import tempfile
    import urllib.request
    tried = []
    # THE LINK THE SEC PUBLISHED, FIRST. The constructed patterns follow it
    # rather than replacing it, so an older quarter they do reach still works.
    found = discover_urls(log).get((y, q))
    # AND THE CONSTRUCTED ONES ARE NAMED FOR THE FILING QUARTER, not this one.
    # Q1's filings arrive in Q2, so holdings as of 31 Mar 2026 live in a file
    # called 2026q2 — the same off-by-one _quarter_of undoes when reading the
    # listing, applied the other way round here.
    fy, fq = (y + 1, 1) if q == 4 else (y, q + 1)
    for url in ([found] if found else []) + [p.format(y=fy, q=fq)
                                             for p in URL_PATTERNS]:
        tried.append(url)
        # TO A FILE, NOT TO RAM. `r.read()` held the whole compressed zip —
        # ~350MB — and `BytesIO` kept it alive for as long as the ZipFile
        # existed. zipfile does random access on a real file and never reads
        # it whole, so a temp file costs disk instead of memory.
        tmp = tempfile.NamedTemporaryFile(suffix='.zip', delete=False,
                                          dir=str(CACHE))
        try:
            try:
                req = urllib.request.Request(url,
                                             headers={'User-Agent': _edgar.UA})
                with urllib.request.urlopen(req, timeout=300) as r:
                    shutil.copyfileobj(r, tmp, length=1 << 20)
                tmp.close()
            except Exception as e:                        # noqa: BLE001
                log(f'  {y}Q{q}: {url.rsplit("/", 1)[-1]} — {str(e)[:60]}')
                continue
            try:
                zf = zipfile.ZipFile(tmp.name)
            except Exception as e:                        # noqa: BLE001
                log(f'  {y}Q{q}: not a zip — {str(e)[:60]}')
                continue
            got = _fetch_from_zip(zf, y, q, url, hit, log)
            if got is not None:
                return got
            continue
        finally:
            # IN A FINALLY. A failure part-way through would otherwise leave
            # 350MB behind, and there are four of these per run.
            try:
                tmp.close()
            except Exception:                             # noqa: BLE001
                pass
            try:
                os.unlink(tmp.name)
            except Exception:                             # noqa: BLE001
                pass
    # WHAT WAS TRIED **AND** WHAT WAS OFFERED.
    #
    # Naming the tried URLs was not enough: twelve 404s were printed nightly
    # for weeks and told nobody anything, because the useful fact is not which
    # wrong addresses were requested — it is which right ones existed. One
    # line here ends the guessing instead of starting another round of it.
    log(f'  {y}Q{q}: no dataset found.')
    log(f'      tried: {tried}')
    log(f'      index: {_index_summary()}')
    return None


def build(quarters: int = QUARTERS, log=print) -> dict:
    """Count holders per ticker across recent quarters and publish."""
    names = _name_index()
    log(f'  {len(names)} company names known from the SIC cache')
    if not names:
        return {'ok': False, 'error': 'no SIC cache yet — run the SIC pass first'}

    qs = recent_quarters(quarters)

    # WHAT THE SEC HAS, NOT ONLY WHAT THE CALENDAR SAYS.
    #
    # recent_quarters() is right about the filing deadline and useless on its
    # own: it asked for 2025Q3-2026Q2, the listing offered nothing past
    # 2023Q4, and the whole letter was dropped because four specific quarters
    # were absent. Sponsorship from an older quarter is still sponsorship —
    # and the file carries its own `quarters`, which the card prints, so
    # nothing here can pass itself off as current.
    #
    # The wanted quarters are still preferred. This only decides what to do
    # when some of them do not exist.
    #
    # SOME, NOT NONE — which is the ordinary case, not the rare one. The
    # deadline for a quarter passing is not the SEC publishing the data set
    # for it, and there are weeks between the two, so the NEWEST wanted
    # quarter is routinely the one missing. Asking for four and taking
    # whichever three happen to exist quietly shortens the history the card
    # draws its direction from. The window slides instead: the `quarters`
    # newest quarters the index actually offers, none newer than the deadline
    # allows.
    fell_back = None
    have = discover_urls(log)
    if have:
        avail = sorted((k for k in have if k <= qs[-1]), reverse=True)[:quarters]
        if avail and list(reversed(avail)) != qs:
            fell_back = (f"wanted {_qname(qs[0])}–{_qname(qs[-1])}; index has "
                         f"{_qname(avail[-1])}–{_qname(avail[0])}")
            log(f'  {fell_back}')
            qs = list(reversed(avail))

    # TWO PASSES, AND THE ORDER OF THEM IS THE POINT.
    #
    # The CUSIP→ticker map only ever grows: a CUSIP matched in ANY quarter is
    # used in all of them, so one quarter writing the name differently does
    # not punch a hole in the history. That was already true and it was
    # applied too late — counts for the first quarter were rolled up against a
    # map that only knew the first quarter's names.
    #
    # So: every issuer name first (cheap — names, no accession sets), the map
    # once, then the counting. Each file is read twice and the second read
    # keeps only the ~3,500 matched tickers rather than all ~34,000
    # securities, so this is faster in memory than the single pass it
    # replaces and about thirty seconds slower on the clock.
    issuers: dict[str, str] = {}
    paths = []
    for (y, q) in qs:
        path = fetch_quarter(y, q, log=log)
        if path is None:
            continue
        paths.append(((y, q), path))
        for cusip, name in parse_issuers_file(path).items():
            issuers.setdefault(cusip, name)
    cusip_ticker = match_cusips({c: {'name': n} for c, n in issuers.items()},
                                names)
    log(f'  {len(issuers)} securities over {len(paths)} quarters, '
        f'{len(cusip_ticker)} mapped to tickers')

    per_q: dict[tuple, dict] = {}
    filers: dict[tuple, int] = {}
    unit = 'manager'
    relabelled = []
    for (y, q), path in paths:
        acc_cik, periods = parse_submissions_file(_sub_path(path))
        if not acc_cik:
            # AN APPROXIMATION MUST NOT PASS FOR THE MEASUREMENT. Counting
            # filings instead of managers still answers, and the published
            # file says which was done.
            unit = 'filing'
        # THE QUARTER THE FILERS THEMSELVES STATE, over the one inferred from
        # the SEC's filename. That inference has been made twice here and was
        # wrong once — every card read 2026Q2 in September for holdings as of
        # 31 March. A measurement beats an argument.
        stated = period_quarter(periods)
        if stated and stated != (y, q):
            relabelled.append(f'{y}Q{q}→{stated[0]}Q{stated[1]}')
            log(f'  {y}Q{q}: the filings say {stated[0]}Q{stated[1]} '
                f'— trusting the data over the filename')
            y, q = stated
        per_q[(y, q)], filers[(y, q)] = count_quarter_file(
            path, cusip_ticker, acc_cik)
        log(f'  {y}Q{q}: {len(per_q[(y, q)])} tickers held, '
            f'{filers[(y, q)]:,} '
            + ('managers filed' if acc_cik else
               'FILINGS (no submissions file — amendments inflate this)'))
    if not per_q:
        # THE QUARTERS ASKED FOR, which is what this message is about — so it
        # is read before `qs` is replaced below, not after.
        return {'ok': False, 'error': 'no 13F quarters could be fetched',
                'quarters_wanted': [_qname(k) for k in qs],
                'index': _index_summary()}

    # RELABELLING CAN REORDER THE WINDOW, and `qs` drives every list below —
    # the published `quarters`, the history each ticker gets, the fallback
    # note. Taking it from what was actually counted keeps the four in step.
    qs = sorted(per_q)

    by_ticker: dict[str, dict] = {}
    for (y, q) in qs:
        counts = per_q.get((y, q))
        if counts is None:
            continue
        label = f'{y}Q{q}'
        # EXACTLY ONE ENTRY PER TICKER PER QUARTER. It used to append one per
        # CUSIP, so a company with a bond and listed options got three entries
        # for the same quarter — and `[-1]` then read the last of them as "the
        # holder count", while `trend` read the whole mixed list as a history.
        pool = filers.get((y, q)) or 0
        for t, n in counts.items():
            row = by_ticker.setdefault(t, {'quarters': []})
            # THE POPULATION TRAVELS WITH THE COUNT, on the same row, because
            # the two only mean anything together — see `trend`. A quarter
            # where 6,168 of 8,759 managers held it is a different fact from
            # 6,168 of 12,000, and the card prints both.
            row['quarters'].append({
                'q': label, 'funds': n, 'of': pool or None,
                'share_pct': round(n / pool * 100, 1) if pool else None})

    for t, row in by_ticker.items():
        row['quarters'].sort(key=lambda r: r['q'])
        row['funds'] = row['quarters'][-1]['funds']
        # MERGED INTO THE SAME NAMESPACE, so `trend` may not return any key
        # this row already uses — see its docstring. It returned `quarters`
        # and silently replaced the history above with a count.
        row.update(trend([r['funds'] for r in row['quarters']],
                         [r['of'] for r in row['quarters']]))
        assert isinstance(row['quarters'], list), 'trend clobbered the history'

    import datetime as _dt
    out = {
        'ok': True,
        'built_at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds'),
        # A QUARTER THAT PRODUCED NOTHING IS NOT A QUARTER THIS COVERS.
        #
        # `in per_q` was true for a quarter that parsed to an EMPTY dict, so
        # the list named a period no stock has a single data point from — and
        # the card prints this list as the range the reading spans. The counts
        # were already safe (iterating an empty dict gives no ticker a false
        # zero, so nothing reads as "the funds sold out"); only the label was
        # claiming more than it had.
        'quarters': [f'{y}Q{q}' for y, q in qs if per_q.get((y, q))],
        # NAMED, so an empty dataset is visible rather than quietly shortening
        # the history — the same reason the unplaced index links are named.
        'quarters_empty': [f'{y}Q{q}' for y, q in qs
                           if (y, q) in per_q and not per_q[(y, q)]],
        # THE DENOMINATOR, PUBLISHED ONCE. Every widely-held name rose by
        # roughly the same amount over the same four quarters, which is what
        # a growing filer population looks like and not what sponsorship
        # looks like. Held here rather than copied onto 3,382 ticker rows —
        # it is one number per quarter and the card joins on the label.
        'filers_by_quarter': {f'{y}Q{q}': filers[(y, q)] for (y, q) in qs
                              if per_q.get((y, q))},
        # SAID OUT LOUD when the data is not the quarters the calendar asked
        # for. The card prints `quarters` either way, but a run summary that
        # does not mention it lets a fallback pass for a normal night.
        'fell_back': fell_back,
        # WHAT A "HOLDER" IS IN THIS FILE. `manager` is the real measure —
        # distinct CIKs. `filing` means a quarter was cached before
        # SUBMISSION.tsv was extracted, so an amendment counts twice and the
        # numbers run high. The card must be able to say which.
        'holder_unit': unit,
        # AND WHERE THE FILENAME AND THE FILINGS DISAGREED about the period.
        # Empty is the expected answer; anything here means the naming rule
        # this module infers has drifted from what the SEC publishes.
        'relabelled': relabelled,
        'tickers': len(by_ticker),
        'securities_seen': len(cusip_ticker),
        'coverage_note': (
            '13F reports CUSIPs and the CUSIP-to-ticker table is licensed, so '
            'issuers are matched by name against EDGAR. A name that is '
            'ambiguous or unmatched reports NO DATA rather than a guess.'),
        'stocks': by_ticker,
    }
    SHARED.parent.mkdir(parents=True, exist_ok=True)
    tmp = SHARED.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(out))
    tmp.replace(SHARED)
    out['wrote'] = str(SHARED)
    return out
