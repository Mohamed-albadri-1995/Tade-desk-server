"""OR + session-VWAP 09:35 — standalone, dependency-light reference implementation.

WHY THIS FILE EXISTS
--------------------
The live setup is a declarative JSON document (chart/seeds/or_vwap.json)
executed by chart/strategy.py against the verified `qp` primitive library. That
is the right shape for a platform and the wrong shape for handing to someone
who wants to CHANGE the setup: to read it you have to hold the evaluator in
your head. This file states the same logic as ordinary Python — one function
per decision, no framework, pandas as the only requirement — so the rules can
be argued with, edited and re-tested directly.

It is a REFERENCE, not the source of truth. If this file and the JSON ever
disagree, the JSON is what ran. `chart/tests/logic_audit31.py` pins the JSON;
`selftest()` at the bottom of this file pins this one against the same
hand-built cases, so a change here that breaks the logic is caught.

THE SETUP (long; short is the exact mirror)
-------------------------------------------
Opening range      09:30-09:34 inclusive (the first FIVE 1-minute bars)
Decision bar       09:34 close
Entry              the OPEN of the 09:35 bar — the first price you could
                   actually have paid after the decision
Gate 1  trend      close > session VWAP
Gate 2  slope      session VWAP > session VWAP three bars earlier (rising)
Gate 3  position   the close sits in the top 45% of the opening range:
                   (close - OR_low) / (OR_high - OR_low) >= 0.55
Gate 4  room       close - OR_mid >= 0.5 x ATR(14). Without this, entries
                   whose stop is a few cents away pass every other test and
                   are stopped by noise
Stop               OR_mid = OR_low + (OR_high - OR_low)/2, FROZEN at entry
Target             HALF the position at 2R (R = entry - stop)
Runner             the other half exits when a close crosses back below the
                   session VWAP
One entry per symbol per day.

Short mirrors every line: below VWAP, VWAP falling, position <= 0.45, room
measured downward, stop at OR_mid above, runner exits on a close back above.

WHAT IS DELIBERATELY NOT HERE
-----------------------------
· Cross-symbol ranking. The 09:35 setup takes every signal; its sibling
  (T2 10:00) ranks the day's candidates against each other. If you add ranking
  here, it belongs OUTSIDE this file — it needs every symbol's signals at once.
· Position sizing, commissions, capital caps. `size_position()` shows the
  sizing rule the platform uses, but the P&L here is per-unit so the logic can
  be judged without an account model on top of it.
· Survivorship-free universe selection. Feed it the frozen per-day shortlist.

USAGE
-----
    import pandas as pd
    from or_vwap_0935 import run_day, Params

    bars = pd.DataFrame(...)          # 1-minute OHLCV, tz-aware index, ET
    trade = run_day(bars, side='long')

    python3 or_vwap_0935.py           # runs selftest()
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd

ET = 'America/New_York'


# ── parameters — every number the setup depends on, in one place ──────────
@dataclass(frozen=True)
class Params:
    or_start: str = '09:30'        # opening range, inclusive
    or_end: str = '09:34'          # last bar OF the range
    entry_bar: str = '09:35'       # the bar whose OPEN is paid
    vwap_slope_lookback: int = 3   # bars back for the "VWAP is rising" test
    position_in_range: float = 0.55  # long needs >=; short needs <= (1 - this)
    atr_length: int = 14
    atr_room_mult: float = 0.5     # entry must clear the stop by this x ATR
    target_r: float = 2.0
    target_fraction: float = 0.5   # how much comes off at the target
    session_end: str = '15:50'     # forced flat (matches the platform's EOD rule)


# ── indicators ────────────────────────────────────────────────────────────
def session_vwap(bars: pd.DataFrame) -> pd.Series:
    """Volume-weighted average price, reset every session.

    Typical price x volume, cumulated from the session's FIRST bar. Two things
    matter and are easy to get wrong:
      · it resets each day — a VWAP carried across sessions is a different
        indicator and will not match any chart;
      · it includes every bar the frame contains. Feed it RTH-only bars and you
        get the RTH VWAP; include premarket and you get a different line. The
        platform computes it on the same bars it draws, so the backtest and the
        chart agree. Match whichever you intend, and be consistent.
    """
    tp = (bars['high'] + bars['low'] + bars['close']) / 3.0
    day = bars.index.tz_convert(ET).normalize()
    pv = (tp * bars['volume']).groupby(day).cumsum()
    vv = bars['volume'].groupby(day).cumsum()
    return pv / vv.replace(0, np.nan)


def atr(bars: pd.DataFrame, length: int = 14) -> pd.Series:
    """Wilder's Average True Range.

    Wilder smoothing (alpha = 1/length), NOT a simple mean of true ranges —
    they differ by enough to move a 0.5 x ATR gate. True range takes the
    previous CLOSE into account so a gap counts as range.
    """
    prev_close = bars['close'].shift(1)
    tr = pd.concat([bars['high'] - bars['low'],
                    (bars['high'] - prev_close).abs(),
                    (bars['low'] - prev_close).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / length, adjust=False).mean()


# ── one session ───────────────────────────────────────────────────────────
@dataclass
class Trade:
    side: str
    entry_time: pd.Timestamp
    entry: float
    stop: float
    r_per_share: float
    or_high: float
    or_low: float
    or_mid: float
    target: float
    legs: list = field(default_factory=list)   # (time, price, fraction, why)
    exit_time: pd.Timestamp | None = None
    exit: float | None = None
    reason: str | None = None

    @property
    def ret_pct(self) -> float | None:
        """Size-weighted return of the WHOLE position, in percent.

        Weighted because a scale-out is not one fill: banking half at 2R and
        trailing the rest is a different result from either leg alone, and
        averaging the two prices would silently assume equal size.
        """
        if self.exit is None:
            return None
        sgn = 1.0 if self.side == 'long' else -1.0
        total, used = 0.0, 0.0
        for _t, px, fr, _w in self.legs:
            total += fr * sgn * (px / self.entry - 1.0)
            used += fr
        total += (1.0 - used) * sgn * (self.exit / self.entry - 1.0)
        return total * 100.0


def _slice(bars: pd.DataFrame, day, lo: str, hi: str) -> pd.DataFrame:
    """Bars between two ET clock times, both ends INCLUSIVE."""
    et = bars.index.tz_convert(ET)
    mask = (et.normalize() == day) & (et.strftime('%H:%M') >= lo) & \
           (et.strftime('%H:%M') <= hi)
    return bars[mask]


def run_day(bars: pd.DataFrame, side: str = 'long',
            p: Params = Params()) -> Trade | None:
    """Evaluate ONE session for ONE symbol. Returns the trade, or None.

    `bars` must be 1-minute OHLCV with a timezone-aware index covering at
    least 09:30 to the close. Extra history before the session is fine and is
    what ATR needs — ATR(14) on a frame that starts at 09:30 is not ATR(14).
    """
    if bars.empty:
        return None
    et = bars.index.tz_convert(ET)
    day = et.normalize()[-1]

    vwap = session_vwap(bars)
    a = atr(bars, p.atr_length)

    # ── the opening range, and the decision bar that closes it ────────────
    orb = _slice(bars, day, p.or_start, p.or_end)
    if orb.empty:
        return None
    or_high, or_low = float(orb['high'].max()), float(orb['low'].min())
    rng = or_high - or_low
    if rng <= 0:                       # a flat five minutes has no geometry
        return None
    or_mid = or_low + rng / 2.0

    decision_idx = orb.index[-1]       # the 09:34 bar
    i = bars.index.get_loc(decision_idx)
    close = float(bars['close'].iloc[i])
    v_now = float(vwap.iloc[i])
    if i - p.vwap_slope_lookback < 0:
        return None
    v_then = float(vwap.iloc[i - p.vwap_slope_lookback])
    atr_now = float(a.iloc[i])
    if not np.isfinite(v_now) or not np.isfinite(atr_now):
        return None

    # ── the four gates ────────────────────────────────────────────────────
    position = (close - or_low) / rng          # 0 at the low, 1 at the high
    if side == 'long':
        gates = {
            'above_vwap': close > v_now,
            'vwap_rising': v_now > v_then,
            'in_top_of_range': position >= p.position_in_range,
            'room_to_stop': (close - or_mid) >= p.atr_room_mult * atr_now,
        }
    else:
        gates = {
            'below_vwap': close < v_now,
            'vwap_falling': v_now < v_then,
            'in_bottom_of_range': position <= (1.0 - p.position_in_range),
            'room_to_stop': (or_mid - close) >= p.atr_room_mult * atr_now,
        }
    if not all(gates.values()):
        return None

    # ── entry: the OPEN of the next bar, never the decision bar's close ───
    # Paying the close of the bar you decided on is the single most common way
    # a backtest invents money it could not have made.
    ent = _slice(bars, day, p.entry_bar, p.entry_bar)
    if ent.empty:
        return None
    entry_time = ent.index[0]
    entry = float(ent['open'].iloc[0])

    stop = or_mid
    r = (entry - stop) if side == 'long' else (stop - entry)
    if r <= 0:
        return None                     # price already through the stop
    target = entry + p.target_r * r if side == 'long' else entry - p.target_r * r

    t = Trade(side=side, entry_time=entry_time, entry=entry, stop=stop,
              r_per_share=r, or_high=or_high, or_low=or_low, or_mid=or_mid,
              target=target)

    # ── management, bar by bar, from the entry bar onward ─────────────────
    after = bars[bars.index >= entry_time]
    et_after = after.index.tz_convert(ET)
    banked = False
    for j in range(len(after)):
        bar = after.iloc[j]
        ts = after.index[j]
        hi, lo, cl = float(bar['high']), float(bar['low']), float(bar['close'])

        # STOP FIRST is NOT assumed here. When one bar touches both the stop
        # and the target, this implementation books the TARGET, matching the
        # 09:35 seed. Its sibling (T2 10:00) sets stop_first and books the
        # stop. Neither is more correct; they are different assumptions about
        # an unknowable intrabar path, and results are not comparable across
        # them. Flip the order of these two blocks to test the other one.
        if not banked:
            hit_t = (hi >= target) if side == 'long' else (lo <= target)
            if hit_t:
                t.legs.append((ts, target, p.target_fraction, 'target 2R'))
                banked = True
                if p.target_fraction >= 1.0:
                    t.exit_time, t.exit, t.reason = ts, target, 'TP'
                    return t

        hit_s = (lo <= stop) if side == 'long' else (hi >= stop)
        if hit_s:
            t.exit_time, t.exit, t.reason = ts, stop, 'SL'
            return t

        # the runner trails the session VWAP: out on a CLOSE back through it
        if banked:
            v = float(vwap.loc[ts])
            crossed = (cl < v) if side == 'long' else (cl > v)
            if crossed:
                t.exit_time, t.exit, t.reason = ts, cl, 'vwap exit'
                return t

        if et_after[j].strftime('%H:%M') >= p.session_end:
            t.exit_time, t.exit, t.reason = ts, cl, 'eod'
            return t

    last = after.index[-1]
    t.exit_time, t.exit, t.reason = last, float(after['close'].iloc[-1]), 'eod'
    return t


# ── position sizing, for reference ────────────────────────────────────────
def size_position(equity: float, risk_pct: float, entry: float, stop: float,
                  open_notional: float = 0.0, max_leverage: float = 1.0
                  ) -> tuple[float, str]:
    """Shares to trade, and why it might be fewer than the risk rule asks for.

    The rule that makes every stop-out cost the same fraction of the account:
    risking R dollars with the stop D per share away buys R/D shares. Two
    caps that a backtest without them will quietly ignore:
      · buying power is shared by everything already open, not per trade;
      · a trade with no usable stop cannot be sized at all and must be
        excluded, never sized at one share.
    """
    per_share = abs(entry - stop)
    if per_share <= 0 or entry <= 0 or equity <= 0:
        return 0.0, 'no usable stop — not sizable'
    shares = (equity * risk_pct / 100.0) / per_share
    room = equity * max_leverage - open_notional
    if room <= 0:
        return 0.0, 'no buying power left'
    if shares * entry > room:
        return room / entry, 'capped by available balance'
    return shares, 'full risk'


# ── selftest ──────────────────────────────────────────────────────────────
def _frame(closes, day='2026-08-04', vols=None, warmup=30, warmup_amp=0.01):
    """1-minute bars from 09:30, with `warmup` bars before the open.

    The warm-up exists so ATR(14) is defined on the decision bar. It carries
    ZERO volume, which makes `session_vwap` behave like the RTH VWAP even
    though the frame reaches back before 09:30 — otherwise thirty flat
    pre-open bars anchor VWAP near the first price and no realistic fade can
    ever cross it. `warmup_amp` widens those bars' high/low to raise ATR
    without touching any close, which is how the room gate gets tested.
    """
    t0 = pd.Timestamp(f'{day} 09:30', tz=ET)
    idx = [t0 - pd.Timedelta(minutes=i) for i in range(warmup, 0, -1)]
    px = [closes[0]] * warmup
    for k, c in enumerate(closes):
        idx.append(t0 + pd.Timedelta(minutes=k))
        px.append(c)
    px = np.asarray(px, float)
    h, lo = px.copy(), px.copy()
    h[:warmup] += warmup_amp; lo[:warmup] -= warmup_amp
    h[warmup:] += 0.01; lo[warmup:] -= 0.01
    v = np.concatenate([np.zeros(warmup),
                        np.full(len(closes), 1e5) if vols is None
                        else np.asarray(vols, float)])
    return pd.DataFrame({'open': px, 'high': h, 'low': lo, 'close': px,
                         'volume': v},
                        index=pd.DatetimeIndex(idx).tz_convert('UTC'))


def selftest() -> int:
    ok = fail = 0

    def chk(name, cond, extra=''):
        nonlocal ok, fail
        if cond:
            ok += 1; print(f'  ok   {name}')
        else:
            fail += 1; print(f'  FAIL {name} {extra}')

    # A clean long: five rising bars, a push through the 2R target, then a fade
    # back under VWAP while still ABOVE the stop — so the runner's own exit is
    # what ends the trade, not the stop. OR = 10.00..10.40, mid 10.20.
    closes = ([10.00, 10.10, 10.20, 10.30, 10.40]
              + [10.5, 11.0, 12.0, 13.0, 12.5, 11.0, 10.6])
    f = _frame(closes)
    t = run_day(f, 'long')
    chk('a clean long fires', t is not None)
    if t:
        chk('entry is the 09:35 OPEN, not the 09:34 close',
            t.entry_time.tz_convert(ET).strftime('%H:%M') == '09:35', str(t.entry_time))
        chk('stop is the opening-range midpoint',
            abs(t.stop - (t.or_low + (t.or_high - t.or_low) / 2)) < 1e-9)
        chk('target is entry + 2R', abs(t.target - (t.entry + 2 * t.r_per_share)) < 1e-9)
        chk('half came off at the target', len(t.legs) == 1 and t.legs[0][2] == 0.5)
        chk('the RUNNER exits on the close back through VWAP',
            t.reason == 'vwap exit', str(t.reason))
        chk('...above the stop, so this is not a disguised stop-out',
            t.exit > t.stop, f'{t.exit} vs {t.stop}')
        # half at 2R (+11.43%) and half out at 10.60 (-0.76% off a 10.50 entry)
        chk('the return is SIZE-WEIGHTED across both legs, not an average price',
            abs(t.ret_pct - 3.333) < 0.01, str(round(t.ret_pct, 3)))

    # a trade that runs straight into its stop still books the stop
    down_fast = [10.00, 10.10, 10.20, 10.30, 10.40] + [10.5, 10.0, 9.5]
    ts = run_day(_frame(down_fast), 'long')
    chk('a long that fails books the stop, not the low',
        ts is not None and ts.reason == 'SL' and abs(ts.exit - ts.stop) < 1e-9)

    # position gate: a decision bar in the MIDDLE of the range must not trade
    mid = [10.00, 10.40, 10.10, 10.20, 10.20] + [10.2] * 5
    chk('a close mid-range is refused (needs the top 45%)',
        run_day(_frame(mid), 'long') is None)

    # room gate: a tight opening range on a volatile stock. The wide warm-up
    # bars lift ATR without moving a single close, so ONLY the room gate can
    # be what refuses this one.
    tight = [10.00, 10.01, 10.02, 10.03, 10.04] + [10.05] * 5
    chk('a range too tight to clear 0.5xATR is refused',
        run_day(_frame(tight, warmup_amp=0.5), 'long') is None)
    chk('...and the SAME range on a calm stock is accepted',
        run_day(_frame(tight, warmup_amp=0.001), 'long') is not None)

    # slope gate: price above a FALLING vwap must not trade. Heavy early volume
    # at a high price pins VWAP above and falling while price recovers.
    v = [5e6, 1e4, 1e4, 1e4, 1e4] + [1e4] * 5
    fall = [12.00, 10.10, 10.20, 10.30, 10.40] + [10.4] * 5
    tf = run_day(_frame(fall, vols=v), 'long')
    chk('price under a falling VWAP is refused', tf is None, str(tf))

    # the short is the mirror
    down = [10.40, 10.30, 10.20, 10.10, 10.00] + [9.9, 9.4, 8.8, 9.2, 10.5]
    s = run_day(_frame(down), 'short')
    chk('the short mirror fires', s is not None)
    if s:
        chk('short stop sits ABOVE the entry', s.stop > s.entry)
        chk('short target sits BELOW the entry', s.target < s.entry)

    # sizing
    sh, why = size_position(100000, 0.5, 50.0, 49.0)
    chk('sizing: $500 risk / $1 per share = 500 shares', sh == 500.0 and why == 'full risk')
    sh2, why2 = size_position(100000, 0.5, 50.0, 49.99)
    chk('sizing: a 1-cent stop is capped by the balance, not by risk',
        why2 == 'capped by available balance' and abs(sh2 - 2000.0) < 1e-6, f'{sh2} {why2}')
    sh3, why3 = size_position(100000, 0.5, 50.0, 50.0)
    chk('sizing: no usable stop returns 0 shares, not 1', sh3 == 0.0)

    print(f'\n  PASS={ok}  FAIL={fail}')
    return 1 if fail else 0


if __name__ == '__main__':
    raise SystemExit(selftest())
