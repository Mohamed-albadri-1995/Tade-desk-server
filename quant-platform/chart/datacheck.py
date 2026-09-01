"""Does every data source actually return USABLE data? Not "is it up".

WHY THIS EXISTS, AND WHY `_feed_status()` IS NOT IT.

`tools/compare_server.py::_feed_status()` reports which feeds have credentials
configured, and its own docstring says why that is not enough:

    "A key being PRESENT is not evidence that the plan behind it includes the
     data being asked for."

That was paid for in a live session — every 1-minute Polygon request 403'd
while the inventory reported polygon as the best feed available. This module
is the other half: it FETCHES, and then it looks at what came back.

THE FAILURE THIS IS REALLY FOR. A source that is DOWN is the easy case: it
throws, something logs, somebody notices. The dangerous case is a source that
answers 200 with data that is wrong — empty, stale, all-NaN, the wrong symbol,
a raw price where an adjusted one was expected. Every one of those renders as
a normal-looking card. Nothing in this system would have caught any of them.

So every check asks about CONTENT, not status:

    is there anything there          rows, not an empty frame
    is it recent                     the last bar, against the calendar
    is it whole                      no NaN closes, no zero volume
    is it plausible                  prices positive, moves under a limit
    does it AGREE with another source the strongest test there is

THE AGREEMENT CHECK IS THE ONE THAT EARNS ITS KEEP. Two independent feeds that
both return a number are still both wrong if they disagree, and only one of
them can be right. Yahoo and Polygon quoting the same session of the same
symbol should match to a fraction of a percent; when they do not, something
real is broken — a split not applied, a wrong symbol, a stale cache — and no
single-source check can see it.

JUDGEMENT IS SEPARATE FROM FETCHING, on purpose. `judge_bars()` is pure and
takes a frame; `check_feed()` fetches and calls it. That is what lets the
offline audit test the judgement — hand it an empty frame, a stale one, one
full of NaN — without a network, which is the only way to know the checker
would actually catch anything.
"""

from __future__ import annotations

import datetime as _dt
import json
import time
from pathlib import Path

import pandas as pd

# How stale is too stale. Trading days, not calendar days: a Monday morning
# check must not fail because Saturday and Sunday exist, and a long weekend
# must not fail either.
MAX_STALE_SESSIONS = 5

# Two feeds quoting the same session of the same symbol should agree to about
# this. Wider than a rounding difference, far narrower than a split, a wrong
# symbol or a stale cache — which are the things this is looking for.
AGREE_PCT = 0.5

# A daily bar that moved more than this is almost certainly a data error rather
# than a market event, at index level. Individual stocks do move 50% in a day;
# indexes do not, and the indexes are what the market model runs on.
ABSURD_MOVE_PCT = 25.0


def _sev(ok: bool, degraded: bool = False) -> str:
    """OK, DEGRADED and DOWN are three states, not two.

    The first version returned 'ok' the moment `ok` was true and never looked
    at `degraded`, so a source with real warnings against it — sessions missing
    volume, a comparison that could not be made — reported as fully healthy.
    A health check that cannot say "working, but" is a health check that hides
    the only interesting case.

    `ok` means USABLE. `severity` says how comfortably.
    """
    if not ok:
        return 'down'
    return 'degraded' if degraded else 'ok'


