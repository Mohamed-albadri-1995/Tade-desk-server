"""
Relative Strength, as O'Neil defines it — and not as RSI defines it.

WHAT THIS IS, AND WHAT IT IS NOT.

IBD publishes a number called the RS Rating: a percentile from 1 to 99 saying
how a stock's price performance over the last twelve months compares with every
other stock's. 99 means it outperformed 99% of the market. It is one of the two
numbers O'Neil's "L — Leader or Laggard" actually rests on.

It has NOTHING to do with RSI. RSI is a bounded oscillator measuring one stock
against its own recent range; it says nothing about any other stock. Two names
can both print RSI 70 while one is the strongest stock in the market and the
other is a laggard bouncing inside a downtrend. Conflating them is the single
most common way this framework gets implemented wrong, so they are kept in
different modules with different names on purpose.

THIS IS A RECONSTRUCTION, NOT IBD'S NUMBER, and every caller has to be able to
tell. IBD's RS Rating is a commercial product: there is no feed to buy, no
endpoint to call, and the exact universe they rank against is not published. So
what follows is built from O'Neil's own published description — twelve months
of price performance, with the most recent quarter counted double — and is
exposed under the name `rs_rating`, never as "IBD RS". A number that looked
like IBD's and was not would be worse than no number at all.

THE FORMULA, and where each part comes from:

    RS = 0.4·(P0/P63) + 0.2·(P0/P126) + 0.2·(P0/P189) + 0.2·(P0/P252)

P0 is the latest close and P63 the close 63 trading days back — one quarter.
Four quarters, and the most recent one carries twice the weight of each of the
others, which is what "the most recent quarter counted double" means when the
four weights have to sum to 1. The raw score is then percentile-ranked across
the universe and scaled to 1..99.

ADJUSTED PRICES ARE NOT OPTIONAL HERE. A 2-for-1 split halves the raw close,
and a twelve-month performance measure reading raw prices would score that
stock at -50% and rate it 1 — the strongest names in a bull market are exactly
the ones that split. The intraday loader in tools/data/polygon.py deliberately
uses adjusted=false, because you trade the prices that actually printed. This
module deliberately uses adjusted=true, because it measures performance. The
two are both right and must not be made consistent.

ONE API CALL PER TRADING DAY. A true percentile needs the whole market, and
the whole market one symbol at a time is impossible on a 5-request/minute free
tier — eight thousand names would take a day and a half. Polygon's GROUPED
daily endpoint returns every US ticker for one session in a single response, so
a year of history is ~250 calls once, and one call a day forever after.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

_BASE = 'https://api.polygon.io'
_CACHE = Path.home() / '.qp-cache' / 'grouped'

# Trading days per quarter. 63 is the conventional figure (252 / 4) and the one
# the published formula is stated in; using calendar quarters instead would make
# the lookback drift with holidays.
_Q = 63
_YEAR = 4 * _Q                                   # 252 trading days

"""How the four quarters are weighted. Sums to 1.0 by construction — a set that
did not would silently rescale every score."""
WEIGHTS = ((_Q, 0.4), (2 * _Q, 0.2), (3 * _Q, 0.2), (4 * _Q, 0.2))

# ── the universe gate ──────────────────────────────────────────────────────
# O'Neil ranks the tradeable market, not every listed line. Without a floor the
# percentile is set by thousands of sub-dollar shells whose 12-month "return" is
# a rounding artefact, and every real stock is pushed into the same narrow band.
MIN_PRICE = 5.0                 # below this the spread eats any edge
MIN_DOLLAR_VOL = 1_000_000.0    # median daily $ volume over the last quarter


def _api_key() -> str:
    key = os.environ.get('POLYGON_API_KEY')
    if not key:
        raise RuntimeError('POLYGON_API_KEY must be set to build the RS universe')
    return key


class NotYetPublished(RuntimeError):
    """Polygon has this session but will not serve it yet.

    On the free tier, asking for TODAY before the close returns

        403 {"status":"NOT_AUTHORIZED", "message":"Attempted to request
             today's data before end of day..."}

    which is not an authorisation problem and not a missing session — it is
    "come back later". It needs its own type because the two right responses
    are opposite: a walk over history must SKIP this day and carry on, and it
    must never be cached, because tomorrow the same date has real data in it.

    Found the hard way: backfill() started at today, hit this on its very first
    request, and the whole 252-session walk died on it.
    """


def _get(url: str, tries: int = 4) -> dict:
    """GET with a backoff for the free tier's 5 req/min limit (HTTP 429)."""
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < tries - 1:
                time.sleep(2 ** attempt * 5)
                continue
            body = e.read().decode()[:300]
            if e.code == 403 and 'before end of day' in body:
                raise NotYetPublished(body) from e
            raise RuntimeError(f'Polygon {e.code}: {body[:200]}') from e
    raise RuntimeError('Polygon: exhausted retries')


def _day_path(day: str) -> Path:
    _CACHE.mkdir(parents=True, exist_ok=True)
    return _CACHE / f'{day}.parquet'


def fetch_day(day: str, force: bool = False) -> pd.DataFrame:
    """Every US ticker's daily bar for one session, in ONE request.

    Columns [symbol, close, volume, dollar_vol]. Empty frame for a market
    holiday — Polygon answers 200 with no results, which is not an error and
    must not be cached as one.

    ADJUSTED. See the module docstring: this measures performance, so a split
    must not read as a 50% loss.
    """
    p = _day_path(day)
    if p.exists() and not force:
        return pd.read_parquet(p)

    url = (f'{_BASE}/v2/aggs/grouped/locale/us/market/stocks/{day}'
           f'?adjusted=true&apiKey={_api_key()}')
    payload = _get(url)
    rows = payload.get('results') or []

    if not rows:
        df = pd.DataFrame(columns=['symbol', 'close', 'volume', 'dollar_vol'])
        # AN EMPTY DAY IS ONLY CACHED ONCE THE CALENDAR HAS SETTLED.
        #
        # A holiday is a permanent fact and caching it saves a request forever.
        # A session that simply has not been published yet is NOT — and the
        # first version of this cached both, so a day fetched a few hours early
        # would be recorded as a holiday and never asked for again. The RS
        # universe would then have a hole in it that nothing could refill, and
        # nothing anywhere would say so.
        #
        # Two days is comfortably past any publishing delay and still far
        # inside the walk, so a real backfill caches every holiday it meets.
        settled = (_dt.date.today() - _dt.date.fromisoformat(day)).days >= 2
        if settled:
            df.to_parquet(p)
        return df

    df = pd.DataFrame(rows)
    df = df.rename(columns={'T': 'symbol', 'c': 'close', 'v': 'volume'})
    df = df[['symbol', 'close', 'volume']].copy()
    df['close'] = df['close'].astype(float)
    df['volume'] = df['volume'].astype(float)
    df['dollar_vol'] = df['close'] * df['volume']
    # One row per symbol. Polygon has been seen to repeat a ticker across
    # venues; a duplicate would become two rows in the wide frame and one of
    # them would win arbitrarily.
    df = df.drop_duplicates('symbol', keep='last').reset_index(drop=True)
    df.to_parquet(p)
    return df


def cached_days() -> list[str]:
    """Sessions already on disk, oldest first. Empty ones included — they are
    a fact about the calendar, not a gap."""
    if not _CACHE.exists():
        return []
    return sorted(p.stem for p in _CACHE.glob('*.parquet'))


def backfill(end: str | None = None, sessions: int = _YEAR + 10,
             sleep_s: float = 13.0, log=print) -> dict:
    """Walk backwards from `end` until `sessions` NON-EMPTY days are on disk.

    Counted in non-empty days rather than calendar days because weekends and
    holidays carry no bars: asking for 252 calendar days would return about 180
    sessions and every RS score would silently be a nine-month score.

    `sleep_s` defaults to just over 12s — five requests a minute is the free
    tier's limit and this stays under it rather than relying on the 429 retry,
    which costs 35 seconds each time it fires.
    """
    # YESTERDAY, NOT TODAY. On the free tier Polygon refuses today's session
    # before the close with a 403, and the first version of this started at
    # today and died on its own first request. Even with NotYetPublished
    # handled below, starting here spends no call learning what the calendar
    # already says.
    end_ts = (pd.Timestamp(end) if end
              else pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=1))
    have = set(cached_days())
    got = 0
    fetched = 0
    skipped = 0
    day = end_ts
    # A generous walk-back bound: 252 sessions is ~366 calendar days, and a
    # bound stops a bad key turning into an unbounded loop over history.
    limit = int(sessions * 1.8) + 30
    for _ in range(limit):
        d = day.strftime('%Y-%m-%d')
        if d in have:
            if len(_read_day(d)):
                got += 1
        elif day.weekday() < 5:                  # never spend a call on a weekend
            try:
                df = fetch_day(d)
            except NotYetPublished:
                # Not an error and not a missing session: this day exists and
                # will be served later. SKIP IT AND CARRY ON — dying here is
                # what killed the first run, on its very first request.
                log(f'  {d}  not published yet — skipping')
                skipped += 1
                day -= pd.Timedelta(days=1)
                continue
            fetched += 1
            if len(df):
                got += 1
            log(f'  {d}  {len(df):>5} tickers')
            if fetched:
                time.sleep(sleep_s)
        day -= pd.Timedelta(days=1)
        if got >= sessions:
            break
    return {'sessions': got, 'fetched': fetched, 'not_yet_published': skipped,
            'cached': len(cached_days())}


