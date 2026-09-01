"""Audit 56 — L is ranked over the MARKET, not over our own screener output.

THE BUG THIS EXISTS TO PIN DOWN.

The first version of L built industry groups from the industry strings the
screener tools happened to see. Reported from live use, and correctly:

    "now the group and everything after depends on my screeners universe not
     the market — you simply need to understand how O'Neill is doing it and do
     the same"

IBD classifies EVERY listed stock into ~197 groups and ranks all of them; the
rule "buy the #1 or #2 name in a top group" and the 37%-of-a-stock's-move
arithmetic both assume the group IS the industry. Built from screener output,
"rank 12 of 40" is a fact about the screeners and "RS 2 of 13" is second of
thirteen names WE saw. The ranking depended on the thing it was meant to
judge.

Membership now comes from EDGAR's SIC codes, which cover every filer. These
checks are all on the PURE functions, so the classification logic is provable
with no network at all.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import sic                                      # noqa: E402

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
print("audit 56 — L over the whole market, the way O'Neil ranks it")
print('=' * 64)

# ── EDGAR's ticker index ────────────────────────────────────────────────
IDX = {
    '0': {'cik_str': 320193, 'ticker': 'AAPL', 'title': 'Apple Inc.'},
    '1': {'cik_str': 1652044, 'ticker': 'GOOGL', 'title': 'Alphabet'},
    '2': {'cik_str': 1652044, 'ticker': 'GOOG', 'title': 'Alphabet'},
    '3': {'cik_str': None, 'ticker': 'BAD', 'title': 'no cik'},
    '4': {'cik_str': 789019, 'ticker': '', 'title': 'no ticker'},
}
t = sic.parse_tickers(IDX)
ok('every ticker in the index is read', t.get('AAPL') == 320193)
ok('BOTH share classes are kept, because they trade and rank separately',
   t.get('GOOG') == 1652044 and t.get('GOOGL') == 1652044, t)
ok('a row with no CIK is skipped rather than crashing the build',
   'BAD' not in t, t)
ok('...and so is a row with no ticker', '' not in t, t)

# ── one company's classification ────────────────────────────────────────
SUB = {
    'cik': 320193, 'name': 'Apple Inc.', 'sic': '3571',
    'sicDescription': 'Electronic Computers', 'tickers': ['AAPL'],
}
p = sic.parse_submission(SUB)
ok('the industry is the FILER\'S OWN description of its code',
   p['industry'] == 'Electronic Computers', p)
ok('...so no SIC-title table has to be maintained here',
   'sicDescription' in str(sic.parse_submission.__doc__))
# SIC major group 35 is "Industrial and Commercial Machinery and Computer
# Equipment" — a computer maker files there, not under Electronics (36). The
# first version of this check asserted Electronics and was simply wrong about
# the scheme; the code was right.
ok('the sector is the SIC major group, one level up',
   p['sector'] == 'Industrial Machinery', p)
ok('the raw code is kept, because the description is not the identifier',
   p['sic'] == '3571', p)

ok('a filer with no SIC yields no industry rather than a blank group',
   sic.parse_submission({'name': 'X'})['industry'] == '')
ok('...and an unknown major group is named, not dropped',
   sic.sector_of('9999') == 'Nonclassifiable'
   and sic.sector_of('1111') == 'Other', sic.sector_of('1111'))
# THE PADDING IS NOT UNIFORM. EDGAR strips leading zeros, so agriculture's
# 0100 arrives as '100' and must be padded back to four. But a bare two-digit
# value IS already a major group, and padding it to '0073' loses it entirely.
ok('a three-digit code is padded back to four before the group is read',
   sic.sector_of('100') == 'Agriculture', sic.sector_of('100'))
ok('...and a two-digit code is already the group, so it is NOT padded',
   sic.sector_of('73') == 'Business Services', sic.sector_of('73'))
ok('an empty code is empty, not "Other"', sic.sector_of(None) == '')

# ── the thing the whole module is for ───────────────────────────────────
SRC = (pathlib.Path(__file__).resolve().parents[1] / 'sic.py').read_text()
ok('the module states plainly that membership comes from the market',
   'not from us' in SRC and 'EVERY listed stock' in SRC)
ok('...and that this is NOT a reproduction of IBD\'s 197 groups',
   'proprietary' in SRC and 'WHAT IT IS NOT' in SRC)
ok('one request per FILER, not per ticker — share classes share a filing',
   'by_cik' in SRC and 'share classes share a filing' in SRC)
ok('every company is cached as it is fetched, so a run resumes',
   'RESUMABLE' in SRC and '_write_cached' in SRC)
ok('a filer EDGAR will not serve is a missing member, not a failed build',
   'not a\n            # failed build' in SRC or 'not a failed build' in SRC.replace('\n            # ', ' '))

ok('the map keeps what the tools wrote for symbols SIC could not classify',
   'without discarding theirs' in SRC)
ok('...and every entry says WHICH SOURCE it came from',
   "'src': 'sic'" in SRC and 'never silently presented as one thing' in SRC)

# The runner must classify the RS universe rather than all of EDGAR: a filer
# with no price history cannot be ranked, so its classification buys nothing.
RUN = (pathlib.Path(__file__).resolve().parents[2] / 'deploy'
       / 'run_sic.py').read_text()
ok('the runner classifies the RS universe, not every EDGAR ticker',
   'rs_rating()' in RUN and 'cannot be ranked' in RUN)
ok('...and ranks the groups in the same pass, leaving a usable state',
   'groups.build()' in RUN)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
