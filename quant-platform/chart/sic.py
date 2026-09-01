"""Industry classification for the WHOLE market, from EDGAR's SIC codes.

WHY THIS EXISTS — AND WHAT IT REPLACES.

The first version of L ranked industry groups built from the industry strings
the screener tools happened to see. That is not what O'Neil does, and the
difference is not a detail:

  IBD classifies EVERY listed stock into ~197 industry groups, ranks all 197
  against each other, and the rule is "buy the #1 or #2 name in a top group".
  The 37%-of-a-stock's-move-is-its-group arithmetic only holds if the group
  IS the industry.

Built from screener output instead, "rank 12 of 40" is a fact about the
screeners — 12th of the 40 groups that happened to contain three names a tool
returned — and "RS 2 of 13" means second of thirteen names WE saw, not second
in the industry. A stock could be the true leader of its industry and rank 8th
here because the other seven names our screeners caught were the strong ones.
That is circular: the ranking depends on the thing it is supposed to judge.

So membership comes from the market, not from us.

THE SOURCE. Every company that files with the SEC carries a Standard
Industrial Classification code, and EDGAR publishes it with the company's own
description of it. Four-digit SIC is about 440 industries — finer than a
sector (11) and the same order as IBD's 197, which is the granularity O'Neil's
claim is about. It is free, it needs no key, and it covers every filer.

WHAT IT IS NOT. It is not IBD's 197-way split: those definitions are
proprietary and are not reproducible from public data. SIC is an older
scheme and it groups some things differently — a modern software company and
a payroll processor can share a code. The honest claim is "SIC industry,
market-wide", and that is what the card says. What matters for O'Neil's rule
is that the membership is the whole industry rather than a sample of it, and
that is now true.

FETCHING IS SEPARATE FROM PARSING, as everywhere else here: `parse_tickers`
and `parse_submission` take payloads and return data, so the audit can hand
them a document built by hand. Only `fetch_*` touches the network.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from chart import edgar as _edgar

# EDGAR's own ticker → CIK index. One request, every filer with a ticker.
TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
SUBMISSIONS = 'https://data.sec.gov/submissions/CIK{cik:010d}.json'

# Where the finished map goes. The SAME file the screener tools write, in the
# same shape, because qp already reads it and nine tools already know the
# contract. This one just fills it from the market instead of from a sample.
SHARED = Path(os.environ.get('INDUSTRY_MAP_FILE')
              or (Path(__file__).resolve().parents[2] / 'data' / 'industry-map.json'))

# Per-CIK cache. A company's SIC changes when it reclassifies, which is rare,
# so this is written once and re-read forever; `refresh` re-walks it.
CACHE = Path(os.environ.get('QP_SIC_CACHE')
             or (Path.home() / '.qp-cache' / 'sic'))

# SIC's two-digit major group, used as the SECTOR. The four-digit code is the
# industry; the major group is the level above it, which is what the card's
# sector line wants and what the heatmap already speaks in.
MAJOR_GROUPS = {
    '01': 'Agriculture', '02': 'Agriculture', '07': 'Agriculture',
    '08': 'Forestry', '09': 'Fishing',
    '10': 'Metal Mining', '12': 'Coal Mining', '13': 'Oil & Gas',
    '14': 'Nonmetallic Minerals',
    '15': 'Construction', '16': 'Construction', '17': 'Construction',
    '20': 'Food', '21': 'Tobacco', '22': 'Textiles', '23': 'Apparel',
    '24': 'Lumber & Wood', '25': 'Furniture', '26': 'Paper',
    '27': 'Printing & Publishing', '28': 'Chemicals & Pharma',
    '29': 'Petroleum Refining', '30': 'Rubber & Plastics', '31': 'Leather',
    '32': 'Stone, Clay & Glass', '33': 'Primary Metals',
    '34': 'Fabricated Metals', '35': 'Industrial Machinery',
    '36': 'Electronics', '37': 'Transportation Equipment',
    '38': 'Instruments', '39': 'Misc Manufacturing',
    '40': 'Railroads', '41': 'Transit', '42': 'Trucking', '44': 'Water Transport',
    '45': 'Air Transport', '46': 'Pipelines', '47': 'Transport Services',
    '48': 'Communications', '49': 'Utilities',
    '50': 'Wholesale Durable', '51': 'Wholesale Nondurable',
    '52': 'Building Retail', '53': 'General Merchandise', '54': 'Food Retail',
    '55': 'Auto Retail', '56': 'Apparel Retail', '57': 'Furniture Retail',
    '58': 'Restaurants', '59': 'Misc Retail',
    '60': 'Banks', '61': 'Credit', '62': 'Brokers', '63': 'Insurance',
    '64': 'Insurance Agents', '65': 'Real Estate', '67': 'Holding & Investment',
    '70': 'Lodging', '72': 'Personal Services', '73': 'Business Services',
    '75': 'Auto Services', '76': 'Repair Services', '78': 'Motion Pictures',
    '79': 'Recreation', '80': 'Health Services', '81': 'Legal',
    '82': 'Educational', '83': 'Social Services', '84': 'Museums',
    '86': 'Membership Orgs', '87': 'Engineering & Research',
    '89': 'Services', '91': 'Government', '92': 'Government',
    '93': 'Government', '94': 'Government', '95': 'Government',
    '96': 'Government', '97': 'Government', '99': 'Nonclassifiable',
}


def sector_of(sic: str | int | None) -> str:
    """The SIC major group — the level above the industry.

    THE PADDING IS NOT UNIFORM, and getting it wrong silently files a company
    under the wrong sector rather than failing. EDGAR serves the code with
    leading zeros stripped, so agriculture's 0100 arrives as '100' and has to
    be padded back to four before the major group is read off the front. But a
    bare two-digit value IS already a major group — padding '73' to '0073'
    turns Business Services into nothing at all.
    """
    s = str(sic or '').strip()
    if not s:
        return ''
    major = s.zfill(2) if len(s) <= 2 else s.zfill(4)[:2]
    return MAJOR_GROUPS.get(major, 'Other')


def parse_tickers(payload: dict) -> dict:
    """EDGAR's company_tickers.json → {TICKER: cik}.

    The document is keyed by an arbitrary index, not by ticker, and the same
    CIK appears once per share class (GOOG and GOOGL are one filer). Both
    tickers are kept: they trade separately and rank separately.
    """
    out: dict[str, int] = {}
    rows = payload.values() if isinstance(payload, dict) else (payload or [])
    for row in rows:
        if not isinstance(row, dict):
            continue
        t = str(row.get('ticker') or '').strip().upper()
        cik = row.get('cik_str', row.get('cik'))
        if not t or cik is None:
            continue
        try:
            out[t] = int(cik)
        except (TypeError, ValueError):
            continue
    return out


def parse_submission(payload: dict) -> dict:
    """One submissions document → the classification facts we keep.

    `sicDescription` is the company's own filed description of its code, which
    is why the industry NAME does not need a lookup table maintained here.
    """
    d = payload or {}
    sic = str(d.get('sic') or '').strip()
    desc = str(d.get('sicDescription') or '').strip()
    return {
        'sic': sic,
        'industry': desc or (f'SIC {sic}' if sic else ''),
        'sector': sector_of(sic),
        'name': str(d.get('name') or '').strip(),
        'tickers': [str(t).upper() for t in (d.get('tickers') or []) if t],
    }


def _cached(cik: int) -> dict | None:
    p = CACHE / f'{int(cik):010d}.json'
    try:
        return json.loads(p.read_text())
    except Exception:                                     # noqa: BLE001
        return None


def _write_cached(cik: int, rec: dict) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    p = CACHE / f'{int(cik):010d}.json'
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(rec))
    tmp.replace(p)


def fetch_tickers() -> dict:
    """{TICKER: cik} for every filer with a ticker. One request."""
    return parse_tickers(_edgar._get(TICKERS_URL))


def fetch_submission(cik: int) -> dict:
    """One company's classification. Cached on disk; SIC rarely changes."""
    hit = _cached(cik)
    if hit is not None:
        return hit
    rec = parse_submission(_edgar._get(SUBMISSIONS.format(cik=int(cik))))
    _write_cached(cik, rec)
    return rec


