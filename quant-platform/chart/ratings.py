"""Phase 4 — the reads that need bars: demand, the RS line, and divergence.

WHAT IS IN HERE AND WHY EACH ONE IS SEPARATE.

    up_down_volume_ratio   institutional demand as a plain 50-day ratio
    acc_dis                the same question graded over 13 weeks
    rs_line                stock / index, plotted — the SHAPE is the signal
    rs_line_tell           the RS line at new high ground BEFORE price
    divergence             the stock refusing to follow the index down

The last two are the workshop's section 3, and they are the sharpest thing in
CAN SLIM that this system did not have.

O'NEIL'S OWN WORDS ON DIVERGENCE. "A mathematical divergence occurs when an
individual stock stops moving in tandem with the broad market index. While the
broad market index breaks down to new lows during a panic, the target stock
fails to make a new low — holding its prior support floor — and instead
reverses upward." And the confirmation: "the stock's Relative Strength line
begins making higher highs and enters new high ground BEFORE the stock price
itself breaks out."

That word BEFORE is the whole thing. An RS line at a new high at the same time
as price is arithmetic — price went up, so the ratio went up. An RS line at a
new high while price is still inside its base is a different claim entirely:
somebody is buying this while the market is not, and it is visible before the
breakout rather than after it.

TWO RATINGS THAT SOUND LIKE ONE, AND ARE NOT.

    U/D Volume Ratio        up-day volume / down-day volume, 50 days. One
                            number, ~1.0 neutral. A plain count.
    Accumulation/Dis        a GRADED read of price AND volume over 13 weeks

They disagree often and the disagreement is informative, which is exactly why
both are here and neither is derived from the other.

AND THE NAMING RULE, from spec section 6. What is built here is a
reconstruction from published descriptions, so it is named `ad`, never "IBD
Accumulation/Distribution Rating". A number that looked like IBD's and was not
would be worse than no number at all.

PURE. Every function takes DataFrames and returns a dict. Nothing fetches.
"""

from __future__ import annotations

import pandas as pd

# ---------------------------------------------------------------------------
# Windows. Each is the published length for its own measure, and they differ —
# which is the point: they are answering different questions over different
# horizons and averaging them into one window would blur both.
# ---------------------------------------------------------------------------
UD_SESSIONS = 50            # U/D volume ratio: 50 days, published
AD_SESSIONS = 65            # Accumulation/Distribution: 13 weeks ≈ 65 sessions
RS_LOOKBACK = 252           # "new high ground": 52 weeks
RS_RECENT = 63              # ...and a quarter, for the shorter read

# Our A/D bands. STATED AS OURS. IBD percentile-ranks its rating against the
# whole market and does not publish the boundaries; this bands the raw score
# directly, so the letter is comparable between two of OUR cards and is not
# claimed to equal IBD's letter for the same stock. The raw number is printed
# beside it so the banding can be checked rather than trusted.
AD_BANDS = ((0.30, 'A'), (0.15, 'B'), (-0.15, 'C'), (-0.30, 'D'))

AD_NOTE = ('Ours, not IBD\'s. IBD grades its Accumulation/Distribution Rating '
           'by percentile against the whole market and does not publish the '
           'boundaries; this bands the raw score directly. The raw number is '
           'shown beside the letter so the banding is checkable.')

# The trap this measure is most often confused with, carried with the number so
# it reaches the page rather than staying in a document.
AD_NOT = ('Not the Accumulation/Distribution INDEX (Chaikin), which is a '
          'different object with the same words: that one is an UNBOUNDED '
          'CUMULATIVE line over all history. This is a BOUNDED read over a '
          'fixed 13-week window — the same daily primitive, windowed and '
          'normalised by the volume in that window, which is what makes it '
          'comparable between two stocks at all.')


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out.columns = [str(c).lower() for c in out.columns]
    for col in ('open', 'high', 'low', 'close', 'volume'):
        if col not in out.columns:
            raise ValueError(f'daily bars need a {col!r} column, '
                             f'got {list(out.columns)}')
    return out


# ---------------------------------------------------------------------------
# Demand
# ---------------------------------------------------------------------------

def up_down_volume_ratio(df: pd.DataFrame, sessions: int = UD_SESSIONS) -> dict:
    """Up-day volume ÷ down-day volume over the last 50 sessions.

    One number, and 1.0 is neutral by construction: above it, more volume
    traded on the days this stock rose than on the days it fell, which is what
    institutional accumulation looks like in the only place it is visible.

    UNCHANGED DAYS GO TO NEITHER SIDE. Putting them in the denominator would
    make a quiet stock look distributed, and putting them in the numerator the
    reverse; they are not evidence either way.
    """
    d = _clean(df).tail(sessions + 1)
    if len(d) < 3:
        return {'ratio': None, 'sessions': 0,
                'note': 'not enough sessions to measure'}
    ret = d['close'].pct_change()
    vol = d['volume']
    up = float(vol[ret > 0].sum())
    down = float(vol[ret < 0].sum())
    flat = int((ret == 0).sum())
    if down <= 0:
        # Every session up, or no down volume at all. A ratio would be infinite
        # and an infinity on a card is a bug people report; the honest reading
        # is that there is nothing to divide by.
        return {'ratio': None, 'up_volume': up, 'down_volume': down,
                'sessions': int(ret.notna().sum()), 'flat_days': flat,
                'note': 'no down-day volume in the window — nothing to divide by'}
    return {
        'ratio': round(up / down, 2),
        'up_volume': up,
        'down_volume': down,
        'flat_days': flat,
        'sessions': int(ret.notna().sum()),
        'window': f'{sessions} sessions',
    }


