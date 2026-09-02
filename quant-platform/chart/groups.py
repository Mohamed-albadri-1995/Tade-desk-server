"""The L in CAN SLIM: is the GROUP strong, and is this stock the leader in it.

WHY THE GROUP AND NOT THE SECTOR.

O'Neil published the arithmetic: **37% of a stock's price move is attributed to
its industry group, another 12% to its sector.** Roughly half the move is not
about the company. The existing sector heatmap is 15 ETFs — the coarse level,
and the one where "Technology is strong" tells you nothing about which of four
hundred technology names to own.

TWO SEPARATE FACTS, AND BOTH MATTER.

    is the group strong          rank 63 of 197
    is this stock the leader     RS 1 of 13

O'Neil buys the #1 or #2 name in a top group, not the cheapest name in it. A
stock can carry RS 95 — top 5% of the whole market — and still be **8 of 13**
inside its own group, which means twelve better expressions of the same theme
are on the screen beside it. Nothing in this system said that before.

ONE FACT, THREE PRESENTATIONS, AND THEY CANNOT DISAGREE.

MarketSmith prints `Industry 197 Rank 63`, `Group RS Rating 68` and `B+`. Those
are not three measurements: 1 − 63/197 = 68%, and B+ is that percentile in
letter form. Building them as three fields would imply three independent reads
and invite a page that showed them disagreeing when they cannot. So the RANK is
stored and the other two are derived here, once.

THE DIVISOR TRAVELS WITH THE RANK. IBD restructured its group list from 197 to
145. Code that hardcodes a divisor, and history that does not record which one
it was computed under, silently rewrites its own past the day the number
changes. Every rank in this module carries the count it was ranked against, and
the page prints `63 of 197`, never a bare `63`.

WHERE THE MEMBERSHIP COMES FROM, AND THE HONEST LIMIT.

IBD's 197-way split is proprietary — both the boundaries and the "certain
stocks within that industry" the curve fit runs on. What we have instead is the
industry label the screener tools already receive on every card, accumulated
into a shared map as they scan. That is finer than a sector and coarser than
IBD's list.

So this is OUR group rank, not IBD's, and it says so everywhere it is printed.
The rank WITHIN a group and the member count are exact given whatever
membership is used — and those are the two facts O'Neil actually trades on.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from pathlib import Path

import pandas as pd

# Written by qp, read by the nine tools — same contract as oneil-market.json.
SHARED = Path(os.environ.get('ONEIL_GROUPS_FILE')
              or (Path(__file__).resolve().parents[2] / 'data' / 'oneil-groups.json'))

# The symbol → industry map the screener tools accumulate as they scan. They
# receive it on every card already; qp has prices for the whole universe and no
# industry labels at all, so this is the one direction the data has to flow.
MAP_FILE = Path(os.environ.get('INDUSTRY_MAP_FILE')
                or (Path(__file__).resolve().parents[2] / 'data' / 'industry-map.json'))

# A group needs enough members for a median to mean anything.
#
# THREE WAS TOO FEW, AND THE RANKING SHOWED IT. From the live group table:
#
#     1 of 229  Computer Storage Devices               5 members
#     3 of 229  Services-Skilled Nursing Care Facilities  3 members
#     5 of 229  Wholesale-Electronic Parts & Equipment  5 members
#
# The median of three IS the middle stock. So "the #1 industry group in the
# market" was one company's twelve-month move wearing an industry's name, and
# O'Neil's whole instruction — buy the leader of a top group — was pointed at
# noise. Small groups also have the widest spread, so they crowd BOTH ends of
# the ranking and push real industries into the middle.
#
# Six is where the median stops being a single stock: at an even count it is
# the average of the two middle names, so no one company can be the group.
MIN_MEMBERS = int(os.environ.get('QP_GROUP_MIN_MEMBERS') or 6)

# How far back the rotation comparison looks. Three months is the horizon over
# which a group's rank moving is a change in industry conditions rather than
# noise — and it is the same computation that serves N ("new industry
# conditions", spec §10.1), computed once and read twice.
ROTATION_SESSIONS = 63

LIMIT_NOTE = ("Our group definitions, not IBD's. IBD's 197-way split and the "
              "members its curve fit runs on are proprietary; this uses the "
              "industry label the screener tools already receive. The rank "
              "WITHIN a group and the member count are exact for whatever "
              "membership is used, and those are the two facts O'Neil trades "
              "on.")


# The letter bands. OURS, EVENLY SPACED, AND STATED AS OURS.
#
# An earlier version picked cut-points to make one screenshot's pairing come
# out right — and landed a band away from it anyway. IBD does not publish its
# boundaries, and guessing them is how the follow-through threshold went wrong
# twice already.
#
# So these are plain and defensible: each letter owns 20 points of the 1-99
# scale, split into even thirds for +, plain and -. They are derived from OUR
# percentile, which is derived from OUR group rank. A letter that looked like
# IBD's and was not would be the same trap as calling a reconstruction
# "IBD RS".
LETTER_BANDS = ((94, 'A+'), (87, 'A'), (80, 'A-'),
                (74, 'B+'), (67, 'B'), (60, 'B-'),
                (54, 'C+'), (47, 'C'), (40, 'C-'),
                (34, 'D+'), (27, 'D'), (20, 'D-'))

LETTER_NOTE = ('Our banding, evenly spaced over the 1-99 scale: each letter '
               'owns 20 points, split in thirds. IBD does not publish its '
               'boundaries, so these are not claimed to match.')


def letter(pct):
    """The A+ … E band of a 1-99 percentile. See LETTER_BANDS."""
    if pct is None or pct != pct:
        return None
    for cut, lab in LETTER_BANDS:
        if pct >= cut:
            return lab
    return 'E'


def rank_to_pct(rank: int, total: int) -> int | None:
    """rank 63 of 197 → the 68th percentile. The one conversion, in one place.

    Note the direction reversal, which is the whole reason this is a named
    function: a rank counts UP from best, a percentile counts DOWN. A bare
    number is excellent as one and mediocre as the other.
    """
    if not total or rank is None:
        return None
    # 1 - rank/total, NOT 1 - (rank-1)/total. Checked against MarketSmith's own
    # panel: rank 63 of 197 prints as Group RS Rating 68, and only this form
    # gives 68 — the off-by-one version gives 69. The audit asserts the
    # published pair rather than the formula, which is what caught it.
    #
    # Clipped to 1..99 like every other rating in this system: both ends are
    # real groups, and nothing is outside the market it is measured against.
    return max(1, min(99, int(round((1 - rank / total) * 100))))


def read_map() -> dict:
    """symbol → {'sector', 'industry'}. Absent is empty, never an error."""
    try:
        raw = json.loads(MAP_FILE.read_text())
        return raw.get('symbols', raw) if isinstance(raw, dict) else {}
    except Exception:                                     # noqa: BLE001
        return {}


def _group_of(entry) -> str | None:
    if isinstance(entry, str):
        return entry.strip() or None
    if isinstance(entry, dict):
        # Industry first — the finer level is the point. Sector is the
        # fallback, and it is a materially coarser claim, so `level` records
        # which one a row was built from rather than letting them blend.
        for key in ('industry', 'sector'):
            v = (entry.get(key) or '').strip()
            if v:
                return v
    return None


def _sector_of(entry) -> str | None:
    """The SIC major group — the level above the industry, already on every
    entry the map's SIC pass wrote. Nothing new is fetched to roll up."""
    if isinstance(entry, dict):
        return (entry.get('sector') or '').strip() or None
    return None


