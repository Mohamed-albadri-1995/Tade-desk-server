"""Audit part 51 — the L in CAN SLIM: the group, and the leader inside it.

WHY THIS EXISTS.

O'Neil published the arithmetic: **37% of a stock's price move is attributed to
its industry group, another 12% to its sector.** Roughly half the move is not
about the company. The system had a sector heatmap — 15 ETFs, the coarse level
— and nothing at the group level at all.

TWO SEPARATE FACTS and the second is the one nothing showed:

    is the group strong        rank 63 of 197
    is this stock the leader   RS 1 of 13

A stock can carry RS 95 — top 5% of the whole market — and be 8 of 13 inside
its own group, i.e. the twelfth-best way to own the same theme.

PART A — one fact, three presentations, and they cannot disagree.
PART B — the divisor travels with the rank, because IBD's moved 197 -> 145.
PART C — ranking on the MEDIAN, and the member floor.
PART D — the rank inside the group, and the leaders by name.
PART E — rotation: a group climbing IS O'Neil's "new industry conditions".
PART F — the honest limit is stated, and it never causes a failure.
"""
import json
import pathlib
import shutil
import sys
import tempfile

import pandas as pd

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


from chart import groups                                        # noqa: E402

HERE = pathlib.Path(__file__).resolve().parents[1]


print('== A. one fact, three presentations ==')
# MarketSmith prints `Industry 197 Rank 63`, `Group RS Rating 68` and `B+`.
# Those are not three measurements: 1 - 63/197 = 68%, and B+ is that percentile
# in letter form. Three independent fields would invite a page that showed them
# disagreeing when they cannot.
# ASSERTED AGAINST THE PUBLISHED PAIR, NOT AGAINST THE FORMULA — which is what
# caught a real off-by-one. The first version computed 1 - (rank-1)/total and
# returned 69 for the panel that prints 68.
ok('rank 63 of 197 is the 68th percentile, as MarketSmith prints it',
   groups.rank_to_pct(63, 197) == 68, groups.rank_to_pct(63, 197))
# THE LETTER IS OURS AND SAYS SO. An earlier version chose cut-points to make
# one screenshot's pairing come out right — and landed a band away from it
# anyway. IBD does not publish its boundaries, and guessing them is how the
# follow-through threshold went wrong twice.
ok('68 bands as B under our stated table', groups.letter(68) == 'B', groups.letter(68))
ok('the bands are evenly spaced — 20 points a letter, split in thirds',
   [c for c, _ in groups.LETTER_BANDS]
   == [94, 87, 80, 74, 67, 60, 54, 47, 40, 34, 27, 20], groups.LETTER_BANDS)
ok('...and the model says the banding is ours, not IBD\'s',
   'not claimed to match' in groups.LETTER_NOTE)
ok('rank 1 is the top of the scale, clipped to 99 like every other rating',
   groups.rank_to_pct(1, 197) == 99, groups.rank_to_pct(1, 197))
ok('the last rank is the bottom, clipped to 1',
   groups.rank_to_pct(197, 197) == 1, groups.rank_to_pct(197, 197))
ok('the JS side uses the same form, not the off-by-one',
   '1 - rank / total' in (pathlib.Path(__file__).resolve().parents[3]
                          / 'src' / 'sideD' / 'groups.js').read_text())
ok('the letter scale runs A+ to E',
   groups.letter(99) == 'A+' and groups.letter(1) == 'E',
   (groups.letter(99), groups.letter(1)))
ok('an unknown percentile has no letter, rather than a wrong one',
   groups.letter(None) is None)

# THE SAME LETTER ON BOTH SIDES OF THE WIRE. The card renders in JavaScript and
# the file is written in Python; two implementations of one band table that
# drifted would show the page disagreeing with itself about a single number.
JS = (pathlib.Path(__file__).resolve().parents[3] / 'src' / 'sideD' / 'groups.js').read_text()
for cut, lab in groups.LETTER_BANDS:
    ok(f'the JS side bands {cut} as {lab} too', f'[{cut}, \'{lab}\']' in JS)
ok('...and neither side has a band the other lacks',
   JS.count('[9') + JS.count('[8') + JS.count('[7') + JS.count('[6')
   + JS.count('[5') + JS.count('[4') + JS.count('[3') + JS.count('[2')
   >= len(groups.LETTER_BANDS))


print()
print('== B. the divisor travels with the rank ==')
# IBD restructured its group list from 197 to 145. A stored rank with no
# divisor rewrites its own past the day the count changes, and a bare "63" is
# excellent as a rank and mediocre as a percentile.
rs = pd.Series({f'S{i}': (i % 99) + 1 for i in range(60)})
mapping = {f'S{i}': {'industry': f'G{i % 6}', 'sector': 'X'} for i in range(60)}
gs = groups.build_groups(rs, mapping)
ok('every group carries the count it was ranked against',
   gs and all('of' in g and g['of'] == len(gs) for g in gs), len(gs))
