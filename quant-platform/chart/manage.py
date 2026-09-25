"""What to do with a position that is ALREADY OPEN.

WHY THIS EXISTS.

A broker holds two things: a resting stop and a resting limit. Everything else
a strategy does to a position after it opens, somebody has to watch for.

Two of the three live strategies need that somebody:

  OR + VWAP 09:35   exits on a RULE — close crossing back through VWAP. In the
                    backtest that rule closes the ENTIRE remaining position,
                    the 50% runner included. No broker watches for a VWAP
                    cross, so without this the runner rides its stop to the
                    bell and the tested exit is never used.

  Test              has a stop that MOVES, and ratchets: it follows the lower
                    VWAP band UP and never down. A broker is handed one price
                    and that price stays there.

Neither can be sent. Both can be watched. This module is the watching — asked
once a minute, for one open position, answering the only two questions that
matter to it:

    should this be closed right now?
    where is its stop right now?

WHAT IT DELIBERATELY IS NOT.

It does not decide anything new. Every number it returns comes from the same
functions the backtest used — `_eval_group` for the rule, `_anchor_levels` plus
the ratchet for the stop. A second implementation of "has the VWAP crossed"
would be exactly the divergence this platform spent a rewrite removing.

It also does not act. It answers; the caller sends the order. That split keeps
the thing that talks to a broker on one side of the wire and the thing that
knows what a strategy means on the other.

THE HONEST LIMIT, stated once here and again in the response.

The backtest fills a stop AT the level on a within-bar touch. This cannot: it
sees a bar only after it closes, so a synthetic stop fills at the next
observation and, on a gap, far worse. `breached` is therefore "the level is
gone", not "you got the level". A strategy whose stop moves is not executable
at a broker that cannot move stops — this makes it *followable*, which is a
different and lesser thing, and the difference belongs in the results.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from chart import strategy as strat
import tools.compare_server as cs


def _last_closed(bars) -> int:
    """Index of the last bar we are willing to judge on.

    Every bar in a fetched frame is complete except, sometimes, the newest one —
    a partially-formed minute whose close is whatever the last print was. Acting
    on it would fire an exit on half a bar and then possibly un-fire it, which
    is not a thing the backtest can do because it never sees one.

    The caller decides how strict to be; the default is to trust the frame,
    because the feeds used here deliver closed bars. `drop_last` is the escape
    hatch for one that does not.
    """
    return len(bars) - 1


_NEXT_OPEN_FILLS = ('next_open', 'desk')


def _engine_from_entry(strategy: dict, side: str, bars, ts, ctx, ei: int,
                       fill: str) -> dict:
    """The backtest engine, run on exactly one entry — the one that is open.

    `_pair_trades` is handed an entry mask with a single true bar: the bar this
    position was decided on. Everything that decides whether and when the exit
    RULE fires — `scope`, `min_hold_bars`, which target legs banked and when,
    trade-aware operands, the fill model's timing — is then the engine's own
    answer. Nothing about the rule is re-derived here.

    THE ENTRY GATES ARE OFF, deliberately. The window, the session mask, the
    stop-too-far and target-too-close filters decide whether the backtest would
    TAKE a signal. This position is already taken; the question is what the
    strategy does with it from here, and a gate that refused the entry would
    turn "what does it do" into "nothing", which is not an answer.

    Returns:
      rule_fired_bar   the bar the exit rule fired on, or None
      rule_armed       whether the rule is armed as of the last bar
      waiting_for      why it is not, in words, or None
      closed           {reason, bar} when the engine ended the trade some other
                       way — a stop, the last target — so a position the
                       backtest already closed is visible as such
      legs_banked      [bar index, …] of the target legs that banked
    """
    n = len(bars)
    risk = strategy.get('risk') or {}
    exit_group = strategy.get('exit')
    trade_aware = strat._uses_trade(exit_group or {})
    exit_mask = (np.zeros(n, dtype=bool) if trade_aware
                 else strat._eval_group(exit_group, bars, ctx))
    entry_mask = np.zeros(n, dtype=bool)
    entry_mask[ei] = True
    trades, _sl, _tp, open_trade = strat._pair_trades(
        bars, ts, entry_mask, exit_mask, side, risk, ctx,
        exit_group=exit_group if trade_aware else None, fill=fill,
        entry_ok=None, eod_close=None, max_per_day=None,
        cooldown_bars=None, min_hold_bars=risk.get('min_hold_bars'),
        entry_mode='edge', max_stop_pct=None, min_target_usd=None,
        win_start=None, win_end=None,
        exit_scope=(exit_group or {}).get('scope'),
        entry_ok_fill=None, no_open_fill=None)

    next_open = fill in _NEXT_OPEN_FILLS
    out = {'rule_fired_bar': None, 'rule_armed': True, 'waiting_for': None,
           'closed': None, 'legs_banked': []}
    trade = trades[0] if trades else None
    if trade is not None:
        out['legs_banked'] = [int(l['xi']) for l in (trade.get('legs') or [])]
        if trade.get('reason') == 'exit':
            # Under a next-open fill the engine BOOKS the exit a bar after the
            # rule fired. The bar that matters to "how late is this" is the one
            # the rule was true on.
            out['rule_fired_bar'] = int(trade['xi']) - (1 if next_open else 0)
        else:
            out['closed'] = {'reason': trade.get('reason'), 'bar': int(trade['xi'])}
    elif open_trade is not None:
        out['legs_banked'] = [int(l['xi']) for l in (open_trade.get('legs') or [])]
        if open_trade.get('pending_exit'):
            out['rule_fired_bar'] = n - 1
        elif (exit_group or {}).get('scope') == 'runner' \
                and not open_trade.get('legs') and open_trade.get('tgt_armed', 0):
            out['rule_armed'] = False
            out['waiting_for'] = ('the first target leg to bank — this exit rule '
                                  'manages only the runner')
    return out


def manage(strategy: dict, symbol: str, side: str, entry: float,
           entry_iso: str | None = None, *, tf: str = '1m', feed: str = 'yahoo',
           days: int = 2, view: str = 'all', asof: str | None = None,
           stop_at_entry: float | None = None, drop_last: bool = False,
           fill: str = 'live') -> dict:
    """Should this open position close now, and where is its stop now?

    `entry_iso` is the fill time. It matters for two reasons and both are
    subtle: an exit rule that references the trade (bars held, P&L) needs the
    entry BAR, and the ratchet has to be applied from the entry bar forward —
    started earlier it would inherit a level from before the position existed.
    """
    side = str(side or 'long').lower()
    # ── THE SAME BARS THE DECISION READ, and fresh ─────────────────────────
    #
    # NO DATE MEANT A FIVE-MINUTE-OLD FRAME. The desk asked without `asof`,
    # and prepare_bars reads that as "not a live day": the window ended at
    # now floored to FIVE minutes and came from the disk cache, written by the
    # first call in those five minutes — its last bar still forming. At 10:44
    # the manager judged the 10:40 bar, half of it; a rule exit or a trailing
    # stop the backtest booked at 10:41 was acted on up to four bars late.
    # Today's date is what the decision sends, and it gets the live path: the
    # window ends on the bar that has just closed, fetched this minute.
    #
    # The warm-up and the view are the decision's too: `evaluate` widens the
    # window for an indicator that needs more history (a 5-day VWAP, a
    # 1950-bar MA), and reads view 'all'. The manager took exactly two days of
    # 'regular' bars, so such a stop was a different number from the one the
    # backtest and the decision computed (chart/tests/logic_audit92).
    if not asof:
        asof = pd.Timestamp.now(tz=cs._ET).strftime('%Y-%m-%d')
    from chart import data_manager as dm
    days = dm.required_days(strat.referenced_overlays(strategy), tf, days)
    bars, ts, ctx = cs.prepare_bars(symbol, tf, days, feed, view, asof)
    n = len(bars)
    if n == 0:
        return {'ok': False, 'error': f'no bars for {symbol}'}

    last = _last_closed(bars) - (1 if drop_last else 0)
    if last < 0:
        return {'ok': False, 'error': 'no closed bar to judge on'}

    # Cross-symbol operands (a market gate) need their reference bars loaded
    # before any rule evaluates — same window, same feed, causally aligned.
    strat._preload_ref_bars(strategy, symbol, bars, ctx, tf, days, feed, view, asof)

    # ── which bar the position opened on ───────────────────────────────────
    #
    # By TIME, not by index: the frame the manager fetches at 10:41 is not the
    # frame the decision was made from, and an index would silently point at a
    # different bar every minute.
    ei = 0
    if entry_iso:
        try:
            want = pd.Timestamp(entry_iso)
            if want.tz is None:
                want = want.tz_localize(cs._ET)
            hits = np.nonzero(np.asarray(bars.index <= want))[0]
            ei = int(hits[-1]) if len(hits) else 0
        except Exception:
            ei = 0

    risk = strategy.get('risk') or {}
    exit_group = strategy.get('exit')
    has_rules = bool((exit_group or {}).get('rules'))
    scope = (exit_group or {}).get('scope')

    # ── the exit rule, DECIDED BY THE BACKTEST ENGINE ───────────────────────
    #
    # THIS USED TO BE A SECOND IMPLEMENTATION, and it disagreed with the first.
    #
    # It evaluated the exit group from the entry bar forward and closed on the
    # first bar it was true. The backtest does not do that, in two ways:
    #
    #   `scope: 'runner'`   the rule manages only the RUNNER. It is armed once a
    #                       target leg has banked; until then the stop and the
    #                       targets are the only exits. OR + VWAP 09:35 is
    #                       written exactly this way — half off at 2R, then the
    #                       remaining half leaves on the VWAP cross. The manager
    #                       never read `scope`, so live closed the WHOLE
    #                       position on the first VWAP cross, before 2R, on
    #                       trades the backtest was still holding. The tested
    #                       win rate came from one exit; the money went out on
    #                       another.
    #
    #   the entry bar       is exempt from the rule in the backtest (a position
    #                       booked at a bar's close cannot also leave on that
    #                       bar). The manager scanned from it.
    #
    # The module docstring already named the principle — "a second
    # implementation of 'has the VWAP crossed' would be exactly the divergence
    # this platform spent a rewrite removing" — and then was one. So there is
    # no scan here any more. The engine is run on ONE entry, the bar this
    # position was decided on, and asked what it did. Scope, min-hold, which
    # legs banked, trade-aware rules and the fill model's timing are all its
    # answers, not this file's.
    #
    # AND THE QUESTION IS "IS THE BACKTEST FLAT BY NOW", not "did the rule
    # fire". When the stop and the rule are true on the same bar the engine
    # books the STOP — it is checked first — and a manager asking only about
    # the rule would then hold a position the backtest had already closed,
    # whenever the broker's stop sat at a different level from the engine's or
    # simply had not filled. `close_now` is the engine's trade being over by
    # this bar, for whatever reason; `exit_now` keeps its narrower meaning.
    exit_now = False
    exit_bar = None
    close_now = False
    close_reason = None
    close_bar = None
    sim = None
    engine_error = None
    # The engine is shown the same bars this function judges on — no more.
    # `drop_last` withholds a possibly-forming bar, and a simulation that could
    # still see it would decide on the bar the caller asked to be ignored.
    e_bars, e_ts = (bars, ts) if last >= n - 1 else (bars.iloc[:last + 1], ts[:last + 1])
    try:
        sim = _engine_from_entry(strategy, side, e_bars, e_ts, ctx, ei, fill)
    except Exception as e:                            # noqa: BLE001
        # A strategy with an exit rule cannot be managed without this, and
        # "hold" is not an answer to "I could not tell". One without a rule
        # loses only the report, so it goes on and says so.
        if has_rules:
            return {'ok': False, 'error': f'could not evaluate the exit rule: {e}'}
        engine_error = str(e)
    if sim is not None:
        if has_rules and sim['rule_fired_bar'] is not None and sim['rule_fired_bar'] <= last:
            exit_now = True
            exit_bar = sim['rule_fired_bar']
        if exit_now:
            close_now, close_reason, close_bar = True, 'exit', exit_bar
        elif sim['closed'] is not None and sim['closed']['bar'] <= last:
            close_now = True
            close_reason = sim['closed']['reason']
            close_bar = sim['closed']['bar']

    # ── where the stop is now ──────────────────────────────────────────────
    sl_spec = risk.get('sl') if isinstance(risk.get('sl'), dict) else None
    frozen = bool((sl_spec or {}).get('freeze'))
    sl_arr = strat._anchor_levels(sl_spec, side, bars, ctx)

    stop_now = None
    stop_kind = 'none'
    if sl_spec:
        stop_kind = 'fixed' if frozen else ('anchored' if sl_spec.get('type') == 'prim'
                                            else 'trailing')

    anchor_at_entry = None
    if frozen or sl_arr is None:
        # Nothing to follow. The level the broker already holds IS the stop, and
        # saying so is not a non-answer: it is the reason this strategy needs no
        # managing and the caller should leave its order alone.
        stop_now = float(stop_at_entry) if stop_at_entry is not None else None
    else:
        # THE RATCHET, from the entry bar forward. A protective stop never
        # loosens: a long's may trail up with a rising anchor and may never move
        # down. Without it a stop anchored to a running extreme chases price and
        # can never be breached — the position bleeds to the close unprotected.
        #
        # SEEDED FROM THE ANCHOR AT THE ENTRY BAR, not from what the broker was
        # told. `_pair_trades` does exactly this —
        #
        #     sl_eff = e_sl ...; sl_at_entry = sl_eff
        #
        # — and seeding from the caller's number instead would let the two
        # disagree, which is the whole class of bug this module exists to avoid.
        # `stop_at_entry` is still reported, so a disagreement is VISIBLE rather
        # than resolved in silence.
        eff = None
        # THE ANCHOR AS IT STOOD ON THE ENTRY BAR, kept separately from the
        # ratcheted level. It is the only number that can answer "was this stop
        # already past the fill when the trade opened" — see the wrong-side note
        # below, which was reading the RATCHETED level and getting a different
        # question's answer.
        anchor_at_entry = None
        for j in range(ei, last + 1):
            v = sl_arr[j]
            if v is None or v != v:                   # NaN in warm-up → hold
                continue
            v = float(v)
            if j == ei:
                anchor_at_entry = v
            eff = v if eff is None else (max(eff, v) if side == 'long' else min(eff, v))
        # Nothing formed yet — the anchor is still in warm-up. The level the
        # broker holds is all there is, and it is better than nothing.
        stop_now = eff if eff is not None else (
            float(stop_at_entry) if stop_at_entry is not None else None)

    close = float(bars['close'].to_numpy(dtype=float)[last])
    breached = False
    if stop_now is not None:
        breached = (close <= stop_now) if side == 'long' else (close >= stop_now)

    # A stop on the WRONG SIDE OF THE ENTRY is not a protective stop.
    #
    # It can only happen when the anchor at the entry bar was already past the
    # fill — a stale line, a gap, a strategy whose stop is not really below its
    # entries. The simulation would stop such a trade out on its next bar, so
    # closing is arguably faithful; but closing a position that was just opened,
    # on the strength of a level that is obviously wrong, is the kind of action
    # that should never happen automatically without somebody having seen it.
    #
    # So it is REPORTED and not resolved. The caller decides.
    #
    # ── MEASURED AT THE ENTRY BAR, NOT NOW ──────────────────────────────────
    #
    # This tested `stop_now`, the RATCHETED level, and so answered a different
    # question from the one above it. A trailing stop that has climbed past the
    # entry is the ordinary healthy case — it is a stop that has moved into
    # profit, which is the entire purpose of a trail — and it was being
    # reported as broken.
    #
    # 2026-09-17, P, long from 102.20 with its stop at 101.45:
    #
    #     stop 102.57 → 102.64, stopMoved true, wrongSide true,
    #     breached true, exitNow FALSE, every pass from 11:50
    #
    # VWAP rose through the entry while price fell below it. The trail did
    # exactly what a trail is for; the stop was breached; and the desk refused
    # to close, published an error alert, and did it again sixty seconds later.
    # Eight alerts, four errors, and a position the backtest would have closed
    # still open — the divergence this whole system exists to prevent.
    #
    # The hazard the note describes is a stop that was ALREADY past the fill
    # when the trade opened. That is a fact about the entry bar, and the entry
    # bar is where it is now read. `stop_at_entry` is the fallback rather than
    # the primary: it is what the BROKER was told, and the ratchet is seeded
    # from the anchor instead precisely so the two can be seen to disagree.
    _ref = anchor_at_entry
    if _ref is None:
        _ref = float(stop_at_entry) if stop_at_entry is not None else stop_now
    wrong_side = (_ref is not None
                  and ((side == 'long' and _ref >= float(entry))
                       or (side == 'short' and _ref <= float(entry))))

    moved = (stop_now is not None and stop_at_entry is not None
             and abs(stop_now - float(stop_at_entry)) > 1e-9)

    return {
        'ok': True,
        'name': strategy.get('name'),
        'symbol': str(symbol).upper(),
        'side': side,
        'bar': {'time': str(bars.index[last]), 'close': close, 'index': int(last)},
        'entry_bar': int(ei),
        'bars_held': int(last - ei),

        # Question one.
        'has_exit_rule': has_rules,
        'exit_now': bool(exit_now),
        # Which bar it fired on, and how many bars ago. A rule that fired four
        # minutes back is still an exit — and the lateness is a cost that
        # belongs in the record rather than being rounded away.
        'exit_bar': (None if exit_bar is None else int(exit_bar)),
        'exit_bars_ago': (None if exit_bar is None else int(last - exit_bar)),
        # WHY IT IS NOT CLOSING, when that is not obvious. A runner-scoped rule
        # that is not armed yet looks, from outside, exactly like a rule that
        # is broken: the VWAP crossed and nothing happened. Said here so the
        # desk can say it too.
        'exit_scope': scope,
        'rule_armed': (None if sim is None else bool(sim['rule_armed'])),
        'waiting_for': (None if sim is None else sim['waiting_for']),
        'legs_banked': ([] if sim is None else list(sim['legs_banked'])),
        # A trade the ENGINE has already closed another way — its stop, its
        # last target. If the position is still open live, the broker did not
        # do what the backtest assumed it would, and that is worth knowing.
        'backtest_closed': (None if sim is None else sim['closed']),
        # THE ONE THE CALLER ACTS ON. The backtest is flat by this bar — by its
        # exit rule, its stop or its last target — so whatever is still open
        # live is a position the tested strategy does not have.
        'close_now': bool(close_now),
        'close_reason': close_reason,
        'close_bar': (None if close_bar is None else int(close_bar)),
        'close_bars_ago': (None if close_bar is None else int(last - close_bar)),
        'engine_error': engine_error,
        'fill': fill,

        # Question two.
        'stop_kind': stop_kind,
        'stop_at_entry': (float(stop_at_entry) if stop_at_entry is not None else None),
        'stop_now': (None if stop_now is None else round(float(stop_now), 4)),
        'stop_moved': bool(moved),
        'breached': bool(breached),
        # Reported, never resolved — see the note above.
        'stop_wrong_side': bool(wrong_side),

        # Neither of these is a decision — see the module docstring.
        'managed': bool(has_rules or (stop_kind == 'anchored' and not frozen)),
        'note': ('a synthetic stop fills at the next observation, not at the '
                 'level — on a gap, far worse than the backtest assumed')
                if (stop_kind == 'anchored' and not frozen) else None,
    }
