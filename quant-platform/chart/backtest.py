"""
Backtest runner — Phase 4.

Replays a saved strategy day by day over a universe (a fixed symbol list, or
the screener's frozen R1/Shortlist registers with per-day membership) by
calling the SAME `chart.strategy.evaluate()` the chart preview uses — same
JSON, same math, same fill model. There is no separate backtest evaluator, so
preview and backtest can never disagree.

Honesty rules (see chart/PHASE4_PLAN.md — decisions 2-4):
- Each (day D, symbol) pair is evaluated with `asof=D`; only trades whose
  ENTRY bar falls on the ET date D count for day D. Warm-up-day signals are
  context, never trades.
- A position still open at the evaluation window's end is recorded with
  reason 'open' and its unrealized return — reported separately, never mixed
  into the closed-trade win rate.
- Fill model is explicit per run and DEFAULTS TO 'desk' — the fill at the next
  bar's open, with the stop and every target measured from the decision bar's
  close, which is the pair of prices the live desk really uses. 'next_open'
  and 'close' remain available for comparison; both flatter the result, and
  the report says so.

Sequential by design (t3.micro): one (day, symbol) at a time, progress
reported as the fraction of pairs completed.
"""

from __future__ import annotations

import math
import traceback

import pandas as pd

import tools.compare_server as cs
from chart import store
from chart import strategy as strat


def rank_metric(side: str, entry, stop) -> float | None:
    """How strong a signal is, for ranking the day's signals against each other.

    The distance from entry to the stop, as a percent. For a VWAP-anchored stop
    that IS the distance from VWAP — the metric the T2 setup ranks on — computed
    from fields already on the trade rather than by recomputing an indicator.

    Public, and imported by chart/decide.py, which takes the same decision live
    over a card list. Two definitions of one number would let a live pick and a
    backtested pick be ranked differently while both looked correct.

    None when there is no usable stop: such a signal cannot be sized or ranked,
    and must never be silently treated as the weakest rather than as unusable.
    """
    try:
        e = float(entry)
        s = float(stop) if stop is not None else 0.0
    except (TypeError, ValueError):
        return None
    if not s or e <= 0 or s <= 0:
        return None
    return ((e / s - 1.0) if side == 'long' else (s / e - 1.0)) * 100.0


# ── the ranking contract, shared with the live decide path ────────────────
# One name per way of scoring a day's candidates against each other. Kept in
# ONE table because backtest and live must rank identically or a validated
# result describes trades the box will never take.
#
# There is deliberately NO default. `vwap_extension` was the implicit one, and
# it is right for exactly one setup: T2, whose stop IS the session VWAP, so
# distance-to-stop is distance-from-VWAP. Applied to anything else it means
# "trade the widest stop", which is a rule nobody wrote down — it reshaped
# backtest #231 (OR + VWAP 09:35) into "the two widest opening ranges per day"
# and threw away 103 of 117 signals on a criterion the spec never mentions.
#
# So: a strategy that does not NAME a metric is not ranked. Taking every
# signal is the honest default, because it is the only one that does not
# invent a preference.
RANK_METRICS = {
    # distance from entry to the stop, in percent. For a VWAP-anchored stop
    # this is extension from VWAP (T2's spec). Descending = most extended.
    'vwap_extension': (lambda t: rank_metric(t['side'], t['entry'], t.get('stop')),
                       'desc'),
    # the same number, ascending — for setups whose edge is a TIGHT stop, where
    # the T2 ordering picks precisely against you.
    'tight_stop': (lambda t: rank_metric(t['side'], t['entry'], t.get('stop')),
                   'asc'),
    # the register's own conviction score, when the screener supplied one
    'reg_score': (lambda t: _num((t.get('ctx') or {}).get('score')), 'desc'),
    # honest cumulative RVOL measured at the strategy's window start
    'rvol': (lambda t: _num((t.get('ctx') or {}).get('rvol_day')), 'desc'),
}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def select_by_rank(closed: list, metric, direction, top_n: int = 0):
    """Keep the best `top_n` trades per day by `metric`. Returns (kept, info).

    EXTRACTED so the backtest and anything asking "which metric should this
    strategy rank by" run the SAME selection. A comparison built on a second
    implementation would be comparing two things, neither of which is what runs.

    No silent default: an unnamed metric raises and an unknown one raises.
    Ranking by the wrong metric silently reshapes the strategy —
    vwap_extension means "widest stop" for anything but a VWAP-anchored stop.
    """
    if not metric:
        raise ValueError(
            'rank_per_day needs an explicit metric — one of '
            + ', '.join(sorted(RANK_METRICS))
            + '. There is no default: ranking by the wrong metric silently '
              'reshapes the strategy (vwap_extension means "widest stop" '
              'for anything but a VWAP-anchored stop).')
    metric = str(metric)
    if metric not in RANK_METRICS:
        raise ValueError(f'unknown rank metric {metric!r} — known: '
                         + ', '.join(sorted(RANK_METRICS)))
    score_of, default_dir = RANK_METRICS[metric]
    direction = str(direction or default_dir).lower()
    if direction not in ('asc', 'desc'):
        raise ValueError(f"rank direction must be 'asc' or 'desc', got {direction!r}")
    sgn = -1.0 if direction == 'desc' else 1.0

    by_date: dict = {}
    for t in closed:
        sc = score_of(t)
        t.setdefault('ctx', {})['rank_metric'] = (
            round(sc, 6) if sc is not None else None)
        by_date.setdefault(t['date'], []).append(t)

    keep, dropped, unscored, late = [], 0, 0, 0
    for d, rows in by_date.items():
        # WITHIN A DECISION MOMENT, NEVER ACROSS THE DAY.
        #
        # Grouping the whole day and keeping the best `top_n` was a look-ahead
        # and a bad one: it ranked a 10:05 signal against a 13:20 signal and
        # kept the better. At 10:05 the 13:20 signal did not exist. Nobody
        # could have made that choice, so no result that depended on it was
        # ever reachable.
        #
        # A live desk decides bar by bar: it sees what has fired ON THIS BAR,
        # ranks those against each other, takes what its remaining allowance
        # lets it take, and then lives with having spent it. A better signal
        # three hours later is not an argument — the money is already in
        # something.
        #
        # So: signals are walked in TIME order, ranked only against others at
        # the same instant, and `top_n` is spent as a budget for the day. For a
        # clock setup — the two live ones fire in a single minute — every
        # signal shares one moment, so this is exactly the old behaviour and
        # the numbers do not move. For anything with a WINDOW (every scalp:
        # 10:00–13:30, 09:59–16:00) it is the difference between a result and
        # a wish.
        by_moment: dict = {}
        for t in rows:
            by_moment.setdefault(t.get('entry_ts') or 0, []).append(t)

        budget = top_n if top_n else None
        rank_seq = 0
        for _ts in sorted(by_moment):
            # best first for the chosen direction; ties broken by ticker so a
            # run is reproducible. Unscorable rows sort last either way and are
            # dropped explicitly, never treated as merely weakest.
            moment = sorted(by_moment[_ts], key=lambda t: (
                (sgn * t['ctx']['rank_metric']) if t['ctx'].get('rank_metric') is not None
                else float('inf'), t['symbol']))
            for t in moment:
                rank_seq += 1
                t['ctx']['rank_in_day'] = rank_seq
                if t['ctx'].get('rank_metric') is None:
                    dropped += 1
                    unscored += 1
                elif budget is not None and budget <= 0:
                    # Lost to the CLOCK, not to a better signal. Counted apart
                    # because the two say different things about a strategy:
                    # one is being out-ranked, the other is firing more often
                    # than the day's allowance can pay for.
                    dropped += 1
                    late += 1
                else:
                    keep.append(t)
                    if budget is not None:
                        budget -= 1

    return keep, {'metric': metric, 'direction': direction, 'top_n': top_n,
                  'kept': len(keep), 'dropped_by_rank': dropped,
                  'dropped_unscorable': unscored,
                  # Signals that lost to something that had already fired, not
                  # to something better. See the note above.
                  'dropped_budget_used': late}


