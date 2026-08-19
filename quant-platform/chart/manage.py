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


def manage(strategy: dict, symbol: str, side: str, entry: float,
           entry_iso: str | None = None, *, tf: str = '1m', feed: str = 'yahoo',
           days: int = 2, view: str = 'regular', asof: str | None = None,
           stop_at_entry: float | None = None, drop_last: bool = False) -> dict:
    """Should this open position close now, and where is its stop now?

    `entry_iso` is the fill time. It matters for two reasons and both are
    subtle: an exit rule that references the trade (bars held, P&L) needs the
    entry BAR, and the ratchet has to be applied from the entry bar forward —
    started earlier it would inherit a level from before the position existed.
    """
    side = str(side or 'long').lower()
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
            import pandas as pd
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

    # ── the exit rule, as the backtest evaluates it ────────────────────────
    exit_now = False
    exit_bar = None
    if has_rules:
        try:
            trade = {'entry': float(entry), 'ei': ei, 'side': side}
            em = strat._eval_group(exit_group, bars, ctx, trade=trade)

            # EVERY BAR SINCE ENTRY, not just the newest one.
            #
            # A cross is an EDGE: `close crosses below VWAP` is true on the one
            # bar it crosses and false on every bar after, while price stays
            # below. Asked once a minute and reading only the latest bar, a
            # manager that is late — a slow fetch, a restart, a minute the
            # scheduler skipped — would never see it, and the exit that the
            # backtested win rate was measured with would simply not happen.
            #
            # The position is still open, so if the rule was EVER true since
            # entry the simulation would already have closed it. Scanning
            # forward from the entry bar is therefore not a heuristic, it is
            # the same answer arrived at late. `exit_bar` says how late.
            # `min_hold_bars` defers the RULE (never the stop) for N bars after
            # entry — the same deferral the simulation applies.
            hold = int(risk.get('min_hold_bars') or 0)
            first = max(ei + hold, ei)
            for j in range(first, last + 1):
                if bool(em[j]):
                    exit_bar = j
                    break
            exit_now = exit_bar is not None
        except Exception as e:                        # noqa: BLE001
            return {'ok': False, 'error': f'could not evaluate the exit rule: {e}'}

    # ── where the stop is now ──────────────────────────────────────────────
    sl_spec = risk.get('sl') if isinstance(risk.get('sl'), dict) else None
    frozen = bool((sl_spec or {}).get('freeze'))
    sl_arr = strat._anchor_levels(sl_spec, side, bars, ctx)

    stop_now = None
    stop_kind = 'none'
    if sl_spec:
        stop_kind = 'fixed' if frozen else ('anchored' if sl_spec.get('type') == 'prim'
                                            else 'trailing')

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
        for j in range(ei, last + 1):
            v = sl_arr[j]
            if v is None or v != v:                   # NaN in warm-up → hold
                continue
            v = float(v)
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
    wrong_side = (stop_now is not None
                  and ((side == 'long' and stop_now >= float(entry))
                       or (side == 'short' and stop_now <= float(entry))))

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