# The name a rolled-up bucket carries. Never the bare sector name: a stock in
# "Business Services" that got there because its own industry was too small to
# rank is in a DIFFERENT bucket from one classified at the sector level, and
# printing both as "Business Services" would merge two different claims.
def _rollup_name(sector: str) -> str:
    return f'{sector} — small industries'


def build_groups(rs: pd.Series, mapping: dict) -> list[dict]:
    """Rank the groups, and rank the stocks inside each one.

    Pure: hand it a ratings series and a membership map and it returns the same
    answer every time. Everything that fetches is in `build()`.

    Ranked on the MEDIAN member rating, not the mean. One 99 in a group of
    laggards is a single stock's story, and a mean lets that one name carry the
    whole group — which is exactly the mistake the group level exists to
    prevent.
    """
    by: dict[str, list[tuple[str, float]]] = {}
    sectors: dict[str, str] = {}
    for sym, entry in (mapping or {}).items():
        g = _group_of(entry)
        if not g:
            continue
        s = str(sym).upper()
        v = rs.get(s)
        if v is None or v != v:
            continue
        by.setdefault(g, []).append((s, float(v)))
        sec = _sector_of(entry)
        if sec:
            sectors[s] = sec

    # ROLLED UP, NOT THROWN AWAY.
    #
    # Raising the floor on its own would have quietly deleted the L letter for
    # every stock in a small industry — the card would say "not in the
    # industry map" for a stock that is in it, in an industry too thin to
    # rank. SIC is a hierarchy, so there is a real level above: an industry
    # below the floor merges into its own major group, which every entry the
    # SIC pass wrote already carries. Nothing is fetched and nothing invented;
    # the group is simply named one level up, and `level` says so.
    level: dict[str, str] = {g: 'industry' for g in by}
    for g in [g for g, m in by.items() if len(m) < MIN_MEMBERS]:
        members = by.pop(g)
        for s, v in members:
            sec = sectors.get(s)
            if not sec:
                continue        # a tool-written label with no sector above it
            name = _rollup_name(sec)
            by.setdefault(name, []).append((s, v))
            level[name] = 'sector'
        level.pop(g, None)

    rows = []
    for g, members in by.items():
        # Still short after the roll-up — a whole major group with fewer than
        # six ranked names. Dropped, as before: there is no level above it.
        if len(members) < MIN_MEMBERS:
            continue
        members.sort(key=lambda t: -t[1])
        vals = pd.Series([v for _, v in members])
        rows.append({
            'group': g,
            # WHICH LEVEL THIS ROW WAS BUILT AT. A rolled-up bucket is a
            # coarser claim than a named industry and must never be presented
            # as the same thing — the module note has said so since the first
            # version, and nothing set the field until there was a roll-up.
            'level': level.get(g, 'industry'),
            'members': len(members),
            'median_rs': round(float(vals.median()), 1),
            'top_rs': round(float(vals.max()), 1),
            # How much of the group is genuinely strong, which separates a
            # broad advance from one runaway name.
            'share_over_80': round(float((vals >= 80).mean()), 2),
            # THE LEADERS, BY NAME. "Top RS 99" is a number; "BGFV 99 · HIBB
            # 97" is the shortlist O'Neil would actually buy from.
            'leaders': [{'symbol': s, 'rs': int(v)} for s, v in members[:5]],
            # RANK WITHIN THE GROUP for every member — the "RS 1 of 13" that
            # says whether this is the leader or the twelfth-best way to own
            # the same theme.
            '_ranks': {s: i + 1 for i, (s, _) in enumerate(members)},
        })

    rows.sort(key=lambda r: -r['median_rs'])
    total = len(rows)
    for i, r in enumerate(rows):
        r['rank'] = i + 1
        # THE DIVISOR IS STORED WITH THE VALUE. See the module note: IBD went
        # from 197 groups to 145, and a stored rank with no divisor rewrites
        # its own past the day the count changes.
        r['of'] = total
        r['pct'] = rank_to_pct(r['rank'], total)
        r['letter'] = letter(r['pct'])
    return rows