def _et_date(ts_s: int) -> str:
    return pd.Timestamp(int(ts_s), unit='s', tz='UTC').tz_convert(cs._ET).strftime('%Y-%m-%d')


def _et_hm(ts_s: int) -> str:
    return (pd.Timestamp(int(ts_s), unit='s', tz='UTC')
            .tz_convert(cs._ET).strftime('%H:%M'))


def _scan_time(rctx: dict | None, day: str):
    """When the scanner first had this name on `day`, as an epoch second.

    THE LOOK-AHEAD NOBODY SEES.

    A register backtest evaluates the frozen list for a day and takes whatever
    the strategy fires — including a 09:45 entry in a stock the scanner did not
    surface until 10:00. In the backtest that is a trade. Live it is nothing at
    all: at 09:45 the name was not on the watchlist, no alert could have fired,
    and no order could have been placed. Counting it flatters every statistic in
    the run, and worst in exactly the strategies that trade earliest.

    `foundMinsFromOpen` is minutes from the 09:30 open, stamped by the scanner
    when a screener first matched the ticker and never moved afterwards
    (src/r0/registry.js). Negative means pre-market, so a name found at 08:00
    reads as -90 — those are available from the first bar and gate nothing.

    None when the row predates the field. A missing time must NOT become a
    guessed 09:30: that would silently pass every trade it was meant to catch,
    which is the failure mode this whole function exists to remove.
    """
    if not rctx:
        return None
    mins = rctx.get('foundMinsFromOpen')
    if mins is None:
        return None
    try:
        mins = float(mins)
    except (TypeError, ValueError):
        return None
    open_et = pd.Timestamp(f'{day} 09:30', tz=cs._ET)
    return int((open_et + pd.Timedelta(minutes=mins)).timestamp())


def _rvol_at(sym: str, day: str, feed: str, view: str, ref_hhmm: int,
             length: int = 20) -> float | None:
    """SMB-style In-Play RVOL for (sym, day), read causally AT `ref_hhmm` ET.

    qp `volume.rel_volume`: cumulative RTH volume from the 09:30 open through
    the bar, divided by the average cumulative volume at the SAME time-of-day
    over the prior `length` RTH sessions — the day-trader's "trading 5x its
    normal volume by now". This is NOT the register's ctx_rvol, which is
    TradingView's `relative_volume_intraday|5`: the relative volume of ONE
    5-minute bar at the ~09:36 capture (SHPH printed 0.02 on a genuine M&A
    gap day; LUCY printed 2940 on one bar). Computed on 5m bars — the
    primitive is timeframe-invariant — over a 45-calendar-day fetch so the
    20-session baseline exists. None = unverifiable (no prior sessions /
    no bars): the caller decides what that means.
    """
    import numpy as np
    bars, _ts, ctx = cs.prepare_bars(sym, '5m', 45, feed, view, day)
    if bars is None or not len(bars):
        return None
    _, _, lines = cs.overlay_arrays(
        bars, {'key': 'volume.rel_volume', 'source': 'close',
               'params': {'length': int(length)}}, ctx, causal=True)
    arr = lines[0][1]
    et = bars.index.tz_convert(cs._ET)
    hhmm = np.asarray(et.hour) * 100 + np.asarray(et.minute)
    on_day = np.asarray(et.strftime('%Y-%m-%d')) == day
    idx = np.nonzero(on_day & (hhmm <= int(ref_hhmm)))[0]
    for i in idx[::-1]:                     # last valid value at/before ref
        v = arr[i]
        if v == v:
            return float(v)
    return None


def _dates(spec: dict) -> list[str]:
    """Trading days (Mon-Fri) in [start, end]. Days without bars simply
    produce nothing when evaluated — no special-casing of holidays."""
    start, end = spec.get('start'), spec.get('end')
    if not start or not end:
        raise ValueError('spec needs start and end (YYYY-MM-DD)')
    days = pd.bdate_range(start, end)
    if len(days) == 0:
        raise ValueError(f'no trading days between {start} and {end}')
    return [d.strftime('%Y-%m-%d') for d in days]


def _pairs(spec: dict, strategy: dict | None = None) -> list[tuple[str, str]]:
    """(day, symbol) evaluation pairs. Symbols universe: same list every day.
    Register universe: the screener's frozen membership FOR that day. Tools
    universe: the same, unioned across the setup's own tools.

    `strategy` is optional so the pure-spec callers (and tests) still work; it
    is only read to default the tool list."""
    uni = spec.get('universe') or {}
    kind = uni.get('kind', 'symbols')
    if kind == 'symbols':
        syms = [s.strip().upper() for s in (uni.get('symbols') or []) if s and s.strip()]
        if not syms:
            raise ValueError('universe.symbols is empty')
        return [(d, s, {}) for d in _dates(spec) for s in syms]
    if kind in ('register', 'tools'):
        from chart import screener as sc
        register = uni.get('register', 'R1')

        if kind == 'tools':
            # The setup's own tools, expanded to one register per tool.
            #
            # This is the question worth asking of a setup: not "does it work
            # on some symbols" but "does it work on the stocks the tool that
            # will run it actually finds". A setup assigned to T2 backtested
            # over T1's picks measures a pairing that will never happen.
            #
            # The tools come from the spec when given and from the strategy
            # itself otherwise, so the default run of a setup is the one that
            # matches how it will be used.
            # Spec first, then the setup's own assignment. Being able to
            # override matters: "how would T2's setup have done on T7's picks"
            # is a real question, and it must not require editing the setup.
            tools = uni.get('tools') or (strategy or {}).get('tools') or []
            if not tools:
                raise ValueError(
                    'this setup is not assigned to any tool yet — set its tools, '
                    'or pick a universe explicitly')
            registers = [f'{t}:{register}' for t in tools]
        else:
            registers = [register]

        want = set(_dates(spec))
        # Union across the tools, per day. Two tools flagging the same name on
        # the same day is ONE evaluation: the setup either triggers on that
        # stock that day or it does not, and counting it twice would inflate
        # every statistic in proportion to how much the tools overlap.
        by_day: dict = {}
        seen_dates = set()
        for reg in registers:
            dates = [d for d in (sc.available_dates(reg) or []) if d in want]
            seen_dates.update(dates)
            for d in sorted(dates):
                rows = sc.register_rows(reg, d, full=True)
                if not rows.get('ok'):
                    raise ValueError(f'screener register fetch failed for {d}: '
                                     f'{rows.get("error", "unreachable")}')
                day = by_day.setdefault(d, {})
                for r in rows.get('rows') or []:
                    t = (r.get('ticker') or '').strip().upper()
                    # First tool to supply the row wins. The FULL frozen card
                    # rides along with every trade so results can be filtered by
                    # ANY register column. Dedup matters beyond tidiness: a
                    # second pair for the same symbol would slip the per-day
                    # attempt cap, which is enforced per pair, and the same name
                    # could double-trade.
                    if t and t not in day:
                        day[t] = dict(r, _tool=reg.split(':')[0] if ':' in reg else None)

        if not seen_dates:
            raise ValueError(f'no {register} register dates between '
                             f'{spec.get("start")} and {spec.get("end")} for '
                             f'{", ".join(registers)} — is the screener reachable '
                             f'and does it have frozen days in range?')

        pairs = [(d, t, r) for d in sorted(by_day) for t, r in by_day[d].items()]
        if not pairs:
            raise ValueError(f'{", ".join(registers)} has no tickers in range')
        return pairs
    raise ValueError(f'unknown universe kind {kind!r}')