def top_up(max_days: int = 3, sleep_s: float = 13.0) -> dict:
    """Fetch the few recent sessions that are missing. BOUNDED, on purpose.

    WHY THIS EXISTS. backfill() is a one-off bootstrap that takes the better
    part of an hour — 252 sessions at five requests a minute. After it, the
    universe goes stale by one session a day, and "somebody remembers to re-run
    it" is not a mechanism.

    So this tops up whatever is missing at the recent end, called from the
    group build, which already runs at most twice a day behind its own TTL.

    THE BOUND IS THE WHOLE DESIGN. `max_days` caps it at a handful of requests
    so a call can never become the 57-minute one: on a box that has never been
    backfilled this fetches three days and stops, leaving the honest "not
    enough history" answer rather than hanging a page for an hour. Catching up
    from empty is backfill()'s job and it says so.
    """
    out = {'fetched': 0, 'skipped': 0, 'cached': len(cached_days())}
    try:
        have = set(cached_days())
        day = pd.Timestamp.utcnow().normalize()
        # Yesterday, not today: the grouped-daily endpoint has nothing for a
        # session that has not closed, and spending a request to learn that
        # every time this runs is a request wasted.
        day -= pd.Timedelta(days=1)
        for _ in range(max_days * 3):            # room to walk over weekends
            if out['fetched'] >= max_days:
                break
            d = day.strftime('%Y-%m-%d')
            if day.weekday() < 5 and d not in have:
                try:
                    df = fetch_day(d)
                    out['fetched'] += 1
                    if not len(df):
                        out['skipped'] += 1      # a holiday, and now cached as one
                    time.sleep(sleep_s)
                except NotYetPublished:
                    # This session exists and is not served yet. Walk past it;
                    # tomorrow's run picks it up.
                    out['not_yet_published'] = out.get('not_yet_published', 0) + 1
                except Exception as e:           # noqa: BLE001
                    # Never the reason a page fails: the caller falls back to
                    # whatever history is already on disk.
                    out['error'] = str(e)[:160]
                    break
            day -= pd.Timedelta(days=1)
        out['cached'] = len(cached_days())
    except Exception as e:                       # noqa: BLE001
        out['error'] = str(e)[:160]
    return out