def judge_bars(df, *, label: str, min_rows: int = 15,
               max_stale: int = MAX_STALE_SESSIONS,
               absurd_move: float = ABSURD_MOVE_PCT) -> dict:
    """Look at a frame of bars and say whether it is USABLE. Pure.

    Every branch here is a way data has actually been wrong somewhere, rather
    than a way it could be wrong in principle:

        empty        the fetch "worked" and returned nothing
        short        a truncated window that silently shortens an indicator
        NaN closes   a gap the loader filled with nothing
        zero volume  a feed serving prices without volume, which quietly
                     disables every volume test in the platform
        stale        yesterday's data answering today's question
        absurd       a split not applied, or the wrong symbol entirely
    """
    out = {'name': label, 'rows': 0, 'ok': False, 'severity': 'down'}
    if df is None or not hasattr(df, 'empty') or df.empty:
        out['detail'] = 'no data returned'
        return out

    d = df.copy()
    d.columns = [str(c).lower() for c in d.columns]
    out['rows'] = len(d)
    problems, warnings = [], []

    if 'close' not in d.columns:
        out['detail'] = f'no close column, got {list(d.columns)}'
        return out

    if len(d) < min_rows:
        problems.append(f'only {len(d)} rows, expected at least {min_rows}')

    close = pd.to_numeric(d['close'], errors='coerce')
    nan_closes = int(close.isna().sum())
    if nan_closes:
        problems.append(f'{nan_closes} of {len(d)} closes are NaN')
    good = close.dropna()
    if len(good) and (good <= 0).any():
        problems.append('closes at or below zero')

    if 'volume' in d.columns:
        vol = pd.to_numeric(d['volume'], errors='coerce').fillna(0)
        zero = int((vol <= 0).sum())
        if zero == len(d):
            # A feed serving prices without volume disables every volume test
            # in this platform at once — distribution days, follow-throughs,
            # U/D ratio, A/D — and each of those would simply return "no
            # signal" rather than "no data".
            problems.append('every volume is zero — every volume test is dead')
        elif zero > len(d) * 0.05:
            # A few sessions with no volume is worth SAYING and not worth
            # failing on: real feeds have half-days and holidays that report
            # oddly. The threshold is low on purpose — 4 missing sessions in
            # 40 is not a holiday, it is a feed with gaps — but a warning
            # rather than a failure, because a check people learn to ignore is
            # worse than no check.
            warnings.append(f'{zero} of {len(d)} sessions have no volume')
        out['last_volume'] = float(vol.iloc[-1]) if len(vol) else None

    # Freshness, in trading days.
    last = None
    try:
        last = d.index[-1]
        last_date = last.date() if hasattr(last, 'date') else last
        today = _dt.datetime.now(_dt.timezone.utc).date()
        sessions = len(pd.bdate_range(last_date, today)) - 1
        out['as_of'] = str(last_date)
        out['stale_sessions'] = max(0, sessions)
        if sessions > max_stale:
            problems.append(f'last bar is {sessions} trading days old ({last_date})')
    except Exception:                                     # noqa: BLE001
        warnings.append('could not read the index as dates')

    # Monotonic index. Out-of-order bars make every rolling window wrong in a
    # way that produces numbers rather than errors.
    try:
        if not d.index.is_monotonic_increasing:
            problems.append('bars are not in chronological order')
        if d.index.has_duplicates:
            problems.append('duplicate timestamps')
    except Exception:                                     # noqa: BLE001
        pass

    if len(good) > 2:
        moves = (good.pct_change().abs() * 100).dropna()
        worst = float(moves.max()) if len(moves) else 0.0
        out['biggest_move_pct'] = round(worst, 2)
        if worst > absurd_move:
            problems.append(f'a {worst:.0f}% one-day move — a split not applied, '
                            f'or the wrong symbol')

    out['last_close'] = float(good.iloc[-1]) if len(good) else None
    out['problems'] = problems
    out['warnings'] = warnings
    out['ok'] = not problems
    out['severity'] = _sev(not problems, degraded=bool(warnings) and not problems)
    out['detail'] = ('; '.join(problems) if problems
                     else '; '.join(warnings) if warnings
                     else f'{len(d)} rows to {out.get("as_of", "?")}')
    return out


