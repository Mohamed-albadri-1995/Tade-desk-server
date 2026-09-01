"""O'Neil's market model — the M in CAN SLIM, as a state machine.

WHY THIS FILE EXISTS.

`src/sideD/regime.js` scores same-day and one-week index moves into
BULLISH / NEUTRAL / BEARISH. That is a short-term momentum blend and it is
useful, but it is NOT O'Neil's market model and must never be shown as one.
O'Neil's whole claim about M is that it is **mechanical**: a state machine over
two indexes, driven by two events that are each defined to the decimal place.

He found that **three out of four stocks follow the general market direction**,
and called M the letter most investors ignore. Everything else on a card is
about one company; this is the one that decides whether to be buying at all.

THE MODEL, IN ONE PARAGRAPH. Institutions cannot buy or sell a position in a
day, so their selling leaves a footprint: an index closing DOWN on volume
HIGHER than the session before. One of those is noise. Five inside 25 sessions
is a pattern, and the pattern precedes tops. Coming the other way, a market
that has fallen tries to rally constantly and most attempts fail, so O'Neil
refuses to call a bottom until the attempt is four or more days old AND puts in
a big gain on heavy volume — the follow-through day.

EVERY THRESHOLD HERE IS O'NEIL'S, NOT OURS. Where he changed his mind the last
value he published is the one used, and the provenance travels with the number
into the JSON so the page can print it beside any signal that fires. See
THRESHOLDS below. A claim about the market whose definition is invisible cannot
be checked against a chart afterwards, and this model exists to be checked.

WHAT THIS IS NOT. It is not a reproduction of IBD's Market Pulse — that is a
commercial product and the exact break-to-correction rule is not fully
published. This is a reconstruction from O'Neil's own published descriptions,
named as one, with the one genuinely fuzzy edge (§ _to_correction) marked in
the code and in the output.

PURE BY DESIGN. `market_model()` takes DataFrames and returns a dict. Nothing
in the model fetches; `build()` is the only thing that touches the network. The
audit hands it hand-built bars with known answers, which is the only way to
test a state machine whose input is "what the market did".
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# THRESHOLDS — every one is O'Neil's or IBD's published figure. The provenance
# string travels into the JSON and onto the page: a follow-through day is a
# claim about the market, and a claim whose definition is invisible cannot be
# checked against a chart afterwards.
# ---------------------------------------------------------------------------
THRESHOLDS = {
    'dd_drop_pct': {
        'value': 0.002,
        'label': '−0.2%',
        'why': ('a session closing down 0.2% or more counts; smaller is drift. '
                'NOTE THE TWO FORMS, and they do not conflict: the workshop '
                'states it plainly as "closes LOWER than the prior session on '
                'higher volume", with no percentage. 0.2% is IBD\'s '
                'operational floor on that same rule — without it roughly a '
                'quarter of all sessions qualify and the 5-6 cluster fires '
                'constantly. Configurable; set it to 0 for the plain form.'),
        'source': "IBD's published floor on O'Neil's plain rule",
    },
    'dd_window': {
        'value': 25,
        'label': '25 sessions',
        'why': ('the rolling window a distribution day stays live in. The '
                'workshop states the cluster as 5-6 days within 5-6 WEEKS, '
                'which is 25-30 sessions; 25 is the tight end of his own '
                'range and IBD\'s published figure, so it is the default.'),
        'source': "IBD 25 sessions; O'Neil's workshop 5-6 weeks",
    },
    'dd_recovery_pct': {
        'value': 0.05,
        'label': '5%, intraday',
        'why': ('a distribution day is removed once the index TRADES 5% above '
                'that day’s close — on the high, not the close'),
        'source': 'IBD',
    },
    'ftd_gain_pct': {
        'value': 0.017,
        'label': '+1.7%',
        'why': ('the gain a follow-through day must show. He published 1% in '
                'the early editions, 1.5% in How to Make Money in Stocks, then '
                '1.7% once program trading made 1% days ordinary'),
        'source': "O'Neil, The Successful Investor — his last published figure",
    },
    'ftd_day_min': {
        'value': 4,
        'label': 'day 4',
        'why': ('the earliest a follow-through can occur. Days 1, 2 and '
                'normally 3 are ignored ENTIRELY — early bounces off a bottom '
                'fail often enough that the wait IS the filter. Day 1 is the '
                'session immediately after the lowest CLOSE of the '
                'correction, up or down; see the anchor note in index_pass.'),
        'source': "O'Neil's workshop, January 2010",
    },
    'ftd_day_max': {
        'value': 7,
        'label': 'day 7',
        'why': 'the expected far end of the window',
        'source': "O'Neil",
    },
    'ftd_day_late': {
        'value': 11,
        'label': 'day 11',
        'why': ('past this the follow-through is FLAGGED "very late" and still '
                'counted. Not refused: a rally attempt that could never be '
                'confirmed would be a state the market cannot leave, and it '
                'would sit in correction through an entire advance'),
        'source': "O'Neil — occasionally as late as day 10 or 11",
    },
    'ftd_anchor': {
        'value': 'the lowest CLOSE of the correction',
        'label': 'lowest closing low',
        'why': ('what the day count runs from. "Absolute market bottom" never '
                'means zero — an index cannot reach zero — it means the lowest '
                'local CLOSING price of this correction cycle, and Day 1 is '
                'the trading session immediately following it. A new lower '
                'close IS a new bottom, so the anchor moves there and the '
                'count restarts. An earlier version counted from the first UP '
                'close and reset on the intraday LOW, which is a different '
                'bar: a wick through the low that closed above it restarted a '
                'count the market had not broken.'),
        'source': "O'Neil's workshop, January 2010",
    },
    'ftd_volume': {
        'value': 'above the prior session',
        'label': 'volume > prior session',
        'why': ('the ONLY volume test. An earlier version of this model also '
                'required volume above the index\'s own 50-day average, and '
                'that was an invention: it is a stricter variant some people '
                'apply, not the published rule. On the first live run it '
                'blocked the Nasdaq\'s August follow-through and left the '
                'model calling a correction on day 23 of a rally the S&P had '
                'already confirmed. The 50-day comparison is still REPORTED '
                'beside every follow-through — it just does not decide one'),
        'source': 'IBD: "in higher volume than the previous session"',
    },
    'stall_max_gain': {
        'value': 0.002,
        'label': '+0.2%',
        'why': ('a stalling day makes almost no upward progress on heavy '
                'volume and closes in the lower half of its range — selling '
                'absorbed, which is what heavy volume with no progress means'),
        'source': 'IBD',
    },
    'correction_dd_count': {
        'value': 6,
        'label': '6 live',
        'why': ('the count at which the uptrend is treated as broken. The '
                'workshop: "it took 3 or 4 days historically, modern markets '
                'require 5 to 6 clustered in 5-6 weeks", and ONE major index '
                'reaching it is enough — which is why the status here is the '
                'worse of the S&P 500 and the Nasdaq rather than a blend.'),
        'source': "O'Neil's workshop and IBD both give 5-6",
    },
    'pressure_dd_count': {
        'value': 5,
        'label': '5 live',
        'why': 'the count at which the uptrend is under pressure',
        'source': 'IBD',
    },
}


def _t(key: str):
    return THRESHOLDS[key]['value']


# The two indexes O'Neil tracks. COUNTED SEPARATELY, NEVER POOLED: they diverge
# often, and the divergence is information — it says which half of the market is
# being sold. Pooling would both double-count a day the two shared and hide that.
INDEXES = {
    '^GSPC': 'S&P 500',
    '^IXIC': 'Nasdaq Composite',
}

STATUS_LABEL = {
    'confirmed_uptrend': 'Confirmed uptrend',
    'uptrend_under_pressure': 'Uptrend under pressure',
    'market_in_correction': 'Market in correction',
}

# THE INTERNAL STATE AND THE PUBLISHED STATUS ARE NOT THE SAME THING, and
# conflating them was a real bug found by the audit.
#
# IBD publishes exactly THREE labels. A rally attempt is not a fourth: it is
# something that happens INSIDE "Market in correction" — the market has fallen,
# it is trying to bounce, and until a follow-through day confirms that bounce
# the correction is still on. Publishing "rally attempt" as its own status
# would read as an improvement on a correction, which is exactly backwards: a
# rally attempt IS a correction, plus hope.
#
# The machine still tracks it internally, because the day count is what the
# follow-through rule is measured against. It is reported as detail beside the
# status, never as the status.
_PUBLISHED = {
    'confirmed_uptrend': 'confirmed_uptrend',
    'uptrend_under_pressure': 'uptrend_under_pressure',
    'rally_attempt': 'market_in_correction',
    'correction': 'market_in_correction',
}

# Worst-first. The published status is driven by the WORSE of the two indexes:
# being right about the S&P while the Nasdaq is under distribution is how a
# growth book gets taken apart.
_SEVERITY = ['confirmed_uptrend', 'uptrend_under_pressure', 'market_in_correction']

FTD_CAVEAT = ('Roughly one in four follow-through days fails. It is a '
              'NECESSARY condition for a major bottom, not a sufficient one — '
              'no major bottom has occurred without one, and not every one '
              'works. This is not permission to size up.')

MODEL_NOTE = ("A reconstruction from O'Neil's published descriptions, not "
              "IBD's Market Pulse, which is a commercial product. The "
              "distribution and follow-through rules are his to the decimal; "
              "the exact point at which IBD calls a correction is not fully "
              "published and is reconstructed here as 6 live distribution "
              "days or a decisive undercut of the rally low.")


# ---------------------------------------------------------------------------
# The forward pass
# ---------------------------------------------------------------------------

def _prep(df: pd.DataFrame) -> pd.DataFrame:
    """Daily bars → the columns the pass needs. Never mutates the caller's."""
    out = df.copy()
    out.columns = [str(c).lower() for c in out.columns]
    for col in ('open', 'high', 'low', 'close', 'volume'):
        if col not in out.columns:
            raise ValueError(f'daily bars need a {col!r} column, got {list(out.columns)}')
    out['ret'] = out['close'].pct_change()
    out['vol_prev'] = out['volume'].shift(1)
    # Rolling averages, min_periods so a short frame still produces numbers
    # rather than a wall of NaN that silently disables every volume test.
    out['vol50'] = out['volume'].rolling(50, min_periods=10).mean()
    out['vol25'] = out['volume'].rolling(25, min_periods=5).mean()
    out['sma50'] = out['close'].rolling(50, min_periods=10).mean()
    return out