def _read_day(day: str) -> pd.DataFrame:
    p = _day_path(day)
    if not p.exists():
        return pd.DataFrame(columns=['symbol', 'close', 'volume', 'dollar_vol'])
    return pd.read_parquet(p)


def closes(asof: str | None = None, sessions: int = _YEAR + 1):
    """A wide close-price frame — rows are sessions, columns are symbols.

    Returns (closes, dollar_volume) as two aligned frames, newest row LAST.
    Only sessions at or before `asof` are used, so a historical rating can be
    reproduced exactly rather than re-derived from today's universe.
    """
    days = [d for d in cached_days() if (asof is None or d <= asof)]
    frames = []
    for d in reversed(days):                     # newest first while collecting
        df = _read_day(d)
        if not len(df):
            continue
        frames.append((d, df))
        if len(frames) >= sessions:
            break
    if not frames:
        return pd.DataFrame(), pd.DataFrame()
    frames.reverse()                             # back to oldest-first

    px = pd.DataFrame({d: df.set_index('symbol')['close'] for d, df in frames}).T
    dv = pd.DataFrame({d: df.set_index('symbol')['dollar_vol'] for d, df in frames}).T
    px.index.name = dv.index.name = 'date'
    return px.sort_index(), dv.sort_index()


def raw_scores(px: pd.DataFrame, dv: pd.DataFrame | None = None) -> pd.Series:
    """O'Neil's weighted twelve-month performance, per symbol. Not yet a rating.

    A symbol without a full 252 sessions of history scores NaN rather than a
    partial number. An eight-month-old IPO up 300% would otherwise outrank every
    established leader on a measure that is defined as twelve months long.
    """
    if len(px) < _YEAR + 1:
        raise ValueError(f'need {_YEAR + 1} sessions of history, have {len(px)}')

    latest = px.iloc[-1]
    score = pd.Series(0.0, index=px.columns, dtype=float)
    ok = latest.notna() & (latest > 0)

    for back, w in WEIGHTS:
        past = px.iloc[-1 - back]
        good = past.notna() & (past > 0)
        ok &= good
        # Ratio, not percent change: the published formula is stated as
        # P0/Pn, and the two differ by a constant that the percentile would
        # remove anyway — but only if every term used the same one.
        score = score.add((latest / past).where(good), fill_value=0.0)
        score = score.mask(~good)
        score = score.astype(float)

    # Re-derive cleanly rather than accumulating in the loop, so a NaN in any
    # one quarter disqualifies the symbol instead of contributing a zero.
    out = pd.Series(np.nan, index=px.columns, dtype=float)
    valid = latest.notna() & (latest > 0)
    total = pd.Series(0.0, index=px.columns, dtype=float)
    for back, w in WEIGHTS:
        past = px.iloc[-1 - back]
        valid &= past.notna() & (past > 0)
        total += w * (latest / past.replace(0, np.nan))
    out[valid] = total[valid]

    # ── the tradeable gate ────────────────────────────────────────────────
    if dv is not None and len(dv):
        med = dv.iloc[-_Q:].median()
        out[latest < MIN_PRICE] = np.nan
        out[med.reindex(out.index).fillna(0) < MIN_DOLLAR_VOL] = np.nan
    return out


