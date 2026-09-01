"""The base — cup with handle, rounding bottom — ON A WEEKLY CHART.

WEEKLY, AND THAT IS NOT A PREFERENCE.

O'Neil taught bases on weekly charts and MarketSmith draws them weekly. It is
not a display choice, it changes the answer:

    a base is 7 to 65 WEEKS long. On a daily chart that is 35 to 325 bars,
    and every shape test drowns in intraday noise

    "heavy volume with no price progress" is a WEEK closing flat on volume
    well above its average. A single day doing that is one session; five
    weeks of it is institutions absorbing supply

    the handle is a "minor controlled drift" — two to eight weeks. Measured
    daily it is a fortnight of wiggles with no shape at all

So this resamples to weekly first, and every threshold below is in weeks.

THE THREE PHASES, from the workshop:

    1. DECLINE      price corrects in waves — typically three down — which
                    washes out weak retail holders
    2. BASE SUPPORT heavy volume WITHOUT further price progress: weeks where
                    volume spikes or stays very high but the price closes flat
                    or tight against the weeks before it. That is institutional
                    accumulation, and it is the phase people skip
    3. HANDLE       a minor controlled drift down, or tight sideways action,
                    near the UPPER part of the base, before the pivot

WHAT THIS IS NOT. It is not a pattern-matcher that says "cup with handle" and
means it. It measures the four things the phases are made of — depth, length,
the accumulation weeks, and the handle — and reports each with its number, so
a person can look at the chart and agree or not. A boolean that hid all four
would be a claim nobody could check, and O'Neil's own point about bases is that
you look at them.

PURE. `analyse()` takes daily bars and returns a dict. Nothing fetches.
"""

from __future__ import annotations

import pandas as pd

# A base is 7 to 65 weeks. Shorter than seven is a pullback, not a base — the
# consolidation has not lasted long enough to change who owns the stock.
MIN_WEEKS = 7
MAX_WEEKS = 65

# How deep. O'Neil's usual band is 12-33%; deeper than about half and the
# damage is structural rather than a consolidation, and the stock has to
# rebuild demand rather than resume.
MAX_DEPTH_PCT = 50.0
TYPICAL_DEPTH = (12.0, 33.0)

# The handle: a minor controlled drift, in the UPPER part of the base, lasting
# a week or two at least. A "handle" that gives back half the cup is the cup
# failing, not a handle.
HANDLE_MIN_WEEKS = 1
HANDLE_MAX_WEEKS = 8
HANDLE_MAX_DEPTH_PCT = 15.0
HANDLE_UPPER_HALF = 0.5

# "Heavy volume without price progress": a week closing within this much of
# the week before, on volume this far above the base's own average.
FLAT_WEEK_PCT = 2.0
HEAVY_VOL_X = 1.15

# The buy point. O'Neil's pivot is ten cents above the handle's high — a real
# ten cents, so the breakout has to clear the level rather than touch it.
PIVOT_OFFSET = 0.10


def to_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """Daily bars → weekly, on Friday closes.

    THE RESAMPLE IS THE FEATURE. Everything below reads weeks because O'Neil's
    base analysis is weekly; doing it on daily bars is a different measurement
    wearing the same words.

    A partial final week is kept: the current week matters most and dropping it
    would make every reading a week old.
    """
    d = daily.copy()
    d.columns = [str(c).lower() for c in d.columns]
    for col in ('open', 'high', 'low', 'close', 'volume'):
        if col not in d.columns:
            raise ValueError(f'daily bars need a {col!r} column, got {list(d.columns)}')
    w = d.resample('W-FRI').agg({'open': 'first', 'high': 'max', 'low': 'min',
                                 'close': 'last', 'volume': 'sum'})
    return w.dropna(subset=['close'])


def _waves(closes: list[float], threshold: float = 5.0) -> int:
    """How many distinct down legs, ignoring wiggles under `threshold` percent.

    O'Neil: "price corrects in waves — typically three down — which washes out
    weak retail holders." Counted with a threshold because otherwise every
    one-week bounce inside a decline reads as the end of a wave, and a smooth
    fall counts as thirty.
    """
    if len(closes) < 3:
        return 0
    waves, falling, pivot = 0, False, closes[0]
    for c in closes[1:]:
        if not falling:
            if c < pivot * (1 - threshold / 100):
                falling, waves = True, waves + 1
                pivot = c
            else:
                pivot = max(pivot, c)
        else:
            if c > pivot * (1 + threshold / 100):
                falling = False
                pivot = c
            else:
                pivot = min(pivot, c)
    return waves


