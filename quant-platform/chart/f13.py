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


def parse_infotable(text: str) -> dict:
    """INFOTABLE.tsv → {cusip: {'name': str, 'accessions': set}}.

    One row per holding. The same manager filing the same quarter appears once
    per position, so holders are counted by DISTINCT ACCESSION NUMBER — a
    manager reporting three share classes of one issuer is one holder, not
    three, and counting rows instead would inflate exactly the widely-held
    names that are already over-owned.
    """
    out: dict[str, dict] = {}
    lines = (text or '').splitlines()
    if not lines:
        return out
    head = [h.strip().upper() for h in lines[0].split('\t')]
    try:
        i_acc = head.index('ACCESSION_NUMBER')
        i_cusip = head.index('CUSIP')
    except ValueError:
        return out
    i_name = head.index('NAMEOFISSUER') if 'NAMEOFISSUER' in head else None
    for line in lines[1:]:
        if not line.strip():
            continue
        parts = line.split('\t')
        if len(parts) <= max(i_acc, i_cusip):
            continue
        cusip = parts[i_cusip].strip().upper()
        if not cusip:
            continue
        rec = out.setdefault(cusip, {'name': '', 'accessions': set()})
        rec['accessions'].add(parts[i_acc].strip())
        if i_name is not None and not rec['name'] and len(parts) > i_name:
            rec['name'] = parts[i_name].strip()
    return out


def count_holders(parsed: dict) -> dict:
    """{cusip: number of distinct managers holding it}."""
    return {c: len(r['accessions']) for c, r in (parsed or {}).items()}


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