def _resolve_strategies(spec: dict) -> list:
    """One or MORE strategies for a single run.

    A setup whose selection step ranks across the whole universe usually has a
    long book and a short book, and the rank is taken over BOTH ("top 2 across
    the entire universe", not top 2 longs and top 2 shorts). Running them as
    two separate backtests would rank inside each side and select different
    names. `strategy_ids: [a, b]` (or `strategies: [{...}, {...}]`) evaluates
    every one of them on the same pair and pools the trades, so the per-day
    ranking sees the day the way the spec describes it.
    """
    many = spec.get('strategies')
    if isinstance(many, list) and many:
        out = []
        for s in many:
            out.append(_resolve_strategy({'strategy': s} if isinstance(s, dict)
                                         else {'strategy_id': s}))
        return out
    ids = spec.get('strategy_ids')
    if isinstance(ids, list) and ids:
        return [_resolve_strategy({'strategy_id': i}) for i in ids]
    return [_resolve_strategy(spec)]


def _resolve_strategy(spec: dict) -> dict:
    s = spec.get('strategy')
    if isinstance(s, dict) and (s.get('entry') or s.get('exit')):
        return s
    sid = spec.get('strategy_id')
    if sid:
        s = store.get_strategy(int(sid))
        if s:
            return s
    raise ValueError('spec needs strategy (inline) or a valid strategy_id')


def _fills(t: dict, closed: bool):
    """A trade's CLOSING orders as (fraction, pps) — one per scale-out leg
    plus the runner. Each partial is a separate broker order, so Trade The
    Pool's per-order min-profit rule and per-order commission apply to each.
    For an OPEN position only the banked partials are realized (no runner)."""
    sgn = 1.0 if t['side'] == 'long' else -1.0
    entry = t['entry']
    fills = []
    used = 0.0
    for g in (t.get('legs') or []):
        fr = float(g['fraction']); used += fr
        fills.append((fr, sgn * (float(g['price']) - entry)))
    if closed and t.get('exit') is not None:
        runner = max(0.0, 1.0 - used)
        if runner > 1e-9:
            fills.append((runner, sgn * (t['exit'] - entry)))
    return fills


def _ttp_block(closed: list, opens: list, spec: dict) -> dict | None:
    """Prop-firm accounting (Trade The Pool defaults, all overridable):
    per-share commission with a per-order minimum, dollar P&L for a fixed
    share size, and the MIN-PROFIT rule — winners under `min_profit_ps`
    $/share do NOT count toward the profit target; losses always count.

    A scale-out is ONE trade, one position: the min-profit rule is tested on
    the trade's AVERAGE per-share P&L across all fills (not per leg), and it
    counts as a single win/loss after the whole position closes. Commissions
    are still per ORDER — a 3-exit scale-out pays 1 entry + 3 exit orders —
    because each fill is a real order at the broker."""
    fps = float(spec.get('fee_per_share', 0) or 0)
    fmin = float(spec.get('fee_min', 0) or 0)
    mps = spec.get('min_profit_ps')
    if not (fps or fmin or mps is not None):
        return None
    shares = max(1.0, float(spec.get('shares', 100) or 100))
    mps = float(0.10 if mps is None else mps)
    # commission for an order of `sz` shares (per-share, floored at the minimum)
    order_fee = (lambda sz: max(fps * sz, fmin)) if (fps or fmin) else (lambda sz: 0.0)
    fees = net = counted = 0.0
    below = 0
    for t, is_closed in [(t, True) for t in closed] + [(t, False) for t in opens]:
        fills = _fills(t, is_closed)
        f_trade = order_fee(shares)        # entry order (whole size)
        realized = sum(fr for fr, _ in fills)     # 1.0 for a closed trade
        gross = 0.0
        for fr, pps in fills:
            gross += shares * fr * pps
            f_trade += order_fee(shares * fr)     # each partial/runner = one order
        # AVERAGE per-share P&L of the whole position → the min-profit test
        avg_pps = (gross / (shares * realized)) if realized > 1e-9 else 0.0
        net_trade = gross - f_trade
        fees += f_trade; net += net_trade
        if 0 < avg_pps < mps:              # the TRADE's blended win is too small
            below += 1                     # wasted win → 0 credit toward target
        else:
            counted += net_trade
    return {'shares': shares, 'fee_per_share': fps, 'fee_min_per_order': fmin,
            'min_profit_ps': mps, 'fees_usd': round(fees, 2),
            'net_pnl_usd': round(net, 2),
            'counted_pnl_usd': round(counted, 2),
            'wins_below_min': below}