def build(symbols=None, limit: int | None = None, log=print) -> dict:
    """Classify the market and write the shared industry map.

    `symbols` restricts the walk — pass the RS universe so the map covers
    exactly the names that can be ranked, and nothing is spent on filers that
    never trade. Default is every ticker EDGAR knows.

    RESUMABLE. Every company is cached the moment it is fetched, so a run that
    is interrupted picks up where it stopped rather than starting over. The
    first pass is the slow one; after that this is a file read.
    """
    index = fetch_tickers()
    log(f'  {len(index)} tickers in EDGAR\'s index')

    want = None
    if symbols:
        want = {str(s).upper() for s in symbols}
        index = {t: c for t, c in index.items() if t in want}
        log(f'  {len(index)} of them are in the RS universe')

    # One request per CIK, not per ticker: share classes share a filing.
    by_cik: dict[int, list[str]] = {}
    for t, cik in index.items():
        by_cik.setdefault(cik, []).append(t)

    symbols_out: dict[str, dict] = {}
    fetched = failed = 0
    now = int(time.time() * 1000)
    for i, (cik, tickers) in enumerate(by_cik.items()):
        if limit and fetched >= limit:
            break
        try:
            rec = fetch_submission(cik)
            fetched += 1
        except Exception as e:                            # noqa: BLE001
            # A filer EDGAR will not serve is one missing group member, not a
            # failed build. Everything already classified still stands.
            failed += 1
            if failed <= 5:
                log(f'  {tickers[0]}: {str(e)[:90]}')
            continue
        if not rec.get('industry'):
            continue
        for t in tickers:
            symbols_out[t] = {
                'sector': rec.get('sector', ''),
                'industry': rec['industry'],
                'sic': rec.get('sic', ''),
                'first': now, 'seen': now,
                'src': 'sic',
            }
        if fetched % 250 == 0:
            log(f'  {fetched}/{len(by_cik)} filers · {len(symbols_out)} tickers')

    merged = _merge_into_shared(symbols_out, now)
    return {
        'filers': len(by_cik), 'fetched': fetched, 'failed': failed,
        'tickers': len(symbols_out), 'total_in_map': merged,
        'wrote': str(SHARED),
    }


def _merge_into_shared(symbols_out: dict, now: int) -> int:
    """Write into the map the tools already share, without discarding theirs.

    The screener tools write TradingView's industry strings into this same
    file. Those are better NAMES — "Packaged Software" reads better than
    "Services-Prepackaged Software" — but they only cover names a screener
    returned, which is the whole problem this module exists to fix.

    So SIC wins on membership and the tools keep whatever they had for symbols
    SIC could not classify. Every entry says which source it came from, so a
    group built from a mixture is never silently presented as one thing.
    """
    try:
        prev = json.loads(SHARED.read_text())
        symbols = (prev or {}).get('symbols') or {}
    except Exception:                                     # noqa: BLE001
        symbols = {}
    for t, rec in symbols_out.items():
        old = symbols.get(t) or {}
        rec['first'] = old.get('first') or rec['first']
        symbols[t] = rec
    SHARED.parent.mkdir(parents=True, exist_ok=True)
    tmp = SHARED.with_suffix('.json.tmp')
    tmp.write_text(json.dumps({'updatedAt': now, 'symbols': symbols}))
    tmp.replace(SHARED)
    return len(symbols)