def trend(counts: list) -> dict:
    """Oldest-first fund counts → the reading O'Neil actually wants.

    Direction, not a score. "More is better" is false at both ends: no
    sponsorship means undiscovered, and universal sponsorship means there is
    nobody left to buy. So this says which way it is moving and by how much,
    and leaves the judgement where it belongs.
    """
    vals = [c for c in (counts or []) if c is not None]
    if len(vals) < 2:
        return {'direction': None, 'change': None, 'change_pct': None,
                'note': 'needs two quarters to have a direction'}
    first, last = vals[0], vals[-1]
    change = last - first
    pct = round(change / first * 100, 1) if first else None
    return {
        'direction': 'rising' if change > 0 else 'falling' if change < 0 else 'flat',
        'change': change,
        'change_pct': pct,
        'quarters': len(vals),
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
# period they cover — 01jan2024-31mar2024_form13f.zip — which carries the same
# fact in a shape the pattern above cannot see.
_DATED = re.compile(r'(\d{1,2})([a-z]{3})(20\d\d)', re.I)
_MONTHS = {m: i + 1 for i, m in enumerate(
    ('jan', 'feb', 'mar', 'apr', 'may', 'jun',
     'jul', 'aug', 'sep', 'oct', 'nov', 'dec'))}


def _quarter_of(name: str):
    """(year, quarter) from a filename, or None if it cannot be read."""
    m = _QUARTER.search(name)
    if m:
        return int(m.group(1)), int(m.group(2))
    # THE END DATE, NOT THE START. A range is named for the period it covers,
    # and where one straddles a boundary the quarter it belongs to is the one
    # it finishes in — the same rule the filing deadline uses.
    dates = _DATED.findall(name)
    if dates:
        _, mon, year = dates[-1]
        mi = _MONTHS.get(mon.lower())
        if mi:
            return int(year), (mi - 1) // 3 + 1
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


def fetch_quarter(y: int, q: int, log=print) -> str | None:
    """The INFOTABLE for one quarter, as text. Cached on disk once fetched."""
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
    if hit.exists() and hit.stat().st_size > 0:
        return hit.read_text()

    import urllib.request
    tried = []
    # THE LINK THE SEC PUBLISHED, FIRST. The constructed patterns follow it
    # rather than replacing it, so an older quarter they do reach still works.
    found = discover_urls(log).get((y, q))
    for url in ([found] if found else []) + [p.format(y=y, q=q)
                                             for p in URL_PATTERNS]:
        tried.append(url)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': _edgar.UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                blob = r.read()
        except Exception as e:                            # noqa: BLE001
            log(f'  {y}Q{q}: {url.rsplit("/", 1)[-1]} — {str(e)[:60]}')
            continue
        try:
            zf = zipfile.ZipFile(io.BytesIO(blob))
        except Exception as e:                            # noqa: BLE001
            log(f'  {y}Q{q}: not a zip — {str(e)[:60]}')
            continue
        # THE BIGGEST MATCH, NOT THE FIRST. A zip can carry a stub or a
        # directory entry whose name also ends INFOTABLE.TSV, and taking
        # `names[0]` picked one of those — the holdings table is by a wide
        # margin the largest member, so size is the reliable way to find it.
        members = [i for i in zf.infolist()
                   if i.filename.upper().endswith('INFOTABLE.TSV')]
        if not members:
            log(f'  {y}Q{q}: no INFOTABLE in {zf.namelist()[:4]}')
            continue
        members.sort(key=lambda i: -i.file_size)
        text = zf.read(members[0]).decode('utf-8', 'replace')
        if not text.strip():
            # NOT WRITTEN, so the next run fetches again instead of inheriting
            # an empty answer. Named, so a genuinely empty dataset is visible
            # rather than being read as "no institutions own anything".
            log(f'  {y}Q{q}: {members[0].filename} is EMPTY in '
                f'{url.rsplit("/", 1)[-1]} — not cached, will retry')
            continue
        hit.write_text(text)
        log(f'  {y}Q{q}: {len(text) // 1_000_000}MB from {url.rsplit("/", 1)[-1]}'
            f' ({members[0].filename})')
        return text
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
    # when none of them exist.
    fell_back = None
    have = discover_urls(log)
    if have and not any(k in have for k in qs):
        newest = sorted(have, reverse=True)[:quarters]
        if newest:
            fell_back = (f"{qs[-1][0]}Q{qs[-1][1]} not published; using "
                         f"{newest[0][0]}Q{newest[0][1]} and back")
            log(f'  {fell_back}')
            qs = list(reversed(newest))

    per_q: dict[tuple, dict] = {}
    cusip_ticker: dict[str, str] = {}
    for (y, q) in qs:
        text = fetch_quarter(y, q, log=log)
        if text is None:
            continue
        parsed = parse_infotable(text)
        # The CUSIP map only ever grows: a CUSIP matched in ANY quarter is
        # used in all of them, so one quarter writing the name differently
        # does not punch a hole in the history.
        cusip_ticker.update(match_cusips(parsed, names))
        per_q[(y, q)] = count_holders(parsed)
        log(f'  {y}Q{q}: {len(parsed)} securities, '
            f'{len(cusip_ticker)} mapped to tickers so far')

    if not per_q:
        return {'ok': False, 'error': 'no 13F quarters could be fetched',
                'quarters_wanted': [f'{y}Q{q}' for y, q in qs],
                'index': _index_summary()}

    by_ticker: dict[str, dict] = {}
    for (y, q) in qs:
        counts = per_q.get((y, q))
        if counts is None:
            continue
        label = f'{y}Q{q}'
        for cusip, n in counts.items():
            t = cusip_ticker.get(cusip)
            if not t:
                continue
            row = by_ticker.setdefault(t, {'quarters': []})
            row['quarters'].append({'q': label, 'funds': n})

    for t, row in by_ticker.items():
        row['quarters'].sort(key=lambda r: r['q'])
        row['funds'] = row['quarters'][-1]['funds']
        row.update(trend([r['funds'] for r in row['quarters']]))

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
        # SAID OUT LOUD when the data is not the quarters the calendar asked
        # for. The card prints `quarters` either way, but a run summary that
        # does not mention it lets a fallback pass for a normal night.
        'fell_back': fell_back,
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
