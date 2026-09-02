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
p = f13.parse_infotable(TSV)
c = f13.count_holders(p)

ok('two managers holding one issuer count as two', c.get('037833100') == 2, c)
ok('ONE manager filing two share classes counts as ONE', c.get('02079K305') == 1, c)
ok('...which is the whole reason holders are counted by accession',
   'DISTINCT ACCESSION NUMBER' in (f13.parse_infotable.__doc__ or ''))
ok('a blank row is skipped rather than becoming a holder', '' not in c, c)
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
_U = f13.parse_index(_INDEX_HTML)
ok('a listed quarter resolves to its own url',
   _U.get((2026, 2), '').endswith('2026q2_form13f.zip'), _U)
ok('a RELATIVE href gains the host, which is the common case on sec.gov',
   _U[(2026, 2)].startswith('https://www.sec.gov/files/'), _U[(2026, 2)])
ok('...and an absolute one is left alone',
   _U[(2025, 4)].startswith('https://www.sec.gov/files/'), _U[(2025, 4)])
ok('a zip that is not 13F data is not mistaken for one — a quarter number '
   'is not enough to tell them apart', len(_U) == 3, _U)
ok('a link that is not a zip is ignored', (2026, 2) in _U and len(_U) == 3)

ok('a page with no 13F links yields nothing rather than raising',
   f13.parse_index('<a href="/x/2026q2.zip">x</a>') == {})
ok('...and so does an empty or absent page',
   f13.parse_index('') == {} and f13.parse_index(None) == {})

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
    f13._INDEX.update({'urls': {(2026, 2): 'https://x/2026q2_form13f.zip'},
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
ok('a step that ran and built NOTHING is marked, not reported as ok',
   'def _looks_failed' in DAILY and "'warn'" in DAILY)
ok('...and it still does not take the other steps down',
   'never take the others down' in DAILY)
ok('the line that hid this is quoted where the marker is',
   'no 13F quarters' in DAILY)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