def _is_distribution(row) -> bool:
    """A down day on higher volume. The plain form."""
    return (row['ret'] is not None
            and row['ret'] <= -_t('dd_drop_pct')
            and row['volume'] > row['vol_prev'])


def _is_stalling(row) -> bool:
    """The form of distribution that is NOT a down day.

    Heavy volume, almost no upward progress, closing in the lower half of the
    range. The logic is identical to a down day — institutions selling into
    strength — and the price does not fall because the selling is being
    ABSORBED, which is exactly what heavy volume with no progress means.

    This is the shape that shows up at tops, where an index grinds sideways on
    huge volume for a fortnight before it breaks. A count that only looks for
    −0.2% closes misses it entirely.
    """
    rng = row['high'] - row['low']
    if rng <= 0:
        return False
    heavy = row['volume'] > row['vol_prev'] or (
        row['vol25'] == row['vol25'] and row['volume'] > row['vol25'])
    in_lower_half = (row['close'] - row['low']) / rng < 0.5
    little_progress = 0 <= row['ret'] < _t('stall_max_gain')
    return bool(heavy and in_lower_half and little_progress)


def index_pass(df: pd.DataFrame, name: str = '') -> dict:
    """Walk one index forward and return its state, its live distribution days
    and every event on the way.

    ONE FORWARD PASS, because the rules are circular in any other order: a
    distribution day only counts inside a confirmed uptrend, the uptrend only
    exists after a follow-through day, and the follow-through only exists
    inside a rally attempt that began at a correction low. There is no way to
    compute any of them independently and no way to compute today's count from
    today's bar.

    THE UPTREND CONDITION ON DISTRIBUTION IS WIDELY DROPPED AND MATTERS. During
    a correction there is no established uptrend to distribute FROM, so heavy
    down days are not added. A count that ignores this runs up through every
    correction and then reads "extremely dangerous" on the day the bottom
    forms — precisely inverted, on the one day it decides something.
    """
    d = _prep(df)
    n = len(d)
    idx = d.index

    state = 'correction'          # conservative seed: nothing is confirmed yet
    # THE ANCHOR IS A CLOSING PRICE, not an intraday low. O'Neil's "absolute
    # market bottom" is the lowest CLOSE of the correction cycle, and the day
    # count runs from the session immediately after it.
    anchor_close = float(d['close'].iloc[0]) if n else float('nan')
    anchor_date = idx[0] if n else None
    uptrend_from = anchor_close   # the close the current uptrend was confirmed off
    rally_day = 0
    ftd = None
    live: list[dict] = []         # distribution days still counting
    events: list[dict] = []

    for i in range(1, n):
        row = d.iloc[i]
        when = idx[i]

        # ---- expiry first, so today's count reflects today's bar ----------
        # TWO REMOVAL RULES and a day leaves when EITHER fires.
        still = []
        for dd in live:
            aged = (i - dd['_i']) >= _t('dd_window')
            # INTRADAY, on the high: the rule is that the index TRADES 5% above
            # the distribution day's close, not that it closes there. Using the
            # close is a stricter rule than IBD's and would hold days in the
            # count they had already dropped — the market would read more
            # dangerous than it is, on exactly the days a new uptrend starts.
            recovered = row['high'] >= dd['close'] * (1 + _t('dd_recovery_pct'))
            if aged:
                dd['removed'] = 'aged out of the 25-session window'
            elif recovered:
                dd['removed'] = f"index traded 5% above its {dd['close']:.2f} close"
            else:
                still.append(dd)
                continue
            dd['removed_on'] = str(when.date() if hasattr(when, 'date') else when)
        live = still

        if state in ('confirmed_uptrend', 'uptrend_under_pressure'):
            kind = None
            if _is_distribution(row):
                kind = 'distribution'
            elif _is_stalling(row):
                kind = 'stalling'
            if kind:
                dd = {
                    '_i': i,
                    'date': str(when.date() if hasattr(when, 'date') else when),
                    'index': name,
                    'kind': kind,
                    'pct': round(float(row['ret']) * 100, 2),
                    'vol_ratio': (round(float(row['volume'] / row['vol_prev']), 2)
                                  if row['vol_prev'] else None),
                    'close': float(row['close']),
                }
                live.append(dd)
                events.append({'type': kind, **{k: v for k, v in dd.items()
                                                if not k.startswith('_')}})

            # ---- does the uptrend break? --------------------------------
            # THE FUZZY EDGE, MARKED AS SUCH. IBD does not fully publish the
            # rule that flips the Pulse to "Market in correction"; what is
            # published is the band — 5 to 6+ live days in 25 sessions — plus a
            # break of the 50-day average on heavy volume. Reconstructed as the
            # count reaching 6, or a decisive undercut of the rally low, which
            # is O'Neil's own "the uptrend has broken" and is not fuzzy at all.
            # THE UPTREND BREAKS ON A CLOSE BELOW THE LOW IT STARTED FROM,
            # and that low is a CLOSE too. Comparing a close against an
            # intraday low mixes two different bars and fires on days the
            # market never actually closed through.
            broke_low = uptrend_from == uptrend_from and row['close'] < uptrend_from
            if len(live) >= _t('correction_dd_count') or broke_low:
                events.append({
                    'type': 'correction',
                    'date': str(when.date() if hasattr(when, 'date') else when),
                    'index': name,
                    'why': ('the rally low was undercut' if broke_low
                            else f'{len(live)} distribution days live'),
                })
                state = 'correction'
                anchor_close = float(row['close'])
                anchor_date = when
                rally_day = 0
                live = []          # the count restarts with the next uptrend
            else:
                state = ('uptrend_under_pressure'
                         if len(live) >= _t('pressure_dd_count')
                         else 'confirmed_uptrend')

        elif state == 'correction':
            # THE ANCHOR IS THE LOWEST CLOSING PRICE OF THE CORRECTION, and
            # the count is simply the sessions since it. Corrected from the
            # workshop: this model counted day 1 as "the first UP close after
            # the low", which is a different anchor and a different number.
            #
            # O'Neil's own framing: the absolute market bottom is the lowest
            # CLOSING price of the correction cycle, and Day 1 is the trading
            # session immediately following it — whether that session is up or
            # not. "Absolute bottom" never means zero; it means the lowest
            # local close before the recovery.
            #
            # THE RESET IS THE SAME FACT, NOT A SECOND RULE. A new lower close
            # IS a new bottom, so the anchor moves and the count starts again
            # from there. The old version reset on the intraday LOW being
            # undercut, which is a different bar and fires on days the close
            # never confirmed — a wick through the low restarted a count the
            # market had not actually broken.
            if row['close'] < anchor_close:
                anchor_close = float(row['close'])
                anchor_date = when
                if rally_day:
                    # Recorded, never silent: a count that restarted is the
                    # single most confusing thing this model can do to somebody
                    # reading the day number off the page.
                    events.append({
                        'type': 'anchor_moved',
                        'date': str(when.date() if hasattr(when, 'date') else when),
                        'index': name,
                        'why': ('a new lower CLOSE — the bottom moved here, so '
                                f'the count restarts (was day {rally_day})'),
                    })
                rally_day = 0
            else:
                # Day 1 is the session after the lowest close. Days 1-3 are
                # ignored entirely: early bounces off a bottom fail often
                # enough that the wait IS the filter.
                rally_day += 1
                vol50 = row['vol50']
                big_enough = row['ret'] >= _t('ftd_gain_pct')
                over_prior = row['volume'] > row['vol_prev']
                # Measured and reported, never a gate. Requiring it as well was
                # an invention that cost a wrong answer on the first live run —
                # see THRESHOLDS['ftd_volume'].
                over_avg = bool(vol50 == vol50 and row['volume'] > vol50)
                if rally_day >= _t('ftd_day_min') and big_enough and over_prior:
                    ftd = {
                        '_i': i,
                        'date': str(when.date() if hasattr(when, 'date') else when),
                        'index': name,
                        'day': rally_day,
                        'from_low': str(anchor_date.date()
                                        if hasattr(anchor_date, 'date') else anchor_date),
                        'gain_pct': round(float(row['ret']) * 100, 2),
                        'vol_ratio': (round(float(row['volume'] / row['vol_prev']), 2)
                                      if row['vol_prev'] else None),
                        'vol_above_50d': over_avg,
                        'timing': ('on time' if rally_day <= _t('ftd_day_max')
                                   else 'late' if rally_day <= _t('ftd_day_late')
                                   else 'very late'),
                    }
                    events.append({'type': 'follow_through',
                                   **{k: v for k, v in ftd.items()
                                      if not k.startswith('_')}})
                    state = 'confirmed_uptrend'
                    live = []      # a new uptrend starts with a clean count
                    uptrend_from = anchor_close
                    rally_day = 0

    for dd in live:
        dd['expires_after'] = _t('dd_window') - (n - 1 - dd['_i'])

    return {
        'index': name,
        'state': state,                    # internal, includes rally_attempt
        'published': _PUBLISHED[state],    # one of IBD's three labels
        # An attempt exists from the first session after the lowest close.
        # There is no separate 'rally_attempt' state any more: it IS the
        # correction, counted — which is what the workshop describes.
        'in_rally_attempt': state == 'correction' and rally_day >= 1,
        'live': [{k: v for k, v in dd.items() if not k.startswith('_')}
                 for dd in sorted(live, key=lambda x: -x['_i'])],
        'count': len(live),
        # The CLOSING low the count runs from, named for what it is.
        'anchor_close': None if anchor_close != anchor_close else round(anchor_close, 2),
        'anchor_date': (str(anchor_date.date())
                        if hasattr(anchor_date, 'date') else None),
        'rally_day': rally_day,
        'ftd': {k: v for k, v in ftd.items() if not k.startswith('_')} if ftd else None,
        'sessions_since_ftd': (n - 1 - ftd['_i']) if ftd else None,
        'events': events[-60:],          # bounded: the page shows recent history
        'sessions': n,
    }