def acc_dis(df: pd.DataFrame, sessions: int = AD_SESSIONS) -> dict:
    """A graded read of price AND volume over 13 weeks. Ours, named as ours.

    THE CONSTRUCTION, and it is chosen to be the documented difference from
    the Chaikin index rather than a variation on it:

        each day   where the close sat in that day's range, as -1 .. +1
                   ((close-low) - (high-close)) / (high-low)
        weighted   by that day's volume
        summed     over 13 weeks
        divided    by the volume in those 13 weeks

    The division is what matters. It makes the result BOUNDED at -1..+1 and
    comparable between a heavily traded name and a thin one, where Chaikin's
    cumulative line is unbounded and comparable to nothing but itself.

    Reading: +1 is every session closing on its high on heavy volume; -1 is
    every session closing on its low. Real stocks live between about -0.4 and
    +0.4, which is why the bands are where they are.
    """
    d = _clean(df).tail(sessions)
    if len(d) < 10:
        return {'raw': None, 'letter': None, 'sessions': len(d),
                'note': 'not enough sessions to grade'}
    # A zero-range session — a hard limit, or a halted name — has no "where the
    # close sat" to read. Dropped rather than counted as neutral, because
    # neutral is a claim and this is an absence. NaN and not pd.NA: the whole
    # frame stays float, and a masked-integer dtype cannot be cast back.
    rng = (d['high'] - d['low']).astype(float).replace(0.0, float('nan'))
    mfm = ((d['close'] - d['low']) - (d['high'] - d['close'])).astype(float) / rng
    ok = mfm.notna() & (d['volume'] > 0)
    if not ok.any():
        return {'raw': None, 'letter': None, 'sessions': 0,
                'note': 'no usable sessions'}
    vol = d['volume'][ok]
    raw = float((mfm[ok] * vol).sum() / vol.sum())
    letter = 'E'
    for cut, lab in AD_BANDS:
        if raw >= cut:
            letter = lab
            break
    return {
        'raw': round(raw, 3),
        'letter': letter,
        'sessions': int(ok.sum()),
        'window': '13 weeks',
        'bands': [[c, l] for c, l in AD_BANDS],
        'note': AD_NOTE,
        'not': AD_NOT,
    }


# ---------------------------------------------------------------------------
# The RS line, and the two things it is asked
# ---------------------------------------------------------------------------

def rs_line(stock: pd.DataFrame, index: pd.DataFrame) -> pd.Series:
    """stock close ÷ index close, aligned on the dates they share.

    THE LINE IS NOT THE RATING. The RS Rating is today's percentile against
    every other stock — a number, 1..99, backward-looking over twelve months.
    This is a curve, and its SHAPE is the signal. A stock can hold RS Rating 95
    while its RS line rolls over; the line turns first, which is the only
    reason to plot it.

    Aligned on the intersection on purpose: a half-day, a holiday one venue
    kept and the other did not, or one missing bar would otherwise shift every
    subsequent point of the ratio by a day.
    """
    s = _clean(stock)['close']
    i = _clean(index)['close']
    both = s.index.intersection(i.index)
    if not len(both):
        return pd.Series(dtype=float)
    return (s.loc[both] / i.loc[both]).sort_index()


def _bars_since_high(series: pd.Series) -> int | None:
    """How many bars ago the running maximum was set. 0 means today."""
    if not len(series):
        return None
    return int(len(series) - 1 - series.values.argmax())


