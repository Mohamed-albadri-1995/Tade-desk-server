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
    C   NO    the EDGAR cache holds PARSED TABLES, not raw filings, so it
              carries no filing dates and there is no way to tell what had
              been filed by D. See edgar.build's own docstring.
    A   NO    the same cache, the same reason
    I   NO    oneil-13f.json records which quarters it used but not when each
              became public, so "the newest quarter as of D" is unanswerable

The three NOs are all the same fault — a date that was never stored — and all
three are fixable by storing it. Until they are, they refuse.

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
    'c': False,
    'a': False,
    'i': False,
}

WHY_NOT = {
    'c': ('the EDGAR cache holds parsed tables, not raw filings, so it '
          'carries no filing dates — there is no way to know what had been '
          'filed by this date'),
    'a': ('the EDGAR cache holds parsed tables, not raw filings, so it '
          'carries no filing dates — there is no way to know what had been '
          'filed by this date'),
    'i': ('the 13F file records which quarters it used but not when each one '
          'became public, so "the newest quarter as of this date" cannot be '
          'answered'),
}


def unavailable(letter: str) -> str | None:
    """Why this letter cannot be had as of a date, or None if it can.

    THE ONE PLACE THAT DECIDES. A caller that wants to know whether a setup is
    backtestable asks here; a caller that wants the values asks `asof`. Two
    lists would drift, and the drift would show up as a backtest that ran when
    it should have refused.
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

    return out
