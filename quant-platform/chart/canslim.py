"""The CANSLIM letters AS THEY WERE KNOWN ON A GIVEN DAY.

WHY THIS MODULE EXISTS, AND WHY IT REFUSES THINGS.

The card answers "what is this stock's C today". A backtest needs a different
question — "what was it on 14 March" — and the two are not the same question
asked twice. Every shared file this system writes describes TODAY:

    data/oneil-groups.json   today's group ranks
    data/oneil-13f.json      the four quarters published by now
    ~/.qp-cache/oneil/*.json every filing a company has ever made

Gate a backtest on any of those and every trade is taken with knowledge that
did not exist on the day. The equity curve comes out beautiful and means
nothing, and — worse — it means nothing in the direction that makes you trade
it. A backtest that flatters is not a weak backtest, it is a lie with a chart
attached.

So the rule this module is built on:

    A LETTER THAT CANNOT BE RECONSTRUCTED AS OF THE DATE IS NOT RETURNED.
    It comes back None with a reason. Never today's value.

which means a setup that gates on a letter this cannot reconstruct will refuse
to backtest rather than produce a flattering number. That refusal is the point.

WHAT CAN BE RECONSTRUCTED, AND HOW.

    M   yes   the market model is pure over index frames; truncate at D
    L   yes   groups.build(asof=D) — RS is recomputed from the price cache,
              which is already stored per session
    N   yes   read from this stock's own bars, truncated at D
    S   yes   the same
    C   yes   every row of the EDGAR c_table now carries `filed`, the date the
              figure became public; rows filed after D are dropped and the
              verdicts recomputed over what is left
    A   yes   the same, per fiscal year
    I   yes   oneil-13f.json now carries `published_by` per quarter — the
              median 13F filing date for it — so "the newest quarter as of D"
              is a date comparison

C, A and I refused outright until 2026-09-03, all three for the same fault: a
date that was never stored. Storing it is what this file was waiting for.

THEY STILL REFUSE PER TICKER, and that is not a leftover. A record written by
older code has no dates in it, and there is no way to date it after the fact —
so the letter comes back under `refused` FOR THAT SYMBOL with the reason,
rather than falling back to the newest row on file. Falling back is the exact
behaviour this module exists to prevent; it is what "today's value" means.

EXPENSIVE ONCE, FREE AFTERWARDS. Rebuilding the group ranks for one date takes
about twenty seconds on the box this runs on, and a register backtest asks for
the same date once per symbol. So a date is computed once, written to
~/.qp-cache/canslim/, and read back by every later caller — the same rule the
nine tools follow against the shared files.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from pathlib import Path

CACHE = Path(os.environ.get('QP_CANSLIM_CACHE')
             or (Path.home() / '.qp-cache' / 'canslim'))

# Bumped whenever the shape below changes, so a cached day written by older
# code is refetched rather than read with the wrong keys — the same guard
# edgar.SCHEMA provides for the fundamentals cache.
SCHEMA = 1

# WHY EACH LETTER IS OR IS NOT AVAILABLE AS OF A DATE. Held as data rather
# than as prose in a docstring, because the caller has to be able to SAY which
# letters a setup may use, and a sentence cannot be checked.
POINT_IN_TIME = {
    'm': True,
    'l': True,
    'n': True,
    's': True,
    # These three were False until the dates behind them were stored — see
    # this module's docstring, edgar.SCHEMA note 5, and f13's `published_by`.
    'c': True,
    'a': True,
    'i': True,
}

WHY_NOT: dict[str, str] = {}


# THE PER-TICKER REFUSALS. A letter being reconstructable IN PRINCIPLE (above)
# is a different claim from it being reconstructable FOR THIS SYMBOL ON THIS
# DAY, and conflating the two is how a stock with an old cache record would
# quietly get today's earnings dated to March. Held as data for the same reason
# POINT_IN_TIME is: the caller has to be able to read back exactly why.
NO_RECORD = ('no EDGAR record for this ticker, or one written before filing '
             'dates were stored — there is no way to tell what had been filed '
             'by this date, and the newest row on file is not an answer')
NO_ROWS = ('the EDGAR record has no {t} rows carrying a filing date, so '
           'nothing on it can be placed before or after this date')
NOT_YET = ('nothing had been filed by this date — the record starts later')
NO_13F = ('no 13F file, or one written before `published_by` was recorded, so '
          '"the newest quarter as of this date" cannot be answered')
NOT_HELD = ('this ticker has no 13F quarter that was public by this date')


def unavailable(letter: str) -> str | None:
    """Why this letter cannot be had as of a date, or None if it can.

    THE ONE PLACE THAT DECIDES, and it answers about the LETTER, not about a
    particular stock — a symbol whose own record cannot support the letter is
    refused by `asof` instead, with a reason naming the record. A caller that
    wants to know whether a setup is backtestable at all asks here.
    """
    return None if POINT_IN_TIME.get(str(letter or '').lower()) else \
        WHY_NOT.get(str(letter or '').lower(), f'unknown letter {letter!r}')


def refusals(letters) -> dict:
    """{letter: why} for every requested letter that is not point-in-time.

    Empty means the whole set can be backtested honestly. Anything in it is a
    letter the caller must drop or a backtest it must not run.
    """
    out = {}
    for k in (letters or ()):
        why = unavailable(k)
        if why:
            out[str(k).lower()] = why
    return out


def _path(date: str) -> Path:
    return CACHE / f'{date}.json'


def _prior_session(date: str, back: int = 63) -> str | None:
    """The cached session `back` sessions before `date`, for L's rotation.

    FROM THE SESSIONS THAT EXIST, not by subtracting days. Ninety calendar
    days back lands on a weekend or a holiday about a third of the time, and
    `groups.build` would then compare against a day it has no prices for and
    silently report no rotation.
    """
    from chart import relstrength
    days = [d for d in relstrength.cached_days() if d <= date]
    if len(days) <= back:
        return None
    return days[-(back + 1)]


def build_day(date: str, log=lambda _m: None) -> dict:
    """Every point-in-time letter for every symbol, as of one date.

    Pure enough to check: it reads the price cache and the industry map and
    computes. Nothing here fetches.
    """
    from chart import groups, oneil, relstrength

    out = {'schema': SCHEMA, 'date': date,
           'built_at': _dt.datetime.now(_dt.timezone.utc).isoformat(
               timespec='seconds')}

    # M — the market model, from index frames truncated at D. The model is
    # pure over its frames, so cutting them is the whole of the as-of.
    try:
        m = oneil.build(asof=date)
        out['m'] = {'status': m.get('status'),
                    'status_label': m.get('status_label'),
                    'distribution_days': len(m.get('distribution_days') or []),
                    'ok': bool(m.get('ok'))}
    except Exception as e:                                # noqa: BLE001
        out['m'] = {'ok': False, 'error': str(e)[:200]}
        log(f'  M failed for {date}: {e}')

    # L — group ranks over the RS ratings of that day. `prior_asof` is what
    # makes the 3-month rotation a rotation rather than a snapshot.
    try:
        g = groups.build(asof=date, prior_asof=_prior_session(date))
        # `build` already flattens the groups to symbol rows; walking them
        # again would be the same work twice and a second place to disagree.
        rows = g.get('stocks') or {}
        out['l'] = {
            'ok': bool(g.get('ok')),
            'total_groups': g.get('total_groups'),
            'stocks': {s: {'group': v.get('group'),
                           'group_rank': v.get('group_rank'),
                           'group_of': v.get('group_of'),
                           'group_pct': v.get('group_pct'),
                           'group_level': v.get('group_level'),
                           'rs_in_group': v.get('rs_in_group'),
                           'members': v.get('members')}
                       for s, v in (rows or {}).items()},
        }
    except Exception as e:                                # noqa: BLE001
        out['l'] = {'ok': False, 'error': str(e)[:200], 'stocks': {}}
        log(f'  L failed for {date}: {e}')

    # RS itself, which is L's input and a reading in its own right.
    try:
        rs = relstrength.rs_rating(asof=date)
        out['rs'] = {str(k): float(v) for k, v in rs.items()} if rs is not None \
            and not rs.empty else {}
    except Exception as e:                                # noqa: BLE001
        out['rs'] = {}
        log(f'  RS failed for {date}: {e}')

    # N and S are read per symbol from that symbol's own bars, so there is
    # nothing market-wide to precompute — `asof` does them on demand.
    return out


def day(date: str, rebuild: bool = False, log=lambda _m: None) -> dict:
    """The cached market-wide letters for `date`, building them if needed.

    COMPUTED ONCE, READ MANY. A register backtest asks for one date once per
    symbol in that day's register, and rebuilding the group ranks each time
    would turn a twenty-second job into an hour of them.
    """
    p = _path(date)
    if not rebuild:
        try:
            rec = json.loads(p.read_text())
            if rec.get('schema') == SCHEMA:
                return rec
        except Exception:                                 # noqa: BLE001
            pass
    rec = build_day(date, log=log)
    try:
        CACHE.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix('.tmp')
        tmp.write_text(json.dumps(rec))
        tmp.replace(p)                    # atomic: a reader never sees half
    except Exception:                                     # noqa: BLE001
        pass                              # a cache that cannot be written is
        # not a reason to fail the read — the answer is already computed.
    return rec


# A BACKTEST WANTS WHATEVER IS ON DISK, however old. The age of the cache is
# not the question `asof` asks — every row in it is stamped with the day it
# became public, and rows filed after the as-of date are dropped by date. An
# old record can only hold FEWER quarters than a fresh one, which understates
# and never flatters, so there is nothing to protect against here.
_ANY_AGE = 36500.0


def _visible(rows, date: str, kind: str):
    """(rows public by `date`, why not) — newest first, or None and a reason.

    UNDATED ROWS ARE DROPPED, NOT ASSUMED. A row with no `filed` cannot be
    placed on either side of the date; keeping it would risk look-ahead and
    dropping it can only lose a quarter the reader might have had. Losing one
    understates the stock, which is the safe direction and the only one of the
    two that cannot manufacture a trade.
    """
    dated = [r for r in (rows or []) if r.get('filed')]
    if not dated:
        return None, NO_ROWS.format(t=kind)
    out = [r for r in dated if str(r['filed']) <= str(date)]
    if not out:
        return None, NOT_YET
    return out, None


def _fundamentals(sym: str, date: str, usable, out: dict, log) -> None:
    """C and A as of `date`, from the per-ticker EDGAR record.

    THE ROWS ARE FILTERED AND THE VERDICTS RECOMPUTED, through `edgar`'s own
    `c_summary`/`a_summary`. Keeping the record's stored verdicts and only
    trimming the rows would be the subtler version of the bug this module is
    about: "accelerating" computed over three quarters, one of which had not
    been reported, is a true statement about a table nobody could see.
    """
    from chart import edgar
    try:
        rec = edgar.cached(sym, max_age_days=_ANY_AGE)
    except Exception as e:                                # noqa: BLE001
        log(f'  EDGAR cache failed for {sym}: {e}')
        rec = None
    # A record from before SCHEMA 5 has no filing dates at all, and `cached`
    # already treats a schema mismatch as absent — so this one branch covers
    # both "never walked" and "walked by code that dropped the date".
    if not rec or not rec.get('ok'):
        for k in usable:
            out['refused'][k] = NO_RECORD
        return
    for k in usable:
        rows, why = _visible(((rec.get(k) or {}).get('rows')), date,
                             'quarterly' if k == 'c' else 'annual')
        if rows is None:
            out['refused'][k] = why
            continue
        summary = edgar.c_summary(rows) if k == 'c' else edgar.a_summary(rows)
        out[k] = {'rows': rows, 'latest': rows[0], **summary}


def _sponsorship(sym: str, date: str, out: dict, log) -> None:
    """I as of `date`, from the quarters that were public by then.

    The direction is recomputed by `f13.trend` over the visible quarters, not
    read from the file: the file's trend is over four quarters ending in the
    newest one, and on a past day the newest one had not been filed.
    """
    from chart import f13
    try:
        doc = json.loads(f13.SHARED.read_text())
    except Exception as e:                                # noqa: BLE001
        log(f'  13F read failed: {e}')
        out['refused']['i'] = NO_13F
        return
    pub = doc.get('published_by') or {}
    row = ((doc.get('stocks') or {}).get(sym) or {})
    hist = row.get('quarters')
    if not pub or not isinstance(hist, list) or not hist:
        out['refused']['i'] = NO_13F if not pub else NOT_HELD
        return
    seen = [h for h in hist
            if pub.get(h.get('q')) and str(pub[h['q']]) <= str(date)]
    if not seen:
        out['refused']['i'] = NOT_HELD
        return
    seen.sort(key=lambda h: h.get('q') or '')
    out['i'] = {
        'quarters': seen,
        'newest': seen[-1].get('q'),
        'funds': seen[-1].get('funds'),
        'of': seen[-1].get('of'),
        'share_pct': seen[-1].get('share_pct'),
        # WHETHER THE DATE WAS MEASURED OR THE STATUTORY DEADLINE. A quarter
        # dated by the 45-day rule rather than by its filings is still usable
        # and is not evidence, and a reader has to be able to tell.
        'published_by': pub.get(seen[-1].get('q')),
        'published_measured': bool((doc.get('published_measured') or {})
                                   .get(seen[-1].get('q'))),
        'holder_unit': doc.get('holder_unit'),
        **f13.trend([h.get('funds') for h in seen],
                    [h.get('of') for h in seen]),
    }
    # THE SAME COLLISION `f13.build` GUARDS AGAINST. `trend` is merged into a
    # dict that already holds a `quarters` history, and it returned a key by
    # that name once — silently replacing the list with a count.
    assert isinstance(out['i']['quarters'], list), 'trend clobbered the history'


def asof(symbol: str, date: str, want=('m', 'l'), log=lambda _m: None) -> dict:
    """The CANSLIM letters for one symbol as they were KNOWN on `date`.

    `want` names the letters the caller intends to use. Any of them that is
    not point-in-time comes back under `refused` with the reason, and NOT as a
    value — see this module's docstring. A caller that ignores `refused` gets
    no numbers for those letters rather than yesterday's answer dressed as
    that day's.
    """
    sym = str(symbol or '').upper()
    want = tuple(str(w).lower() for w in (want or ()))
    out = {'symbol': sym, 'date': date, 'refused': refusals(want)}

    usable = [w for w in want if w not in out['refused']]
    if not usable:
        return out

    if {'m', 'l'} & set(usable):
        rec = day(date, log=log)
        if 'm' in usable:
            out['m'] = rec.get('m')
        if 'l' in usable:
            out['l'] = ((rec.get('l') or {}).get('stocks') or {}).get(sym)
            out['rs'] = (rec.get('rs') or {}).get(sym)

    if {'n', 's'} & set(usable):
        from chart import base as bmod, ratings
        import tools.compare_server as cs
        try:
            bars, _ts, _ctx = cs.prepare_bars(sym, '1d', 560, 'yahoo', 'all',
                                              date)
            if 'n' in usable:
                b = bmod.analyse(bars)
                out['n'] = ({'weeks': b.get('weeks'),
                             'depth_pct': b.get('depth_pct'),
                             'pivot': b.get('pivot'),
                             'pct_to_pivot': b.get('pct_to_pivot'),
                             'score': b.get('score'), 'of': b.get('of')}
                            if b.get('ok') else
                            {'ok': False, 'reason': b.get('reason')
                             or b.get('error')})
            if 's' in usable:
                ud = ratings.up_down_volume_ratio(bars)
                ad = ratings.acc_dis(bars)
                out['s'] = {'ud_ratio': (ud or {}).get('ratio'),
                            'ad_letter': (ad or {}).get('letter'),
                            'ad_raw': (ad or {}).get('raw')}
        except Exception as e:                            # noqa: BLE001
            log(f'  bars failed for {sym} @ {date}: {e}')
            for k in ({'n', 's'} & set(usable)):
                out[k] = {'ok': False, 'error': str(e)[:200]}

    # C AND A come from the per-ticker EDGAR record, filtered by filing date.
    _fund = [k for k in ('c', 'a') if k in usable]
    if _fund:
        _fundamentals(sym, date, _fund, out, log)

    # I comes from the shared 13F file, filtered by when each quarter became
    # public. Both may add to `refused` — a letter this module can reconstruct
    # in principle is still refused for a stock whose own record cannot
    # support it, and the key stays ABSENT either way.
    if 'i' in usable:
        _sponsorship(sym, date, out, log)

    return out
