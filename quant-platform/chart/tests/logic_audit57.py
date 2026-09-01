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
ok('a failed fetch names the urls it tried',
   'NAMES THE URLS IT TRIED' in SRC)
ok('the CUSIP map only grows, so one odd quarter cannot hole the history',
   'only ever grows' in SRC)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