def _challenge_block(ledger: list, equity0: float, spec: dict) -> dict | None:
    """Funded-account rules: did it reach +target% BEFORE it ever hit -limit%?

    "Max drawdown 1.47%" does not answer that. It is the deepest fall anywhere
    in the run, with no statement of WHEN — a strategy can end +9% having gone
    -4% in week one, and a funded account would have closed it in week one. The
    only question a challenge asks is which line was touched first.

    Two honest limits, both reported rather than hidden:

    1) OPEN POSITIONS ARE NOT MARKED TO MARKET. The stored trades hold entry
       and exit, not the path between, so a position that swung -2% and came
       back is invisible to a closed-trade curve. This block therefore ALSO
       walks a worst case: at every moment, assume every position still open
       stops out at once. That is the floor the account could have touched
       with the stops it actually had, and it is the number a trailing
       drawdown rule would have caught. Reported as `worst_case_dd_pct`;
       `closed_dd_pct` is the optimistic one.

    2) DAILY loss limits and minimum trading days are NOT modelled. A run that
       passes here can still fail a prop firm on a rule this does not know.

    `basis`: 'start' measures the fall from the opening balance (a static max
    loss), 'peak' from the highest balance reached (a trailing drawdown).
    Firms use both and they fail at different moments, so it is asked for
    rather than assumed.
    """
    if not ledger or equity0 <= 0:
        return None
    ch = spec.get('challenge') or None
    if not isinstance(ch, dict):
        return None
    try:
        target_pct = float(ch.get('target_pct') or 0)
        limit_pct = float(ch.get('max_dd_pct') or 0)
    except (TypeError, ValueError):
        return None
    if target_pct <= 0 or limit_pct <= 0:
        return None
    basis = str(ch.get('basis') or 'start').lower()
    if basis not in ('start', 'peak'):
        basis = 'start'

    # One timeline of moments where the account's value can change: a position
    # opening adds risk that could be lost, a position closing books its P&L
    # and releases that risk. Sorted by time, exits before entries at the same
    # instant — money already made is available to the next trade, which is
    # how the sizing loop above treats it too.
    events = []
    for t0, t1, net, risk, date, sym in ledger:
        events.append((t0, 1, risk, 0.0, date, sym))       # open:  risk on
        events.append((t1, 0, -risk, net, date, sym))      # close: risk off, P&L in
    events.sort(key=lambda e: (e[0], e[1]))

    equity = equity0            # realized only
    peak = equity0
    open_risk = 0.0
    closed_dd = worst_dd = 0.0
    peak_profit = 0.0
    first_hit = None            # 'target' | 'drawdown'
    hit_on = hit_sym = None
    for ts, _kind, d_risk, pnl, date, sym in events:
        equity += pnl
        open_risk += d_risk
        open_risk = max(0.0, open_risk)
        peak = max(peak, equity)
        ref = equity0 if basis == 'start' else peak
        # the floor this moment could have touched: every open stop hit at once
        floor = equity - open_risk
        dd_closed = max(0.0, (ref - equity) / ref * 100.0)
        dd_worst = max(0.0, (ref - floor) / ref * 100.0)
        closed_dd = max(closed_dd, dd_closed)
        worst_dd = max(worst_dd, dd_worst)
        peak_profit = max(peak_profit, (equity / equity0 - 1.0) * 100.0)
        if first_hit is None:
            # Drawdown is checked FIRST at each moment, and on the worst case.
            # A run that touched both lines in the same instant failed: the
            # firm closes the account on the breach whatever happened after.
            if dd_worst >= limit_pct:
                first_hit, hit_on, hit_sym = 'drawdown', date, sym
            elif (equity / equity0 - 1.0) * 100.0 >= target_pct:
                first_hit, hit_on, hit_sym = 'target', date, sym

    return {
        'target_pct': target_pct,
        'max_dd_pct': limit_pct,
        'basis': basis,
        'result': first_hit or 'neither',
        'hit_on': hit_on,
        'hit_symbol': hit_sym,
        'peak_profit_pct': round(peak_profit, 2),
        'closed_dd_pct': round(closed_dd, 2),
        'worst_case_dd_pct': round(worst_dd, 2),
        'final_pct': round((equity / equity0 - 1.0) * 100.0, 2),
        # said out loud, because a pass here is not a pass at a prop firm
        'not_modelled': 'intraday marks on open positions (worst case assumes '
                        'every open stop hits at once), daily loss limit, '
                        'minimum trading days, spread and slippage',
    }