def _band(sessions: int | None) -> str | None:
    """How far into the uptrend we are. O'Neil buys EARLY in one — and this is
    also where base-stage counting starts, because bases are counted from the
    market bottom."""
    if sessions is None:
        return None
    if sessions < 25:
        return 'early'
    if sessions <= 150:
        return 'established'
    return 'late'


def market_model(frames: dict[str, pd.DataFrame]) -> dict:
    """The whole model. `frames` maps index symbol → daily OHLCV.

    Pure: no network, no clock beyond stamping the result. Hand it bars and it
    returns the same answer every time, which is what makes a state machine
    over "what the market did" testable at all.
    """
    per = {}
    for sym, df in frames.items():
        if df is None or not len(df):
            continue
        per[sym] = index_pass(df, INDEXES.get(sym, sym))

    if not per:
        return {'ok': False, 'error': 'no index data'}

    # THE WORSE OF THE TWO decides the published status.
    status = max((v['published'] for v in per.values()),
                 key=lambda s: _SEVERITY.index(s) if s in _SEVERITY else 0)

    worst = max(per.values(),
                key=lambda v: (_SEVERITY.index(v['published'])
                               if v['published'] in _SEVERITY else 0, v['count']))
    if status == 'market_in_correction':
        if worst['in_rally_attempt']:
            # The rally attempt is DETAIL under the correction, never instead
            # of it — see _PUBLISHED. It is the number the follow-through rule
            # is measured against, so it is worth showing; it is not an
            # improvement on a correction.
            because = (f"{worst['index']}: day {worst['rally_day']} of a rally "
                       f"attempt off the {worst['anchor_date']} closing low "
                       f"— no "
                       f"follow-through yet, so the correction still stands")
        else:
            because = f"{worst['index']}: the uptrend has broken"
    else:
        because = (f"{worst['count']} distribution days live on the "
                   f"{worst['index']} ({_t('pressure_dd_count')} is the threshold)")

    # Every live day from both indexes, newest first, each carrying the rule
    # that produced it. A status word with no rows behind it is not checkable,
    # and this is a claim about when to stop buying.
    days = [d for v in per.values() for d in v['live']]
    days.sort(key=lambda d: d['date'], reverse=True)

    ftds = [v['ftd'] for v in per.values() if v['ftd']]
    ftd = max(ftds, key=lambda f: f['date']) if ftds else None
    since = min((v['sessions_since_ftd'] for v in per.values()
                 if v['sessions_since_ftd'] is not None), default=None)

    rally = next((
        {'index': v['index'], 'day': v['rally_day'],
         'low': v['anchor_close'], 'low_date': v['anchor_date'],
         # Named so nobody reads it as an intraday low: the anchor is the
         # lowest CLOSE of the correction, and the count runs from the session
         # after it.
         'anchor': 'lowest close'}
        for v in per.values() if v['in_rally_attempt']), None)

    return {
        'ok': True,
        'as_of': max((str(df.index[-1].date()) for df in frames.values()
                      if df is not None and len(df)), default=None),
        'built_at': _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds'),
        'status': status,
        'status_label': STATUS_LABEL.get(status, status),
        'because': because,
        'indexes': per,
        'distribution_days': days,
        'ftd': ftd,
        # Detail under the status, never instead of it.
        'rally_attempt': rally,
        'sessions_since_ftd': since,
        'ftd_band': _band(since),
        'ftd_caveat': FTD_CAVEAT,
        'model_note': MODEL_NOTE,
        'thresholds': THRESHOLDS,
        # The one-line rule summary the tab prints under the status, so every
        # number on the page carries the rule that produced it.
        'rules_in_use': (
            f"DD {THRESHOLDS['dd_drop_pct']['label']} on higher volume · "
            f"{THRESHOLDS['dd_window']['label']} · "
            f"{THRESHOLDS['dd_recovery_pct']['label']} recovery · "
            f"FTD {THRESHOLDS['ftd_gain_pct']['label']} on day "
            f"{_t('ftd_day_min')}–{_t('ftd_day_max')}, volume over the prior "
            f"session"
        ),
    }