def stock_rows(groups: list[dict]) -> dict:
    """symbol → everything the CARD needs, flattened so a lookup is one hit.

    The card renders 150 times a minute; walking the group list to find a
    symbol on each one would be 150 scans of the same list.
    """
    out = {}
    for g in groups:
        for sym, rank in (g.get('_ranks') or {}).items():
            out[sym] = {
                'group': g['group'],
                'group_level': g.get('level', 'industry'),
                'group_rank': g['rank'],
                'group_of': g['of'],
                'group_pct': g['pct'],
                'group_letter': g['letter'],
                'members': g['members'],
                # "RS 1 of 13". The rank O'Neil is strictest about, and the
                # one nothing in this system showed before.
                'rs_in_group': rank,
            }
    return out


def unranked(rs, mapping: dict, ranked: dict) -> dict:
    """Symbols that ARE in the industry map but got no group rank, and why.

    THE CARD WAS BLAMING THE WRONG THING. A stock absent from `stocks` printed
    "not in the industry map — an ETF, or a filer with no SIC code", and for
    four of five names on a live screen that was simply untrue: Fervo Energy
    is a $5.8bn power producer, classified, mapped, and still unranked.

    The reason is upstream and it is not a fault. A group rank is built from
    RS ratings, and O'Neil's RS rating is defined as a TWELVE-MONTH weighted
    performance — a stock without a full year of sessions has no rating, by
    construction, not by omission. `raw_scores` says so in as many words: an
    eight-month-old IPO up 300% would otherwise outrank every established
    leader on a measure defined as twelve months long. The same gate drops
    anything under the price and liquidity floors.

    So there are three states, not two, and only one of them is "missing":

        ranked        in the map, rated, in a group big enough to rank
        unranked      in the map, but no RS rating — a young listing or an
                      illiquid one. A real CANSLIM fact, not a gap.
        absent        not in the map at all — an ETF, or no SIC code

    Waiting fixes the first kind of silence and never the third; the second
    fixes itself on the stock's first birthday.
    """
    out = {}
    # NO `or []` HERE. A pandas Index has no truth value — `idx or []` raises
    # "The truth value of an Index is ambiguous" the moment rs is a real
    # Series, which is every time outside a test.
    idx = set(rs.index) if rs is not None and hasattr(rs, 'index') else set()
    for sym, entry in (mapping or {}).items():
        s = str(sym).upper()
        if s in ranked:
            continue
        out[s] = {
            'industry': _group_of(entry) or '',
            # Present in the price universe but unrated means it met none of
            # the gate's conditions; absent means we have no bars for it.
            'why': 'gate' if s in idx else 'nodata',
        }
    return out