def rs_rating(asof: str | None = None) -> pd.Series:
    """The rating itself: 1..99, one per symbol, NaN for anything unrateable.

    PERCENTILE, NOT A SCALED SCORE. A rating of 80 has to mean "beat 80% of the
    market", which is a rank. Min-max scaling the raw score instead would let
    one parabolic name compress everything else into the bottom decile, and the
    number would stop meaning what its name says.

    Ties share a rating, and the scale is 1..99 rather than 0..100 because both
    ends are real stocks — nothing is outside the market it is measured against.
    """
    px, dv = closes(asof)
    if px.empty:
        return pd.Series(dtype=float)
    raw = raw_scores(px, dv)
    rated = raw.dropna()
    if rated.empty:
        return pd.Series(dtype=float)
    pct = rated.rank(pct=True, method='average')
    return (1 + (pct * 98).round()).clip(1, 99).astype(int).reindex(raw.index)


def group_strength(rs: pd.Series, groups: dict) -> pd.DataFrame:
    """The second half of the funnel: rank the GROUPS, then the stocks in them.

    O'Neil's method is top-down — judge the market, then the groups inside it,
    then take the leaders of the leading groups. A stock's own rating is only
    half the question; the other half is whether its neighbours are rising too.

    `groups` maps symbol -> group name (your register's sector, not IBD's 197
    proprietary industries — a different taxonomy, and it says so).

    Scored on the MEDIAN member rating, not the mean: one 99 in a group of
    laggards is a single stock's story, and a mean lets it carry the whole
    group. The median asks whether the group is broadly strong, which is the
    thing the funnel is actually looking for.
    """
    rows = []
    by = {}
    for sym, g in (groups or {}).items():
        if sym in rs.index and pd.notna(rs.get(sym)):
            by.setdefault(g, []).append(float(rs[sym]))
    for g, vals in by.items():
        s = pd.Series(vals)
        rows.append({'group': g, 'members': len(vals),
                     'median_rs': float(s.median()),
                     'top_rs': float(s.max()),
                     # How much of the group is genuinely strong, which
                     # separates a broad advance from one runaway name.
                     'share_over_80': float((s >= 80).mean())})
    if not rows:
        return pd.DataFrame(columns=['group', 'members', 'median_rs',
                                     'top_rs', 'share_over_80', 'group_rank'])
    out = pd.DataFrame(rows).sort_values('median_rs', ascending=False)
    out['group_rank'] = range(1, len(out) + 1)
    return out.reset_index(drop=True)