def analyse(daily: pd.DataFrame, lookback_weeks: int = MAX_WEEKS + 10) -> dict:
    """Find the most recent base and describe it. Weekly, always.

    The base is taken as running from the highest weekly close in the window
    (the left lip) to now. That is the definition that matches how a base is
    drawn: it starts where the stock last topped, not where a scan happened to
    begin looking.
    """
    try:
        w = to_weekly(daily)
    except ValueError as e:
        return {'ok': False, 'error': str(e)}
    if len(w) < MIN_WEEKS + 2:
        return {'ok': False, 'weeks': len(w),
                'error': f'only {len(w)} weekly bars — a base is at least '
                         f'{MIN_WEEKS} weeks and cannot be read from fewer'}

    w = w.tail(lookback_weeks)
    closes = w['close'].astype(float)
    highs = w['high'].astype(float)
    lows = w['low'].astype(float)
    vols = w['volume'].astype(float)

    # THE LEFT LIP: the highest weekly close in the window. Everything after it
    # is the base under construction.
    lip_i = int(closes.values.argmax())
    if lip_i >= len(w) - MIN_WEEKS:
        return {'ok': False, 'weeks': len(w) - lip_i - 1,
                'reason': 'at or near its high — there is no base yet, which is '
                          'not a fault; a stock making highs is not building one'}

    base = w.iloc[lip_i:]
    b_closes = base['close'].astype(float)
    b_lows = base['low'].astype(float)
    b_vols = base['volume'].astype(float)
    weeks = len(base) - 1
    lip = float(highs.iloc[lip_i])
    low = float(b_lows.min())
    low_i = int(b_lows.values.argmin())
    depth = (1 - low / lip) * 100 if lip else None
    now = float(closes.iloc[-1])

    # PHASE 1 — the decline, in waves.
    decline = b_closes.iloc[:low_i + 1]
    waves = _waves([float(x) for x in decline])

    # PHASE 2 — HEAVY VOLUME WITHOUT PRICE PROGRESS. The phase people skip, and
    # the one that says institutions were absorbing what the decline shook out.
    # A flat WEEK on heavy volume; a flat day is one session.
    avg_vol = float(b_vols.mean()) or 1.0
    accumulation = []
    for i in range(1, len(base)):
        prev, cur = float(b_closes.iloc[i - 1]), float(b_closes.iloc[i])
        if not prev:
            continue
        flat = abs(cur / prev - 1) * 100 <= FLAT_WEEK_PCT
        heavy = float(b_vols.iloc[i]) >= avg_vol * HEAVY_VOL_X
        if flat and heavy:
            ts = base.index[i]
            accumulation.append({
                'week': str(ts.date() if hasattr(ts, 'date') else ts),
                'close_chg_pct': round((cur / prev - 1) * 100, 2),
                'vol_x': round(float(b_vols.iloc[i]) / avg_vol, 2),
            })

    # PHASE 3 — THE HANDLE. A minor controlled drift in the UPPER part of the
    # base, after the right side has rebuilt. Measured from the highest close
    # since the base low: the handle is the pullback from that.
    right = base.iloc[low_i:]
    handle = None
    if len(right) >= 3:
        rc = right['close'].astype(float)
        peak_i = int(rc.values.argmax())
        if peak_i < len(right) - 1:
            h = right.iloc[peak_i:]
            h_high = float(h['high'].max())
            h_low = float(h['low'].min())
            h_weeks = len(h) - 1
            h_depth = (1 - h_low / h_high) * 100 if h_high else None
            # In the UPPER part of the base: a "handle" that gives back half
            # the cup is the cup failing, not a handle.
            in_upper = (h_low - low) / (lip - low) > HANDLE_UPPER_HALF if lip > low else False
            handle = {
                'weeks': h_weeks,
                'high': round(h_high, 2),
                'low': round(h_low, 2),
                'depth_pct': None if h_depth is None else round(h_depth, 1),
                'in_upper_half': bool(in_upper),
                'valid': bool(HANDLE_MIN_WEEKS <= h_weeks <= HANDLE_MAX_WEEKS
                              and h_depth is not None
                              and h_depth <= HANDLE_MAX_DEPTH_PCT
                              and in_upper),
                'pivot': round(h_high + PIVOT_OFFSET, 2),
            }

    # The pivot: ten cents above the handle's high, or above the left lip when
    # there is no handle yet.
    pivot = (handle['pivot'] if handle and handle['valid']
             else round(lip + PIVOT_OFFSET, 2))

    checks = {
        'length_ok': MIN_WEEKS <= weeks <= MAX_WEEKS,
        'depth_ok': depth is not None and depth <= MAX_DEPTH_PCT,
        'depth_typical': depth is not None and TYPICAL_DEPTH[0] <= depth <= TYPICAL_DEPTH[1],
        'waves_ok': waves >= 2,
        'accumulation_ok': len(accumulation) >= 2,
        'handle_ok': bool(handle and handle['valid']),
    }
    return {
        'ok': True,
        'timeframe': 'weekly',
        'timeframe_note': ("O'Neil analyses bases on WEEKLY charts and so does "
                           'this. Every length below is in weeks; the same tests '
                           'on daily bars measure something else.'),
        'weeks': weeks,
        'left_lip': round(lip, 2),
        'lip_week': str(base.index[0].date() if hasattr(base.index[0], 'date')
                        else base.index[0]),
        'low': round(low, 2),
        'low_week': str(base.index[low_i].date() if hasattr(base.index[low_i], 'date')
                        else base.index[low_i]),
        'depth_pct': None if depth is None else round(depth, 1),
        'waves_down': waves,
        # PHASE 2, listed with its weeks so it can be seen on the chart. A
        # count with no rows behind it is a claim rather than a reading.
        'accumulation_weeks': accumulation,
        'handle': handle,
        'pivot': pivot,
        'pct_to_pivot': round((pivot / now - 1) * 100, 2) if now else None,
        'now': round(now, 2),
        'off_high_pct': round((now / lip - 1) * 100, 2) if lip else None,
        'checks': checks,
        'score': sum(1 for v in checks.values() if v),
        'of': len(checks),
        # Deliberately not a verdict. See the module note: the four numbers are
        # the point, and a boolean that hid them would be a claim nobody could
        # check against the chart.
        'summary': (f'{weeks}-week base, {depth:.0f}% deep, {waves} waves down, '
                    f'{len(accumulation)} accumulation weeks'
                    + (f', handle {handle["weeks"]}w' if handle and handle['valid']
                       else ', no handle yet')) if depth is not None else None,
    }