def _account_block(closed: list, spec: dict) -> dict | None:
    """REAL-MONEY accounting: a fixed account risking a fixed % per trade.

    Position size comes from the STOP, not from a share count: risking R
    dollars with a stop D dollars per share below the entry buys R/D shares,
    so every trade that stops out loses the SAME % of the account — which is
    what "0.5% risk per trade" means. Consequences, all deliberate:

    - A trade with NO stop, or a stop at/through the entry, cannot be sized
      and is EXCLUDED (counted in `unsized`) — never silently sized at 1 share.
    - Equity COMPOUNDS in trade order: each trade is sized on the equity that
      existed when it was entered (P&L of everything that closed before it),
      so a losing streak shrinks size the way a real account does.
    - PER-TRADE CAP (`max_position_pct`): no single position may exceed N% of
      equity, the same rule the screener applies live before it sends an order
      (`maxPositionPct`). This is the one that decides how many names the day
      can afford. Without it a tight stop buys the whole account — ALNY's
      $0.63 stop took $99,966 of a $100k balance in backtest #237 — and the
      93 signals behind it were skipped for lack of capital, in ARRIVAL ORDER
      rather than by quality. Applied BEFORE the portfolio cap, and counted in
      `size_capped_by_position`. Absent = no cap, so old runs are unchanged.
    - CAPITAL CAP, PORTFOLIO-WIDE: you cannot buy more stock than you have
      money for — and that budget is shared by every position open at the same
      time. Buying power at an entry is `max_leverage` x equity MINUS the
      notional of the positions still open at that moment (a register backtest
      runs many symbols on the same day, so concurrency is the norm, not the
      exception). Shares are capped to what is LEFT; if nothing is left the
      trade is skipped entirely (`skipped_no_capital`) — the real account
      could not have taken it. Default max_leverage 1.0 = CASH (a $100k
      account never holds more than $100k of stock, across ALL names). A tight
      stop implies a huge share count — that trade is capped and then risks
      LESS than `risk_pct`, which is the real-world outcome, not a bug. Capped
      trades are counted in `size_capped_by_leverage`. Set max_leverage 2/4
      only if the account really has that margin.
    - Fees use the same per-share/min-per-order model as the TTP block, on
      the ACTUAL sized shares.
    - Scale-outs: each leg's fraction of the sized position closes at the
      leg price; the runner closes at the trade's exit.
    """
    if not closed:
        return None
    try:
        equity0 = float(spec.get('account_equity') or 0)
    except (TypeError, ValueError):
        equity0 = 0.0
    if equity0 <= 0:
        return None                     # feature is opt-in
    try:
        risk_pct = float(spec.get('risk_pct') or 0)
    except (TypeError, ValueError):
        risk_pct = 0.0
    if risk_pct <= 0:
        return None
    lev = float(spec.get('max_leverage', 1) or 1)   # 1.0 = cash, no margin
    # PER-TRADE position cap, the same setting the screener applies live
    # (`maxPositionPct` in src/setups/risk.js). Without it a tight stop buys a
    # position the size of the whole account — ALNY took $99,966 of a $100k
    # balance on one trade in backtest #237 — and every later signal that day
    # is skipped for lack of capital, by ARRIVAL ORDER rather than by quality.
    # The leverage cap alone cannot express this: it is portfolio-wide, so it
    # is silent until the account is already full.
    try:
        max_pos_pct = float(spec.get('max_position_pct') or 0)
    except (TypeError, ValueError):
        max_pos_pct = 0.0
    if max_pos_pct <= 0:
        max_pos_pct = 0.0               # absent = no per-trade cap (unchanged)
    fps = float(spec.get('fee_per_share', 0) or 0)
    # the panel posts `fee_min`; `fee_min_per_order` is the block's own output
    # name. Accept BOTH or the per-order minimum silently reads as $0 here
    # while the TTP block (which reads `fee_min`) charges it.
    fmin = float(spec.get('fee_min', spec.get('fee_min_per_order', 0)) or 0)
    order_fee = (lambda sz: max(fps * sz, fmin)) if (fps or fmin) else (lambda sz: 0.0)
    # the prop firm's min-profit-per-share rule, applied at THIS account's size
    try:
        mps = spec.get('min_profit_ps')
        mps = None if mps is None else float(mps)
        if mps is not None and mps <= 0:
            mps = None
    except (TypeError, ValueError):
        mps = None
    counted_usd = wasted_usd = 0.0
    # (entry_ts, exit_ts, net, risk_usd, date, symbol) per SIZED trade — the
    # timeline the challenge block walks. Collected here rather than
    # recomputed later so both read the same sizing decisions.
    ledger: list = []
    wasted_n = 0

    rows = sorted(closed, key=lambda t: (t.get('entry_ts') or 0))
    # (exit_ts, pnl, notional) of positions entered but not yet closed at the
    # moment we size the next one. `notional` is what makes the capital cap
    # PORTFOLIO-wide: concurrent positions share one balance.
    pending: list = []
    equity = equity0
    peak = equity0
    maxdd = 0.0
    fees_tot = pnl_tot = 0.0
    unsized = capped = no_capital = pos_capped = 0
    max_concurrent = 0
    wins = 0
    sized_n = 0
    curve = []
    for t in rows:
        # credit everything that CLOSED before this entry → sizing equity
        et_in = t.get('entry_ts') or 0
        still = []
        for xt, p, nt in pending:
            if xt <= et_in:
                equity += p
            else:
                still.append((xt, p, nt))
        pending = still
        open_notional = sum(nt for _, _, nt in pending)
        entry = float(t['entry'])
        stop = t.get('stop')
        sgn = 1.0 if t['side'] == 'long' else -1.0
        per_share_risk = (entry - float(stop)) * sgn if stop is not None else None
        if not per_share_risk or per_share_risk <= 0 or entry <= 0 or equity <= 0:
            unsized += 1
            t.setdefault('ctx', {})['acct_note'] = 'no stop — not sized'
            continue
        # WHOLE SHARES, because that is what the broker fills. The screener
        # floors the count before it sends an order (src/setups/risk.js) and
        # the bridge REFUSES a fractional quantity outright, so a fraction here
        # is a position the live system would never take. Floored, never
        # rounded: rounding up would risk more than the trade was sized for.
        # Only ever makes the simulation smaller, never larger.
        #
        # Floored AFTER EACH CAP rather than once at the end, because "under
        # one share" has three different causes and the report has to name the
        # right one. A single check at the bottom can only guess: backtest #238
        # told 67 trades "one share risks $0.19, more than the 0.5% of equity
        # this trade may lose" — arithmetic nonsense ($0.19 against a $499
        # budget) for trades whose real problem was that the account was
        # already full. A wrong diagnosis sends you to change the wrong knob.
        shares = math.floor((equity * risk_pct / 100.0) / per_share_risk)
        if shares < 1:
            unsized += 1
            t.setdefault('ctx', {})['acct_note'] = (
                f'one share risks ${per_share_risk:,.2f}, more than the '
                f'{risk_pct}% of equity ({equity * risk_pct / 100.0:,.0f}) '
                f'this trade may lose')
            continue
        # PER-TRADE CAP, applied BEFORE the portfolio one. Order matters: cap
        # this trade first, then measure what is left for the rest of the day.
        # Reversed, the first name would still swallow the balance and the cap
        # would only ever bind on trades that had already been squeezed.
        #
        # Measured against LIVE equity, while the screener measures against the
        # configured account size. Same rule; the sim just knows what the
        # balance actually is at that moment.
        if max_pos_pct:
            cap_sh = math.floor((equity * max_pos_pct / 100.0) / entry)
            if shares > cap_sh:
                shares = cap_sh
                pos_capped += 1
            if shares < 1:
                unsized += 1
                t.setdefault('ctx', {})['acct_note'] = (
                    f'one share costs ${entry:,.2f} — more than the '
                    f'{max_pos_pct}% of equity one position may hold')
                continue
        # buying power LEFT after the positions already open (portfolio-wide)
        room = equity * lev - open_notional
        max_sh = math.floor(room / entry) if room > 0 else 0
        if max_sh < 1:
            # Not "no stop" and not a risk-budget problem: the balance is
            # committed to positions still open. This is the count that says
            # the day ran out of money, and it is the one to watch.
            no_capital += 1
            t.setdefault('ctx', {})['acct_note'] = (
                f'no buying power left — ${max(0.0, room):,.0f} free will not '
                f'buy one share at ${entry:,.2f}')
            continue
        if shares > max_sh:
            shares = max_sh
            capped += 1
        shares = float(shares)
        # gross P&L over every fill (legs + runner), fees per ORDER
        gross = 0.0
        fee = order_fee(shares)                  # the entry order
        for fr, pps in _fills(t, True):
            gross += shares * fr * pps
            fee += order_fee(shares * fr)
        net = gross - fee
        fees_tot += fee
        pnl_tot += net
        sized_n += 1
        if net > 0:
            wins += 1
        # PER-TRADE DETAIL — written into ctx (the only per-trade field the
        # store persists as JSON), so it survives a reload and lands in the
        # CSV automatically as ctx_* columns.
        _c = t.setdefault('ctx', {})
        _c['acct_shares'] = round(shares, 2)
        # the stop PRICE, not just the dollars at risk: the trade journal has
        # to show the level the position was actually working against, and the
        # store keeps no stop column (ctx is the only per-trade JSON persisted)
        _c['acct_stop'] = round(float(stop), 4)
        _c['acct_risk_usd'] = round(shares * per_share_risk, 2)
        _c['acct_pnl_usd'] = round(net, 2)
        _c['acct_fees_usd'] = round(fee, 2)
        _c['acct_equity_before'] = round(equity, 2)
        _c['acct_notional_usd'] = round(shares * entry, 2)
        _c['acct_r_multiple'] = (round(gross / (shares * per_share_risk), 2)
                                 if per_share_risk > 0 else None)
        _c['acct_open_notional_usd'] = round(open_notional + shares * entry, 2)
        # PROP-FIRM MIN-PROFIT, AT THE ACCOUNT'S OWN SIZE. The rule is per
        # SHARE, so whether a win clears it does not depend on size at all —
        # but the money it costs you does. The TTP block tests it at a flat 100
        # shares, where a wasted win looks like $3; the same trade at the
        # account's real 9,000 shares withholds several hundred dollars of
        # credit. Reporting only the 100-share version understates the rule by
        # the size ratio, which on a $100k account is two orders of magnitude.
        #
        # It does NOT change net P&L — the money is yours either way. What it
        # changes is how much counts toward a funded account's profit target.
        if mps is not None:
            realized = sum(fr for fr, _ in _fills(t, True))
            avg_pps = (gross / (shares * realized)) if realized > 1e-9 else 0.0
            _c['acct_pnl_per_share'] = round(avg_pps, 4)
            if 0 < avg_pps < mps:
                wasted_n += 1
                wasted_usd += net
                _c['acct_no_credit'] = True
            else:
                counted_usd += net
        ledger.append((et_in, t.get('exit_ts') or et_in, net,
                       shares * per_share_risk, t.get('date'), t.get('symbol')))
        pending.append((t.get('exit_ts') or et_in, net, shares * entry))
        max_concurrent = max(max_concurrent, len(pending))
        # equity curve marked when the trade closes (peak/DD on realized)
        realized_now = equity + sum(p for _, p, _ in pending)
        peak = max(peak, realized_now)
        if peak > 0:
            maxdd = max(maxdd, (peak - realized_now) / peak)
        curve.append(round(realized_now, 2))
    equity += sum(p for _, p, _ in pending)      # settle the tail
    challenge = _challenge_block(ledger, equity0, spec)
    return {
        'account_equity_start': round(equity0, 2),
        'risk_pct': risk_pct,
        'max_leverage': lev,
        'max_position_pct': max_pos_pct or None,
        **({'challenge': challenge} if challenge else {}),
        'equity_end': round(equity, 2),
        'net_pnl_usd': round(pnl_tot, 2),
        'return_pct': round((equity / equity0 - 1.0) * 100.0, 2),
        'fees_usd': round(fees_tot, 2),
        'trades_sized': sized_n,
        'win_rate_pct': round(100.0 * wins / sized_n, 1) if sized_n else None,
        'avg_pnl_usd': round(pnl_tot / sized_n, 2) if sized_n else None,
        'max_drawdown_pct': round(100.0 * maxdd, 2),
        'unsized_no_stop': unsized,
        'size_capped_by_leverage': capped,
        'size_capped_by_position': pos_capped,
        'skipped_no_capital': no_capital,
        'max_concurrent_positions': max_concurrent,
        'fee_per_share': fps,
        'fee_min_per_order': fmin,
        'equity_curve': curve[-400:],
        # None when no min-profit rule was set: absent and zero mean different
        # things, and a reader must not have to tell them apart from a 0.
        'min_profit_ps': mps,
        'counted_pnl_usd': (round(counted_usd, 2) if mps is not None else None),
        'no_credit_pnl_usd': (round(wasted_usd, 2) if mps is not None else None),
        'no_credit_wins': (wasted_n if mps is not None else None),
    }