def rs_line_tell(stock: pd.DataFrame, index: pd.DataFrame,
                 lookback: int = RS_LOOKBACK) -> dict:
    """The MarketSmith tell: the RS line at new high ground BEFORE price.

    O'Neil: "the stock's Relative Strength line begins making higher highs and
    enters new high ground BEFORE the stock price itself breaks out, confirming
    institutional accumulation."

    THE WORD "BEFORE" IS THE ENTIRE SIGNAL, and it is why this cannot be
    reduced to "is the RS line high". An RS line at a new high on the same day
    price makes one is arithmetic: price rose, the index did not, so the ratio
    rose. It says nothing that the price chart did not already say.

    The RS line at a new high while price is STILL INSIDE ITS BASE is a
    different claim: somebody is buying this while the market is not, and it is
    legible before the breakout rather than after it.

    So the answer is a pair — where each is in its own range — and the tell
    fires only on the asymmetry.
    """
    line = rs_line(stock, index)
    d = _clean(stock)
    px = d['close'].reindex(line.index).dropna()
    line = line.reindex(px.index)
    if len(px) < 30:
        return {'tell': False, 'sessions': len(px),
                'note': 'not enough overlapping sessions'}

    w_line = line.tail(lookback)
    w_px = px.tail(lookback)
    line_high = float(w_line.max())
    px_high = float(w_px.max())
    line_now = float(w_line.iloc[-1])
    px_now = float(w_px.iloc[-1])

    # "New high ground" with a hair of tolerance: a line sitting one basis
    # point under its own maximum is at a new high in every sense that matters,
    # and an exact comparison on floats would say otherwise on half the days it
    # is true.
    at_line_high = line_now >= line_high * 0.999
    at_px_high = px_now >= px_high * 0.999

    return {
        # THE TELL: the line is in new high ground and the price is not yet.
        'tell': bool(at_line_high and not at_px_high),
        'rs_line_at_high': at_line_high,
        'price_at_high': at_px_high,
        # How far price still has to travel to confirm what the line is already
        # saying — which is the distance to the buy point, in one number.
        'price_off_high_pct': round((px_now / px_high - 1) * 100, 2),
        'rs_off_high_pct': round((line_now / line_high - 1) * 100, 2),
        'rs_high_bars_ago': _bars_since_high(w_line),
        'price_high_bars_ago': _bars_since_high(w_px),
        # Positive = the line got there first, in sessions. THIS is the lead
        # the workshop is describing, as a number.
        'lead_sessions': (None if _bars_since_high(w_px) is None
                          else _bars_since_high(w_px) - _bars_since_high(w_line)),
        'lookback': int(min(lookback, len(w_px))),
        'sessions': len(px),
    }


def divergence(stock: pd.DataFrame, index: pd.DataFrame,
               lookback: int = RS_LOOKBACK, window: int = 21) -> dict:
    """The workshop's decoupling test: the index makes a new low, this does not.

    O'Neil: "While the broad market index breaks down to new lows during a
    panic, the target stock fails to make a new low — holding its prior support
    floor — and instead reverses upward."

    Three separate facts, and all three have to be there:

        1. the INDEX made a new low inside the recent window     the panic
        2. the STOCK did not                                     the refusal
        3. the stock is above where it was when the index bottomed  the reversal

    WITHOUT (1) THIS MEASURES NOTHING. A stock not making a new low during a
    calm month is not diverging from anything — it is simply a stock. The test
    is only meaningful when the market gave it every reason to break and it
    did not, which is why the index's own new low is the precondition rather
    than a detail.

    Closing prices throughout, for the same reason the follow-through anchor
    is a close: an intraday spike through a level the session closed back above
    is not a break of it.
    """
    line_idx = _clean(index)['close']
    line_stk = _clean(stock)['close']
    both = line_stk.index.intersection(line_idx.index)
    if len(both) < 60:
        return {'diverging': False, 'sessions': len(both),
                'note': 'not enough overlapping sessions'}
    stk = line_stk.loc[both].sort_index().tail(lookback)
    idx = line_idx.loc[both].sort_index().tail(lookback)

    recent = min(window, len(idx) - 1)
    idx_low_all = float(idx.min())
    idx_recent_low = float(idx.tail(recent).min())
    stk_low_all = float(stk.min())
    stk_recent_low = float(stk.tail(recent).min())

    # 1. Did the index actually break to a new low in the window?
    index_new_low = idx_recent_low <= idx_low_all * 1.001
    # 2. Did the stock refuse?
    stock_new_low = stk_recent_low <= stk_low_all * 1.001
    # 3. Is it above where it sat on the index's worst close?
    when_idx_bottom = idx.tail(recent).idxmin()
    stock_then = float(stk.loc[when_idx_bottom]) if when_idx_bottom in stk.index else None
    reversed_up = (stock_then is not None and float(stk.iloc[-1]) > stock_then)

    return {
        'diverging': bool(index_new_low and not stock_new_low and reversed_up),
        'index_new_low': bool(index_new_low),
        'stock_new_low': bool(stock_new_low),
        'reversed_up': bool(reversed_up),
        'index_low_date': str(when_idx_bottom.date()
                              if hasattr(when_idx_bottom, 'date') else when_idx_bottom),
        'stock_then': None if stock_then is None else round(stock_then, 2),
        'stock_now': round(float(stk.iloc[-1]), 2),
        'since_pct': (None if not stock_then
                      else round((float(stk.iloc[-1]) / stock_then - 1) * 100, 2)),
        'stock_above_own_low_pct': round((stk_recent_low / stk_low_all - 1) * 100, 2),
        'window': f'{recent} sessions',
        # Said explicitly, because "not diverging" has two very different
        # causes and only one of them is about the stock.
        'note': (None if index_new_low else
                 'the index has not made a new low in this window — there is '
                 'nothing to diverge FROM, which is not the same as failing to'),
    }


def stock_ratings(stock: pd.DataFrame, index: pd.DataFrame | None = None) -> dict:
    """Everything in this module for one stock, in one pass over its bars."""
    out = {'ud': up_down_volume_ratio(stock), 'ad': acc_dis(stock)}
    if index is not None and len(index):
        out['rs_line'] = rs_line_tell(stock, index)
        out['divergence'] = divergence(stock, index)
    return out