def build(asof: str | None = None, prior_asof: str | None = None) -> dict:
    """Fetch the ratings, rank the groups, and compare with three months ago.

    The only part that touches data. `prior_asof` is what makes ROTATION
    possible: a group's rank today means little, and a group that has climbed
    from 141 to 28 over a quarter is the measurable trace of O'Neil's third
    "new" — a change for the better in the conditions of an industry (spec
    §10.1). Same computation, read by both L and N.
    """
    from chart import relstrength
    mapping = read_map()
    out = {
        'built_at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds'),
        'as_of': asof,
        'mapped_symbols': len(mapping),
        'min_members': MIN_MEMBERS,
        'rotation_sessions': ROTATION_SESSIONS,
        'limit_note': LIMIT_NOTE,
        'letter_note': LETTER_NOTE,
    }
    if not mapping:
        # NOT an error, and it says what to do about it. The map is filled by
        # the screener tools as they scan, so on a fresh box it is empty until
        # the first scan runs.
        out.update({'ok': False, 'groups': [], 'stocks': {},
                    'error': 'no industry map yet — the screener tools write it '
                             'as they scan, so this fills in after the first scan'})
        return out
    try:
        # KEEP THE UNIVERSE CURRENT WITHOUT ANYBODY REMEMBERING TO. backfill()
        # is a one-off bootstrap of about an hour; after it the universe goes
        # stale by a session a day, and this build already runs at most twice a
        # day behind its own TTL. Bounded to a few requests so it can never
        # become the hour-long one — see relstrength.top_up().
        out['top_up'] = relstrength.top_up()
        rs = relstrength.rs_rating(asof)
        if rs is None or rs.empty:
            out.update({'ok': False, 'groups': [], 'stocks': {},
                        'error': 'no RS ratings available'})
            return out
        groups = build_groups(rs, mapping)

        # ROTATION. Best effort on purpose: a box with less than a quarter of
        # cached grouped-daily files simply has no comparison yet, and that is
        # a missing column rather than a failed build.
        try:
            days = relstrength.cached_days()
            if prior_asof is None and len(days) > ROTATION_SESSIONS:
                prior_asof = days[-(ROTATION_SESSIONS + 1)]
            if prior_asof:
                prior = build_groups(relstrength.rs_rating(prior_asof), mapping)
                was = {g['group']: (g['rank'], g['of']) for g in prior}
                for g in groups:
                    p = was.get(g['group'])
                    if not p:
                        continue
                    g['rank_3mo'] = p[0]
                    g['of_3mo'] = p[1]
                    # A rank falling is the group IMPROVING — see rank_to_pct
                    # on why the direction has to be said out loud.
                    g['rotation'] = ('into' if g['rank'] < p[0]
                                     else 'out of' if g['rank'] > p[0] else 'flat')
                out['rotation_from'] = prior_asof
        except Exception as e:                            # noqa: BLE001
            out['rotation_error'] = str(e)[:200]

        out.update({
            'ok': True,
            'as_of': asof or (relstrength.cached_days() or [None])[-1],
            'total_groups': len(groups),
            # `_ranks` is an index, not something a page should read. Stripped
            # here so the published file is what it claims to be.
            'groups': [{k: v for k, v in g.items() if not k.startswith('_')}
                       for g in groups],
            'stocks': stock_rows(groups),
            'unranked': unranked(rs, mapping, stock_rows(groups)),
        })
        return out
    except Exception as e:                                # noqa: BLE001
        out.update({'ok': False, 'groups': [], 'stocks': {}, 'error': str(e)[:300]})
        return out


def write_shared(model: dict) -> str | None:
    """Publish for the nine tools. Never raises — see oneil.write_shared."""
    try:
        SHARED.parent.mkdir(parents=True, exist_ok=True)
        tmp = SHARED.with_suffix('.tmp')
        tmp.write_text(json.dumps(model, default=str))
        tmp.replace(SHARED)                 # atomic: a reader never sees half
        return str(SHARED)
    except Exception:                                     # noqa: BLE001
        return None


def read_shared() -> dict | None:
    try:
        return json.loads(SHARED.read_text())
    except Exception:                                     # noqa: BLE001
        return None