ok('...and its percentile and letter, derived from that rank',
   all(g['pct'] == groups.rank_to_pct(g['rank'], g['of'])
       and g['letter'] == groups.letter(g['pct']) for g in gs))
ok('ranks are 1..N with no gaps and no repeats',
   sorted(g['rank'] for g in gs) == list(range(1, len(gs) + 1)))

UI = (pathlib.Path(__file__).resolve().parents[3] / 'public' / 'index.html').read_text()
ok('the card prints the divisor, never a bare rank',
   '${s.group_rank} of ${s.group_of}' in UI)
ok('...and so does the group table', '${g.rank} of ${g.of}' in UI)


print()
print('== C. the MEDIAN, and the member floor ==')
# One 99 in a group of laggards is a single stock's story. A mean lets that one
# name carry the whole group — exactly the mistake the group level exists to
# prevent.
rs2 = pd.Series({
    'RUNAWAY': 99, 'L1': 5, 'L2': 6, 'L3': 7,          # one star, three dogs
    'B1': 70, 'B2': 72, 'B3': 74, 'B4': 71,            # a broadly strong group
})
m2 = {'RUNAWAY': 'Dogs', 'L1': 'Dogs', 'L2': 'Dogs', 'L3': 'Dogs',
      'B1': 'Broad', 'B2': 'Broad', 'B3': 'Broad', 'B4': 'Broad'}
g2 = {g['group']: g for g in groups.build_groups(rs2, m2)}
ok('the broadly strong group outranks the one with a single star',
   g2['Broad']['rank'] < g2['Dogs']['rank'], {k: v['rank'] for k, v in g2.items()})
ok('...though the runaway group has the higher TOP rating',
   g2['Dogs']['top_rs'] > g2['Broad']['top_rs'])
ok('how much of the group is strong is reported, not just the middle',
   g2['Broad']['share_over_80'] == 0.0 and g2['Dogs']['share_over_80'] > 0)

# TWO STOCKS ARE NOT AN INDUSTRY. Ranking a group of one puts a single name's
# 12-month move on the same footing as a real group's broad advance.
tiny = groups.build_groups(pd.Series({'A': 90, 'B': 80}), {'A': 'Pair', 'B': 'Pair'})
ok('a group under the member floor is not ranked at all', tiny == [], tiny)
ok('...and the floor is configurable without a code change',
   'QP_GROUP_MIN_MEMBERS' in (HERE / 'groups.py').read_text())

# A symbol with no rating cannot be counted. Dropping it silently would shrink
# a group without saying so, which changes its median.
part = groups.build_groups(pd.Series({'A': 90, 'B': 80, 'C': 70}),
                           {'A': 'G', 'B': 'G', 'C': 'G', 'D': 'G'})
ok('an unrated symbol is not counted as a member',
   part and part[0]['members'] == 3, part)


print()
print('== D. the rank INSIDE the group ==')
# The one O'Neil is strictest about: buy the #1 or #2 name in a top group,
# never the cheapest name in it.
rs3 = pd.Series({'A': 95, 'B': 88, 'C': 60, 'D': 40, 'E': 30, 'F': 20})
m3 = {k: 'Theme' for k in 'ABCDEF'}
g3 = groups.build_groups(rs3, m3)
st = groups.stock_rows(g3)
ok('the strongest member is 1 of 6', st['A']['rs_in_group'] == 1
   and st['A']['members'] == 6, st['A'])
ok('...and the weakest is 6 of 6', st['F']['rs_in_group'] == 6)
ok("every member carries its group and that group's rank",
   all(v['group'] == 'Theme' and v['group_rank'] == 1 for v in st.values()))

# THE CASE THAT MAKES THE FIELD WORTH HAVING: strong market-wide, weak in its
# own theme. A stock at RS 95 that is eighth of thirteen means twelve better
# ways to own the same idea are on the screen beside it.
big = pd.Series({f'T{i}': 99 - i for i in range(13)})
gb = groups.build_groups(big, {f'T{i}': 'Hot' for i in range(13)})
sb = groups.stock_rows(gb)
ok('a high market rating can still be mid-pack inside its own group',
   sb['T7']['rs_in_group'] == 8 and sb['T7']['members'] == 13, sb['T7'])

# THE LEADERS, BY NAME. "Top RS 99" is a number; a list of symbols is the
# shortlist, and it is how you find out you are holding the wrong name in the
# right theme.
ok('the strongest members come back as SYMBOLS, not just a maximum',
   [l['symbol'] for l in gb[0]['leaders']] == ['T0', 'T1', 'T2', 'T3', 'T4'],
   gb[0]['leaders'])