# ---------------------------------------------------------------------------
# Per-card: what THIS stock did during the market events above
# ---------------------------------------------------------------------------

def stock_vs_distribution(stock_daily: pd.DataFrame, days: list[dict]) -> dict:
    """O'Neil's "leaders hold up during market pullbacks", made checkable.

    The market model knows the exact dates of the live distribution days. This
    asks what one stock did on those same sessions. It is the whole reason the
    market model is worth putting on a card: stamping "uptrend under pressure"
    on 150 cards is 150 identical lines, and a field with the same value on
    every row carries no information about any row. THIS number is different on
    every card and is computed from a market-level fact.

    A stock rising on the sessions the index was distributed is being
    accumulated while the market is being sold — which is what a leader looks
    like before it leads.
    """
    out = {'checked': 0, 'held': 0, 'avg_rel': None, 'verdict': None,
           'dates': [], 'note': None}
    if not days:
        # NOT "0 of 0", which reads as a failure. In a confirmed uptrend with
        # no live distribution days there is nothing to hold up through, and
        # saying so is the honest answer.
        out['note'] = 'no live distribution days — nothing to hold up through'
        return out
    if stock_daily is None or not len(stock_daily):
        out['note'] = 'no daily bars for this stock'
        return out

    d = stock_daily.copy()
    d.columns = [str(c).lower() for c in d.columns]
    d['ret'] = d['close'].pct_change() * 100
    by_date = {str(ts.date() if hasattr(ts, 'date') else ts): r
               for ts, r in zip(d.index, d['ret'])}

    rels = []
    for dd in days:
        r = by_date.get(dd['date'])
        if r is None or r != r:
            continue
        rel = float(r) - float(dd.get('pct') or 0.0)
        rels.append(rel)
        out['dates'].append({'date': dd['date'], 'index': dd.get('index'),
                             'stock_pct': round(float(r), 2),
                             'index_pct': dd.get('pct'),
                             'rel': round(rel, 2), 'held': rel > 0})
    out['checked'] = len(rels)
    if not rels:
        out['note'] = 'this stock has no bars on those sessions'
        return out
    out['held'] = sum(1 for r in rels if r > 0)
    out['avg_rel'] = round(sum(rels) / len(rels), 2)
    share = out['held'] / out['checked']
    out['verdict'] = ('HOLDING UP' if share >= 0.6 and out['avg_rel'] > 0
                      else 'GIVING WAY' if share <= 0.4 or out['avg_rel'] < 0
                      else 'IN LINE')
    return out