def judge_agreement(a, b, *, name_a: str, name_b: str,
                    tolerance: float = AGREE_PCT) -> dict:
    """Do two feeds quoting the same symbol agree on the sessions they share?

    THE STRONGEST CHECK HERE, and the only one that can catch a source which is
    confidently wrong. Both feeds returning well-formed recent data is not
    evidence either is right; disagreeing on the same session of the same
    symbol is proof one of them is not.

    Compared on the intersection of dates, on closes, as a percentage — so a
    holiday one venue kept and the other did not is not a failure, and a split
    applied by one and not the other is.
    """
    out = {'name': f'{name_a} vs {name_b}', 'ok': False, 'severity': 'down'}
    try:
        if a is None or b is None or a.empty or b.empty:
            out['detail'] = 'one side has no data — nothing to compare'
            out['severity'] = 'degraded'
            return out
        ca = pd.to_numeric(a.copy().rename(columns=str.lower)['close'], errors='coerce')
        cb = pd.to_numeric(b.copy().rename(columns=str.lower)['close'], errors='coerce')
        ca.index = [x.date() if hasattr(x, 'date') else x for x in ca.index]
        cb.index = [x.date() if hasattr(x, 'date') else x for x in cb.index]
        ca, cb = ca.dropna(), cb.dropna()
        shared = ca.index.intersection(cb.index)
        out['shared_sessions'] = len(shared)
        if len(shared) < 3:
            out['detail'] = f'only {len(shared)} shared sessions — nothing to compare'
            out['severity'] = 'degraded'
            return out
        diff = ((ca.loc[shared] - cb.loc[shared]).abs() / cb.loc[shared] * 100)
        worst = float(diff.max())
        median = float(diff.median())
        out.update({'worst_pct': round(worst, 3), 'median_pct': round(median, 3)})
        out['ok'] = worst <= tolerance
        out['severity'] = _sev(out['ok'])
        out['detail'] = (f'agree to {worst:.3f}% at worst over {len(shared)} sessions'
                         if out['ok'] else
                         f'DISAGREE by up to {worst:.2f}% over {len(shared)} sessions '
                         f'— one of them is wrong')
        return out
    except Exception as e:                                # noqa: BLE001
        out['detail'] = f'could not compare: {str(e)[:120]}'
        return out


def judge_file(path, *, label: str, max_age_hours: float = 36.0,
               require: tuple = ()) -> dict:
    """A shared JSON file: is it there, does it parse, is it fresh, is it full?

    The shared files are how qp talks to the nine tools, and a stale one is the
    quiet failure: every page renders, every number looks like a number, and
    the market status is a fortnight old.
    """
    out = {'name': label, 'ok': False, 'severity': 'down', 'path': str(path)}
    try:
        p = Path(path)
        if not p.exists():
            out['detail'] = 'not written yet'
            return out
        raw = json.loads(p.read_text())
        age_h = (time.time() - p.stat().st_mtime) / 3600
        out['age_hours'] = round(age_h, 1)
        out['bytes'] = p.stat().st_size
        missing = [k for k in require if not raw.get(k)]
        if missing:
            out['detail'] = f'present but missing/empty: {", ".join(missing)}'
            return out
        if age_h > max_age_hours:
            out['detail'] = f'{age_h:.0f} hours old — nothing has rebuilt it'
            out['severity'] = 'degraded'
            return out
        out['ok'] = True
        out['severity'] = 'ok'
        out['detail'] = f'{p.stat().st_size:,} bytes, {age_h:.1f}h old'
        return out
    except json.JSONDecodeError as e:
        out['detail'] = f'does not parse as JSON: {str(e)[:80]}'
        return out
    except Exception as e:                                # noqa: BLE001
        out['detail'] = str(e)[:120]
        return out


# ---------------------------------------------------------------------------
# The probes. Everything below here touches the network.
# ---------------------------------------------------------------------------

def check_feed(feed: str, symbol: str = 'SPY', days: int = 40) -> dict:
    """Fetch and judge one loader."""
    from chart import data_manager
    t0 = time.time()
    try:
        df = data_manager.load_bars(symbol, '1d', days, feed)
    except Exception as e:                                # noqa: BLE001
        return {'name': f'{feed}:{symbol}', 'ok': False, 'severity': 'down',
                'ms': int((time.time() - t0) * 1000),
                'detail': f'fetch failed: {str(e)[:160]}'}
    out = judge_bars(df, label=f'{feed}:{symbol}')
    out['ms'] = int((time.time() - t0) * 1000)
    return out