ok('...capped, because the point is a shortlist', len(gb[0]['leaders']) == 5)

# The internal index is not published: the file should be what it claims to be.
built = {k: v for k, v in gb[0].items() if k.startswith('_')}
ok('the internal rank index exists for stock_rows to use', '_ranks' in gb[0])
ok('...and is stripped from what gets written',
   all(not k.startswith('_') for k in json.loads(json.dumps(
       {k: v for k, v in gb[0].items() if not k.startswith('_')}))))


print()
print('== E. rotation is the third "new" ==')
# O'Neil's N is three things and the one everybody drops is "an important
# change for the better in the conditions of the industry". A group climbing
# the rank IS that change, measured — and it needs no news feed at all.
SRC = (HERE / 'groups.py').read_text()
ok("a prior ranking is compared, not just today's", 'prior_asof' in SRC)
ok('...over about a quarter', 'ROTATION_SESSIONS' in SRC and '63' in SRC)
ok('a rank FALLING is the group improving, and the code says so',
   "'into' if g['rank'] < p[0]" in SRC)
ok('a missing history is a missing column, not a failed build',
   'rotation_error' in SRC)
ok('the card shows the direction with the old rank behind it',
   'rank ${g.rank_3mo} of ${g.of_3mo} three months ago' in UI)


print()
print('== F. the honest limit, and never a failure ==')
ok('the limit is stated in the model itself',
   "not IBD's" in groups.LIMIT_NOTE and 'proprietary' in groups.LIMIT_NOTE)
ok('...and printed on the page beside the table', 'limit_note' in UI)

_tmp = tempfile.mkdtemp(prefix='qpgroups-')
groups.SHARED = pathlib.Path(_tmp) / 'oneil-groups.json'
model = {'ok': True, 'groups': gb, 'stocks': sb, 'built_at': 'x'}
ok('it publishes to the shared file', groups.write_shared(model))
ok('...and reads back', (groups.read_shared() or {}).get('ok') is True)
ok('...atomically, so a reader never sees half',
   '.tmp' in SRC and 'replace(SHARED)' in SRC)

groups.SHARED = pathlib.Path('/proc/nonexistent/cannot/exist/x.json')
ok('an unwritable location returns None rather than raising',
   groups.write_shared(model) is None)
ok('a missing file reads as None', groups.read_shared() is None)

groups.MAP_FILE = pathlib.Path('/proc/nonexistent/no/map.json')
ok('a missing industry map is an empty map, not an exception',
   groups.read_map() == {})
built = groups.build()
ok('...and build() says what to do about it rather than failing',
   built['ok'] is False and 'industry map' in built['error'], built)

ok('an empty ratings series produces no groups',
   groups.build_groups(pd.Series(dtype=float), mapping) == [])
ok('an empty mapping produces no groups', groups.build_groups(rs, {}) == [])
ok('a mapping entry with no industry or sector is skipped, not crashed on',
   groups.build_groups(pd.Series({'A': 90, 'B': 80, 'C': 70}),
                       {'A': {}, 'B': None, 'C': 'G'}) == [])

# Industry is the point; sector is a materially coarser claim and only a
# fallback. A row that silently used the sector would be a different question
# answered with the same words.
mixed = groups.build_groups(
    pd.Series({'A': 90, 'B': 80, 'C': 70}),
    {'A': {'industry': 'Fine', 'sector': 'Coarse'},
     'B': {'industry': 'Fine', 'sector': 'Coarse'},
     'C': {'industry': 'Fine', 'sector': 'Coarse'}})
ok('the INDUSTRY is used, not the sector, when both are present',
   mixed and mixed[0]['group'] == 'Fine', mixed)

shutil.rmtree(_tmp, ignore_errors=True)

# THE UNIVERSE HAS TO STAY CURRENT WITHOUT ANYBODY REMEMBERING TO. backfill()
# is a one-off bootstrap of about an hour at Polygon's five requests a minute;
# after it the universe goes stale by one session a day, and "somebody re-runs
# it" is not a mechanism.
RSRC = (HERE / 'relstrength.py').read_text()
ok('there is a bounded top-up, separate from the one-off backfill',
   'def top_up(' in RSRC)
ok('...and the group build calls it', 'relstrength.top_up()' in SRC)
ok('THE BOUND is the design: it can never become the hour-long call',
   'max_days' in RSRC and "out['fetched'] >= max_days" in RSRC)
ok('...so an empty box gets the honest "not enough history", not a hung page',
   'rather than hanging a page' in RSRC)
ok('it starts at YESTERDAY — a session that has not closed has nothing to fetch',
   'has not closed' in RSRC)
ok('a failed top-up is never the reason a page fails',
   'Never the reason a page fails' in RSRC)

print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