def stocks_ratings(symbols, feed: str = 'yahoo', index: str = '^GSPC',
                   lookback: int = 400) -> dict:
    """Phase 4 for a list of symbols: demand, the RS line, and divergence.

    ONE INDEX FRAME FOR ALL OF THEM. The RS line and the divergence test are
    both stock-against-index, and fetching the index once per symbol would be
    N identical requests for the same 400 bars.

    400 sessions because the RS line asks about 52 weeks of high ground and
    needs history before that window to have a maximum to compare against.
    """
    from chart import data_manager, ratings
    out = {}
    idx = None
    try:
        idx = data_manager.load_bars(index, '1d', lookback, feed)
    except Exception:                                     # noqa: BLE001
        idx = None
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym or sym in out:
            continue
        try:
            df = data_manager.load_bars(sym, '1d', lookback, feed)
            out[sym] = ratings.stock_ratings(df, idx)
        except Exception as e:                            # noqa: BLE001
            # Named, not dropped: "could not check" and "checked and weak" are
            # opposite conclusions and a missing key lets a page draw the
            # second from the first.
            out[sym] = {'error': f'could not fetch daily bars: {str(e)[:120]}'}
    return out


def stocks_vs_distribution(symbols, days, feed: str = 'yahoo',
                           lookback: int = 120) -> dict:
    """`stock_vs_distribution` for a list of symbols, with the fetching.

    ONE PLACE, NOT NINE. Every screener tool wants this for the tickers on its
    own page, and every one of them would otherwise be fetching daily bars for
    the same names from the same feed on its own schedule. qp already holds the
    parquet bar cache, so the second tool to ask for AAPL pays nothing.

    A symbol that cannot be fetched comes back with a NOTE rather than being
    dropped: "we could not check this one" and "this one did not hold up" are
    opposite conclusions, and a missing key would let the page draw the second
    from the first.
    """
    out = {}
    if not days:
        # Nothing to hold up through — say it once here rather than making
        # every caller work it out from an empty list.
        note = stock_vs_distribution(None, [])
        return {str(s).upper(): dict(note) for s in symbols}
    from chart import data_manager
    for raw in symbols:
        sym = str(raw).strip().upper()
        if not sym or sym in out:
            continue
        try:
            df = data_manager.load_bars(sym, '1d', lookback, feed)
            out[sym] = stock_vs_distribution(df, days)
        except Exception as e:                            # noqa: BLE001
            out[sym] = {'checked': 0, 'held': 0, 'avg_rel': None,
                        'verdict': None, 'dates': [],
                        'note': f'could not fetch daily bars: {str(e)[:120]}'}
    return out