def _summary(closed: list, opens: list, n_pairs: int, errors: list,
             all_dates: list | None = None, cost_bps: float = 0.0,
             spec: dict | None = None, coverage: dict | None = None) -> dict:
    out = {'pairs': n_pairs, 'trades': len(closed), 'open_trades': len(opens),
           'errors': len(errors), 'error_samples': errors[:10],
           'cost_bps_per_side': cost_bps, 'dates': list(all_dates or [])}
    if coverage is not None:
        out['coverage'] = coverage
    if closed:
        rets = [t['ret'] for t in closed]
        wins = sum(1 for r in rets if r > 0)
        by = {}
        for t in closed:
            by[t['reason']] = by.get(t['reason'], 0) + 1
        # equity curve: cumulative % return in exit order; max drawdown on it
        seq = sorted(closed, key=lambda t: t['exit_ts'])
        curve, cum, peak, maxdd = [], 0.0, 0.0, 0.0
        for t in seq:
            cum += t['ret']
            peak = max(peak, cum)
            maxdd = max(maxdd, peak - cum)
            curve.append({'time': int(t['exit_ts']), 'value': round(100.0 * cum, 3)})
        out.update({
            'wins': wins,
            'win_rate': round(100.0 * wins / len(closed), 1),
            'avg_return_pct': round(100.0 * sum(rets) / len(rets), 3),
            'total_return_pct': round(100.0 * sum(rets), 3),
            'max_drawdown_pct': round(100.0 * maxdd, 3),
            'exits_by': by,
            'equity_curve': curve,
        })
        # Chan-style DAILY metrics: build the daily return series over ALL
        # evaluated days (flat days = 0 — leaving them out inflates Sharpe),
        # then annualized Sharpe (√252) and max-drawdown DURATION in days.
        if all_dates:
            daily = {d: 0.0 for d in all_dates}
            for t in closed:
                daily[t['date']] = daily.get(t['date'], 0.0) + t['ret']
            vals = [daily[d] for d in sorted(daily)]
            n = len(vals)
            mean = sum(vals) / n
            var = sum((v - mean) ** 2 for v in vals) / (n - 1) if n > 1 else 0.0
            sd = var ** 0.5
            out['sharpe'] = round(mean / sd * (252 ** 0.5), 2) if sd > 1e-12 else None
            cum = peak = 0.0
            run = worst = 0
            for v in vals:
                cum += v
                if cum >= peak - 1e-12:
                    peak = cum; run = 0
                else:
                    run += 1; worst = max(worst, run)
            out['max_dd_days'] = worst
    ttp = _ttp_block(closed, opens, spec or {})
    if ttp:
        out['ttp'] = ttp
    acct = _account_block(closed, spec or {})
    if acct:
        out['account'] = acct
    return out