def check_universe() -> dict:
    """Polygon grouped-daily: the whole-US-market frame the RS rating needs.

    THE COUNT IS THE CHECK. A grouped-daily response with forty rows in it is
    not a market — it is a partial page, a filtered plan, or a holiday — and
    percentile-ranking against forty names produces ratings that look exactly
    like real ones.
    """
    out = {'name': 'polygon:grouped-daily (RS universe)', 'ok': False,
           'severity': 'down'}
    t0 = time.time()
    try:
        from chart import relstrength
        days = relstrength.cached_days()
        out['cached_sessions'] = len(days)
        if not days:
            out['detail'] = ('no grouped-daily sessions cached — the RS rating, '
                             'group ranks and rank-in-group all depend on this')
            return out
        px, _dv = relstrength.closes(sessions=3)
        out['symbols'] = int(px.shape[1]) if len(px) else 0
        out['as_of'] = str(px.index[-1]) if len(px) else None
        if out['symbols'] < 1000:
            out['detail'] = (f'only {out["symbols"]} symbols in the universe — '
                             f'a percentile against this is not a market rating')
            return out
        if len(days) < 253:
            out['severity'] = 'degraded'
            out['detail'] = (f'{len(days)} sessions cached; the RS formula needs '
                             f'253 for a full twelve months')
            return out
        out['ok'] = True
        out['severity'] = 'ok'
        out['detail'] = f'{out["symbols"]:,} symbols, {len(days)} sessions cached'
        return out
    except Exception as e:                                # noqa: BLE001
        out['detail'] = str(e)[:200]
        return out
    finally:
        out['ms'] = int((time.time() - t0) * 1000)


def run_all(symbol: str = 'SPY') -> dict:
    """Every source, judged. Never raises — a health check that can fail is not
    one."""
    from chart import data_manager, groups as gmod, oneil
    started = time.time()
    checks = []

    frames = {}
    for feed in sorted(data_manager.LOADERS):
        c = check_feed(feed, symbol)
        checks.append(c)
        if c.get('ok'):
            try:
                frames[feed] = data_manager.load_bars(symbol, '1d', 40, feed)
            except Exception:                             # noqa: BLE001
                pass

    # THE INDEXES ARE NOT OPTIONAL. The market model runs on exactly these two
    # and nothing else, so their absence is a specific failure with a specific
    # consequence, not one more feed being unavailable.
    for sym in oneil.INDEXES:
        c = check_feed('yahoo', sym)
        c['name'] = f'index {sym} ({oneil.INDEXES[sym]})'
        if not c.get('ok'):
            c['detail'] += " — O'Neil's market model cannot be built without it"
        checks.append(c)

    # Cross-source agreement, which is the only check that can catch a feed
    # that is confidently wrong.
    names = [f for f in ('yahoo', 'polygon', 'alpaca') if f in frames]
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            checks.append(judge_agreement(frames[names[i]], frames[names[j]],
                                          name_a=names[i], name_b=names[j]))

    checks.append(check_universe())

    checks.append(judge_file(oneil.SHARED, label="O'Neil market model",
                             require=('status', 'indexes')))
    checks.append(judge_file(gmod.SHARED, label='group ranks',
                             max_age_hours=36, require=('groups',)))
    checks.append(judge_file(gmod.MAP_FILE, label='industry map',
                             max_age_hours=24 * 14, require=('symbols',)))

    # COUNTED BY SEVERITY, not by `ok`. A degraded check is usable — so `ok` is
    # true — and it still needs to appear in the count and in the summary, or
    # the one state worth investigating is the one that is invisible.
    down = [c for c in checks if c.get('severity') == 'down']
    degraded = [c for c in checks if c.get('severity') == 'degraded']
    bad = down + degraded
    return {
        'ok': not down,
        'checked_at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds'),
        'ms': int((time.time() - started) * 1000),
        'total': len(checks),
        'passed': len(checks) - len(bad),
        'degraded': len(degraded),
        'down': len(down),
        'checks': checks,
        # The headline, in words, because a count of failures does not say
        # which thing has stopped working.
        'summary': ('every source returned usable data' if not bad else
                    '; '.join(f"{c['name']}: {c.get('detail')}" for c in bad[:6])),
    }