# ---------------------------------------------------------------------------
# The only part that touches the network, and the shared file
# ---------------------------------------------------------------------------

# Next to the databases, like data/canslim-members.json — same lifetime, same
# backup, obvious to find. Written by qp, read by the nine screener tools.
SHARED = Path(os.environ.get('ONEIL_MARKET_FILE')
              or (Path(__file__).resolve().parents[2] / 'data' / 'oneil-market.json'))


def build(days: int = 500, feed: str = 'yahoo') -> dict:
    """Fetch both indexes and run the model. The only network call here.

    500 sessions ≈ two years, which is enough to have found a follow-through
    day and to have walked the state machine into a real state rather than the
    conservative 'correction' it seeds with.
    """
    from chart import data_manager
    frames = {}
    errors = {}
    for sym in INDEXES:
        try:
            frames[sym] = data_manager.load_bars(sym, '1d', days, feed)
        except Exception as e:                            # noqa: BLE001
            errors[sym] = str(e)[:200]
    out = market_model(frames)
    if errors:
        # NEVER SILENT. One index missing changes the answer — the status is
        # the worse of the two — so a partial model says which half it saw.
        out['errors'] = errors
        out['partial'] = True
    return out


def write_shared(model: dict) -> str | None:
    """Publish for the nine tools. Never raises: the market model being stale
    must never be able to stop a scan."""
    try:
        SHARED.parent.mkdir(parents=True, exist_ok=True)
        tmp = SHARED.with_suffix('.tmp')
        tmp.write_text(json.dumps(model, indent=1, default=str))
        tmp.replace(SHARED)                # atomic: a reader never sees half
        return str(SHARED)
    except Exception:                                     # noqa: BLE001
        return None


def read_shared() -> dict | None:
    """What a reader does. Absent or unparseable → None, and the caller renders
    the page exactly as it renders today."""
    try:
        return json.loads(SHARED.read_text())
    except Exception:                                     # noqa: BLE001
        return None