def run(spec: dict, progress_cb=None) -> dict:
    """Execute the backtest. Returns {'summary', 'trades'} — `trades` rows are
    store-shaped (see store.add_bt_trades). Raises ValueError on a bad spec."""
    strategies = _resolve_strategies(spec)
    # `or` (not dict defaults): the UI can send '' for an untouched select, and
    # an empty feed/tf must NOT reach the loaders as a mystery value.
    tf = spec.get('tf') or '5m'
    feed = spec.get('feed') or 'polygon'
    view = spec.get('view') or 'all'
    # THE DEFAULT IS THE DESK, because a backtest's whole job is to tell you
    # what this strategy would have done in the account you actually trade.
    # 'close' — the old default — books every entry at a price no order can
    # reach, and every result it ever produced was better than the same trades
    # would have been. A default that flatters is not a neutral choice.
    fill = spec.get('fill') or 'desk'
    base_days = int(spec.get('days', 3) or 3)  # evaluate() auto-extends warm-up
    # transaction costs (Chan ch.3: costs flip marginal strategies negative —
    # a backtest without them lies). Fractional cost per SIDE in basis points
    # (spread + slippage + commission); a round trip pays it twice.
    cost = float(spec.get('cost_bps', 0.0) or 0.0) / 10000.0
    # WHICH tools' picks the run is measured on is a property of the RUN, not
    # of one book: `strategies` can hold a long book and a short book, and both
    # are evaluated on every pair. Passing only the first book's assignment
    # would silently deny the second its own universe, so the tool lists are
    # unioned, order preserved (the first book's tools lead). `_pairs` still
    # lets spec.universe.tools override, and still raises when nothing is
    # assigned. Before this, `run()` passed a name that no longer existed after
    # the multi-book refactor — every 'tools' run died with UnboundLocalError.
    _tools, _seen = [], set()
    for st in strategies:
        for t in (st.get('tools') or []):
            if t not in _seen:
                _seen.add(t)
                _tools.append(t)
    pairs = _pairs(spec, {'tools': _tools})

    closed, opens, errors = [], [], []
    # COVERAGE accounting — "1 trade" is uninterpretable unless the run also
    # says how much of the universe was ACTUALLY evaluated. A pair whose feed
    # returns zero bars is not an error and produces no trade; before this
    # block it vanished silently, which can make a thin feed (alpaca IEX on
    # small caps) look like a strategy that never fires.
    cov = {'pairs': len(pairs), 'evaluated': 0, 'no_data': 0,
           'no_data_samples': [], 'signals_on_day': 0, 'signal_pairs': 0,
           'traded_pairs': 0, 'tf': tf, 'feed': feed, 'fill': fill}
    # PER SCANNING TOOL. With several screeners merged ('*:R1'), the tools do
    # NOT contribute equally: one with months of frozen registers supplies
    # nearly every pair while a tool switched on last week supplies a handful.
    # Without this the run reads as a seven-way comparison when it is really
    # one tool plus noise. Counted here, per source, so the report can say so.
    by_src: dict = {}
    for _d, _s, _rc in pairs:
        sid = ((_rc or {}).get('source') or 'symbols')
        e = by_src.setdefault(sid, {'pairs': 0, 'days': set(), 'evaluated': 0,
                                    'traded': 0, 'trades': 0,
                                    'name': (_rc or {}).get('source_name') or sid})
        e['pairs'] += 1
        e['days'].add(_d)
    # THE WATCHLIST GATE, ON BY DEFAULT.
    #
    # A trade the strategy took before the scanner had found the stock is not a
    # trade — no alert could have fired and no order could have been placed. It
    # is on by default because a backtest whose default is the optimistic
    # reading is a backtest that will be believed and should not be; pass
    # `scan_gate: false` to see the old, look-ahead numbers deliberately.
    #
    # `symbols` universes have no scanner and no scan time, so this is a no-op
    # there rather than a gate that silently drops everything.
    scan_gate = spec.get('scan_gate', True) is not False
    cov['scan_gate'] = bool(scan_gate)

    # In-Play universe filter (opt-in): the book's screener precondition
    # "RVOL > 5" measured HONESTLY — qp rel_volume at the strategy's session
    # start, not the register's one-bar TradingView snapshot. A pair below the
    # threshold, or unverifiable (no prior sessions), is not evaluated; both
    # are counted separately so the exclusion is never silent.
    try:
        min_rvol = float(spec.get('min_rvol'))
        if min_rvol <= 0:
            min_rvol = None
    except (TypeError, ValueError):
        min_rvol = None
    # the rvol reference time comes from the EARLIEST session window in the
    # run — with a long and a short book the two share a decision time, and if
    # they ever differ the earlier one is the honest place to measure
    _wins = [int((st.get('risk') or {}).get('window_start') or 0)
             for st in strategies]
    _wins = [w for w in _wins if w] or [1000]
    rv_ref = min(_wins)
    if min_rvol is not None:
        cov['rvol_min'] = min_rvol
        cov['rvol_at'] = rv_ref
        cov['rvol_below'] = 0
        cov['rvol_unknown'] = 0
        cov['rvol_samples'] = []
    bar_counts = []
    for i, (day, sym, rctx) in enumerate(pairs):
        _src = by_src.get((rctx or {}).get('source') or 'symbols')
        # WHEN this name became available to trade. Computed once per pair
        # rather than per strategy: it is a fact about the scanner's day, not
        # about the rule being tested.
        _scan_at = _scan_time(rctx, day) if scan_gate else None
        if scan_gate and rctx and _scan_at is None:
            cov['scan_time_unknown'] = cov.get('scan_time_unknown', 0) + 1
        if min_rvol is not None:
            try:
                rv = _rvol_at(sym, day, feed, view, rv_ref)
            except Exception:  # noqa: BLE001 — a bad fetch = unverifiable
                rv = None
            if rv is None or rv < min_rvol:
                cov['rvol_unknown' if rv is None else 'rvol_below'] += 1
                if len(cov['rvol_samples']) < 12:
                    cov['rvol_samples'].append(
                        f'{day} {sym} rvol=' + ('?' if rv is None else f'{rv:.1f}'))
                if progress_cb:
                    progress_cb((i + 1) / len(pairs))
                continue
            # the HONEST number rides with every trade of the pair, next to
            # the register's snapshot ctx_rvol, so reports can compare them
            rctx = {**(rctx or {}), 'rvol_day': round(rv, 2)}
        # EVERY strategy in the run is evaluated on this pair. One run can
        # carry a long book and a short book so that a per-day ranking sees
        # the whole day — "top 2 across the entire universe" is not the same
        # as top 2 longs plus top 2 shorts.
        took = False          # did ANY strategy trade this pair?
        counted = False       # count the pair as evaluated once, not per strategy
        for strategy in strategies:
            side = strategy.get('side', 'long')
            sname = strategy.get('name') or 'strategy'
            try:
                r = strat.evaluate(strategy, sym, tf, base_days, feed=feed,
                                   view=view, asof=day, fill=fill,
                                   rules=spec.get('rules'))
                if not (r.get('ok') and r.get('bars')):
                    continue
                if not counted:
                    counted = True
                    cov['evaluated'] += 1
                    if _src:
                        _src['evaluated'] += 1
                    bar_counts.append(int(r['bars']))
                sigs = sum(1 for e in (r.get('entries') or [])
                           if _et_date(e['time']) == day)
                if sigs:
                    cov['signal_pairs'] += 1
                    cov['signals_on_day'] += sigs
                # WHY a fired signal didn't become a trade (window, cap,
                # unpriceable stop, …) — so "N signals → 0 traded" self-explains
                for _reason, _cnt in (r.get('entry_drops') or {}).items():
                    ed = cov.setdefault('entry_drops', {})
                    ed[_reason] = ed.get(_reason, 0) + int(_cnt)
                for t in r.get('trades') or []:
                    if _et_date(t['entry_ts']) != day:      # day-slice honesty
                        continue
                    # Not on the watchlist yet — see _scan_time.
                    if scan_gate and _scan_at is not None and t['entry_ts'] < _scan_at:
                        cov['before_scan'] = cov.get('before_scan', 0) + 1
                        if len(cov.setdefault('before_scan_samples', [])) < 12:
                            cov['before_scan_samples'].append(
                                f'{day} {sym} entry {_et_hm(t["entry_ts"])} '
                                f'< found {_et_hm(_scan_at)}')
                        continue
                    took = True
                    nlegs = len(t.get('legs') or [])
                    cov['scaleout_legs'] = cov.get('scaleout_legs', 0) + nlegs
                    if nlegs:
                        cov['scaleout_trades'] = cov.get('scaleout_trades', 0) + 1
                    # slippage cost per SIDE: entry + every exit fill (each
                    # partial + the runner). Single exit → 2 sides as before.
                    closed.append({'date': day, 'symbol': sym, 'side': side,
                                   'entry_ts': t['entry_ts'], 'exit_ts': t['exit_ts'],
                                   'entry': t['entry'], 'exit': t['exit'],
                                   'stop': t.get('stop'),
                                   'ret': t['ret'] - (2.0 + nlegs) * cost,
                                   'reason': t['reason'],
                                   # diagnostics ride in ctx (no schema change)
                                   # THE PRICE THE DECISION USED, beside the
                                   # price the trade got. They differ only under
                                   # the 'desk' fill model, and where they differ
                                   # the difference is the execution gap — the
                                   # whole reason that model exists. Dropping it
                                   # here left the gap computable and unreadable.
                                   'ctx': {**(rctx or {}),
                                           'decided': t.get('decided'),
                                           'drop_pct': t.get('drop_pct'),
                                           'strategy': sname},
                                   'legs': t.get('legs') or []})
                ot = r.get('open_trade')
                if (ot and _et_date(ot['time']) == day
                        and scan_gate and _scan_at is not None
                        and ot['time'] < _scan_at):
                    cov['before_scan'] = cov.get('before_scan', 0) + 1
                    ot = None
                if ot and _et_date(ot['time']) == day:
                    took = True
                    nlegs = len(ot.get('legs') or [])
                    cov['scaleout_legs'] = cov.get('scaleout_legs', 0) + nlegs
                    if nlegs:
                        cov['scaleout_trades'] = cov.get('scaleout_trades', 0) + 1
                    opens.append({'date': day, 'symbol': sym, 'side': side,
                                  'entry_ts': ot['time'], 'exit_ts': None,
                                  'entry': ot['entry'], 'exit': None,
                                  'stop': ot.get('stop'),
                                  # entry side + each banked partial (runner open)
                                  'ret': ot['ret_pct'] / 100.0 - (1.0 + nlegs) * cost,
                                  'reason': 'open',
                                  'ctx': {**(rctx or {}),
                                          'decided': ot.get('decided'),
                                          'drop_pct': ot.get('drop_pct'),
                                          'strategy': sname},
                                  'legs': ot.get('legs') or []})
            except Exception as e:  # noqa: BLE001 — one bad pair must not kill the run
                errors.append(f'{day} {sym} [{sname}]: {e}')
        if not counted:
            cov['no_data'] += 1
            if len(cov['no_data_samples']) < 12:
                cov['no_data_samples'].append(f'{day} {sym}')
        if took:
            cov['traded_pairs'] += 1
            if _src:
                _src['traded'] += 1
        if progress_cb:
            progress_cb((i + 1) / len(pairs))

    if bar_counts:
        bar_counts.sort()
        cov['bars_median'] = int(bar_counts[len(bar_counts) // 2])
    # PER-DAY RANKING (opt-in). Some setups are not "take every signal" — they
    # score the day's signals against EACH OTHER and trade only the strongest
    # few. That is a cross-symbol decision, so it cannot live in a strategy:
    # evaluate() sees one symbol at a time and has no idea what the others did.
    # It belongs here, where the whole day is in hand.
    #   spec: {"rank_per_day": {"metric": "vwap_extension", "top_n": 2}}
    # `vwap_extension` is the distance from entry to the stop, as a percent —
    # which for a VWAP-anchored stop IS the distance from VWAP, the metric the
    # spec ranks on, computed from fields already on the trade.
    rank = spec.get('rank_per_day') or None
    if rank and closed:
        closed, cov['rank_per_day'] = select_by_rank(
            closed, rank.get('metric'), rank.get('direction'),
            int(rank.get('top_n') or 0))

    # Counters that describe THE TRADES have to describe the trades that
    # SURVIVED. They are tallied inside the per-pair loop, which runs before
    # ranking, so a ranked run reported "45 scale-out partials across 45
    # trades" next to a trade list holding 14 — the reader is left to work out
    # which number is about which set. Recomputed here, after every filter.
    _legs = sum(len(t.get('legs') or []) for t in closed + opens)
    _n_scaled = sum(1 for t in closed + opens if t.get('legs'))
    if _legs:
        cov['scaleout_legs'] = _legs
        cov['scaleout_trades'] = _n_scaled
    else:
        cov.pop('scaleout_legs', None)
        cov.pop('scaleout_trades', None)

    per_day: dict = {}
    for d, _, _ in pairs:
        per_day[d] = per_day.get(d, 0) + 1
    cov['pairs_per_day'] = per_day
    all_dates = sorted(per_day)

    # PER-SOURCE roll-up. Trades are attributed by the ctx the pair carried, so
    # a merged run can be read tool by tool instead of as one blended number.
    for t in closed:
        e = by_src.get((t.get('ctx') or {}).get('source') or 'symbols')
        if e:
            e['trades'] += 1
    _tot_ret: dict = {}
    for t in closed:
        sid = (t.get('ctx') or {}).get('source') or 'symbols'
        _tot_ret[sid] = _tot_ret.get(sid, 0.0) + t['ret']
    if len(by_src) > 1 or 'symbols' not in by_src:
        cov['by_source'] = sorted(
            ({'source': sid, 'name': e['name'], 'pairs': e['pairs'],
              'days': len(e['days']), 'evaluated': e['evaluated'],
              'traded_pairs': e['traded'], 'trades': e['trades'],
              'pct_of_pairs': round(100.0 * e['pairs'] / max(1, len(pairs)), 1),
              'total_return_pct': round(100.0 * _tot_ret.get(sid, 0.0), 3)}
             for sid, e in by_src.items()),
            key=lambda x: -x['pairs'])
        # the headline honesty check: is this really a multi-tool comparison,
        # or one tool plus a rounding error?
        top = cov['by_source'][0]
        if len(cov['by_source']) > 1 and top['pct_of_pairs'] >= 80:
            cov['source_imbalance'] = (
                f"{top['name']} supplied {top['pct_of_pairs']}% of all pairs — "
                f"this is not a like-for-like comparison between tools yet; the "
                f"others have too little frozen register history in this range")
    summary = _summary(closed, opens, len(pairs), errors,
                       all_dates=all_dates,
                       cost_bps=float(spec.get('cost_bps', 0.0) or 0.0),
                       spec=spec, coverage=cov)
    # which strategy produced this run — so every export self-identifies
    summary['strategy_name'] = ' + '.join(
        (st.get('name') or 'Untitled') for st in strategies)
    summary['strategy_side'] = ('both' if len({st.get('side', 'long')
                                               for st in strategies}) > 1
                                else strategies[0].get('side', 'long'))
    return {'summary': summary, 'trades': closed + opens}


def run_and_store(bt_id: int, spec: dict) -> None:
    """Orchestrator for the API thread: runs, streams progress to the store,
    persists trades + summary, and never lets an exception escape unlogged."""
    last = {'p': 0.0}

    def _cb(p):
        if p - last['p'] >= 0.02 or p >= 1.0:   # throttle DB writes
            last['p'] = p
            store.update_backtest(bt_id, progress=p)

    try:
        out = run(spec, progress_cb=_cb)
        store.add_bt_trades(bt_id, out['trades'])
        store.update_backtest(bt_id, status='done', progress=1.0,
                              summary=out['summary'])
    except Exception as e:  # noqa: BLE001
        store.update_backtest(bt_id, status='error',
                              error=f'{e}\n{traceback.format_exc()[-300:]}')
