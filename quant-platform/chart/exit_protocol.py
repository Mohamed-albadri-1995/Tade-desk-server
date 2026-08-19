"""The exit contract between the platform and anything that trades it.

WHY THIS FILE EXISTS.

A strategy's exit was being INFERRED. The screener looked at `risk.targets`,
guessed how many legs there were, guessed that they all shared one stop, and
guessed that whatever the legs did not book was a runner. Every one of those
guesses is right for some strategies and wrong for others, and a wrong guess
does not fail — it places a real order of the wrong size with the wrong stop.

So the exit is now DECLARED. Every strategy reports the same structure, whether
it wrote one or not, and a reader knows from the moment it has the strategy:
how many parts the position is cut into, where each part's stop is, where each
part's target is, and whether anything is left for a human to manage.

    exit_plan = {                              # what you WRITE on the strategy
      'version': 1,
      'shape':   '2 SL / 2 TP + runner',      # for a person
      'legs': [
        {'fraction': 0.5,  'sl': {...}, 'tp': {...}},
        {'fraction': 0.25, 'sl': {...}, 'tp': {...}},
      ],
      'runner': {'fraction': 0.25, 'manage': 'eod' | 'manual'},
      'ok': True, 'errors': [], 'warnings': [...],
    }

The authored block is `exit_plan`; the enriched, validated one is reported back
as `exit_protocol` on every read. Two names because they are two things: one is
written by a person and stored, the other is derived every time and must never
be stored, or the copy stops matching the risk block the moment either changes.

THE TWO RULES THAT MAKE THE QUANTITY CORRECT.

    every leg has its own stop      A shared stop is the common case and is
                                    filled in from risk.sl, but it is filled in
                                    EXPLICITLY. "2 SL / 2 TP" — two parts with
                                    two different stops — is then a strategy the
                                    protocol can express rather than one that
                                    silently comes out with one stop.

    the fractions sum to exactly 1  Legs plus runner. Not "about 1": a protocol
                                    summing to 0.9 means a tenth of every
                                    position is never ordered, and nothing
                                    downstream can detect that, because 90% of
                                    a correct size looks like a correct size.

DECLARED OR DERIVED, BUT ALWAYS REPORTED. A strategy written before this exists
has no `exit` block, so one is derived from `risk` — the same reading the
screener used to make, made ONCE, here, next to the engine that executes it,
and reported so both sides are looking at the same object. `derived: True` says
which it was.
"""

from __future__ import annotations

VERSION = 1


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None                  # NaN is not a number


def _sl_kind(sl: dict | None) -> str:
    """How a stop behaves, in the three words anything downstream cares about.

    fixed     a level, decided once and never moved
    trailing  follows by a fixed distance — a broker can do this
    anchored  follows an indicator line — no broker can do this, and the
              distance is not knowable at the decision
    """
    if not isinstance(sl, dict):
        return 'none'
    if sl.get('freeze'):
        return 'fixed'
    t = sl.get('type')
    if t == 'prim':
        return 'anchored'
    if t in ('pct', 'points'):
        return 'trailing'
    return 'fixed' if (t or sl.get('anchor') is not None) else 'none'


def _tp_kind(tp: dict | None, r_multiple) -> str:
    if r_multiple not in (None, '', 0):
        return 'r_multiple'
    if not isinstance(tp, dict):
        return 'none'
    t = tp.get('type')
    if t == 'prim':
        return 'anchored'
    if t in ('pct', 'points'):
        return t
    return 'none'


def normalise(strategy: dict) -> dict:
    """The exit protocol for one strategy, declared or derived.

    Never raises and never returns None: a strategy that cannot be traded still
    has to be describable, or the reason it cannot be traded is invisible.
    """
    s = strategy or {}
    risk = s.get('risk') or {}
    # `exit_plan` — NOT `exit`, which qp has always used for the exit RULES
    # group {logic, rules}. Reading that as a protocol found no legs and quietly
    # replaced a real two-part exit with a one-part default: the exact failure
    # this file exists to prevent, and it happened while writing it.
    declared = s.get('exit_plan') if isinstance(s.get('exit_plan'), dict) else None

    shared_sl = risk.get('sl') if isinstance(risk.get('sl'), dict) else None
    legs: list = []
    runner_fraction = None
    runner_manage = 'eod'

    if declared:
        for leg in (declared.get('legs') or []):
            if not isinstance(leg, dict):
                continue
            fr = _num(leg.get('fraction'))
            if fr is None or fr <= 0:
                continue
            # A leg's own stop when it names one, the strategy's otherwise.
            # Filled in explicitly so a reader never has to know the rule.
            sl = leg.get('sl') if isinstance(leg.get('sl'), dict) else shared_sl
            tp = leg.get('tp') if isinstance(leg.get('tp'), dict) else None
            legs.append({
                'fraction': fr,
                'sl': sl,
                'sl_kind': _sl_kind(sl),
                'tp': tp,
                'r_multiple': _num(leg.get('r_multiple')
                                   or (tp or {}).get('r_multiple')),
                'tp_kind': _tp_kind(tp, leg.get('r_multiple')
                                    or (tp or {}).get('r_multiple')),
            })
        r = declared.get('runner') if isinstance(declared.get('runner'), dict) else None
        if r is not None:
            runner_fraction = _num(r.get('fraction'))
            if str(r.get('manage', '')).lower() == 'manual':
                runner_manage = 'manual'
    else:
        # DERIVED from the legacy shape. One stop, targets under risk.targets,
        # and whatever they do not book is a runner.
        for t in (risk.get('targets') or []):
            if not isinstance(t, dict):
                continue
            fr = _num(t.get('fraction'))
            if fr is None or fr <= 0:
                continue
            tp = t.get('tp') if isinstance(t.get('tp'), dict) else None
            legs.append({
                'fraction': fr,
                'sl': shared_sl,
                'sl_kind': _sl_kind(shared_sl),
                'tp': tp,
                'r_multiple': _num(t.get('r_multiple')),
                'tp_kind': _tp_kind(tp, t.get('r_multiple')),
            })

    booked = sum(l['fraction'] for l in legs)

    if not legs and runner_fraction in (None, 0):
        # A strategy with no targets exits one of two ways, and they are NOT
        # interchangeable.
        #
        #   it has exit RULES     it leaves on a condition — a VWAP cross, an
        #                         SMA cross. That is the strategy. Substituting
        #                         a 2R bracket does not approximate it, it
        #                         replaces it: the backtested win rate comes
        #                         from the rule exit, and a live order at 2R
        #                         would be a different strategy wearing the same
        #                         name and the same evidence.
        #
        #   it has none           nothing takes it out but the stop, so the
        #                         screener's default R is a stated convention
        #                         rather than a substitution.
        has_exit_rules = bool(((s.get('exit') or {}).get('rules')) or [])
        legs = [{
            'fraction': 1.0, 'sl': shared_sl, 'sl_kind': _sl_kind(shared_sl),
            'tp': None, 'r_multiple': None,
            'tp_kind': 'rule' if has_exit_rules else 'default_r',
        }]
        booked = 1.0

    if runner_fraction is None:
        runner_fraction = round(max(0.0, 1.0 - booked), 6)

    protocol = {
        'version': VERSION,
        'declared': bool(declared),
        'derived': not bool(declared),
        'legs': legs,
        'runner': {'fraction': runner_fraction, 'manage': runner_manage},
            # AN EXIT RULE IS A FACT ABOUT THIS STRATEGY, and it was invisible.
        #
        # `tp_kind == 'rule'` below only happens when a strategy has NO targets
        # at all. OR + VWAP 09:35 has a target on its first leg AND a rule that
        # closes everything remaining — so it reported order_ok True, order_errors
        # empty, and the rule was dropped in silence. Live, the runner rode its
        # stop to the bell while the backtested win rate had been measured with
        # the rule.
        #
        # It is not an ERROR: no broker can watch for a VWAP cross, but the box
        # can, and does. It is a fact the order layer has to be told, so that
        # what closes the position is stated rather than assumed.
        'has_exit_rule': bool(((s.get('exit') or {}).get('rules')) or []),
    }
    protocol['shape'] = describe(protocol)
    protocol.update(validate(protocol))
    return protocol


def describe(protocol: dict) -> str:
    """'2 SL / 2 TP + runner (manual)' — the shape, for a person."""
    legs = protocol.get('legs') or []
    if not legs:
        return 'no exit'
    # Compared by CONTENT, not identity. Two legs given equal-but-separate stop
    # blocks are one stop to a trader and would otherwise read as two.
    import json as _json
    stops = {_json.dumps(l.get('sl'), sort_keys=True, default=str) for l in legs}
    n = len(legs)
    sl_part = f'{len(stops)} SL' if len(stops) != 1 else '1 SL'
    out = f'{sl_part} / {n} TP'
    r = protocol.get('runner') or {}
    if (r.get('fraction') or 0) > 0:
        out += f" + runner ({int(round(r['fraction'] * 100))}%"
        out += ', manual)' if r.get('manage') == 'manual' else ')'
    return out


def validate(protocol: dict) -> dict:
    """What is wrong with it, split into what stops it and what merely warns.

    An ERROR means nothing can be traded from this strategy: the quantity would
    be wrong or the position unprotected, and both are worse than not trading.
    A WARNING means it trades, but not identically to the backtest, and the
    difference has to be said out loud rather than discovered.
    """
    errors: list = []
    warnings: list = []
    # A THIRD list, because "cannot be alerted" and "cannot be ordered" are
    # different failures. A rule-exit strategy alerts perfectly — the entry and
    # the stop are known at the decision — and cannot be handed to a broker,
    # because no broker watches for a VWAP cross. Collapsing the two would
    # either stop a good alert or send a wrong order.
    order_errors: list = []
    legs = protocol.get('legs') or []
    runner = protocol.get('runner') or {}
    r_fraction = _num(runner.get('fraction')) or 0.0

    if not legs and r_fraction <= 0:
        errors.append('no exit at all — no targets and no runner')

    total = sum(_num(l.get('fraction')) or 0.0 for l in legs) + r_fraction
    # Exactly one. A protocol summing to 0.9 leaves a tenth of every position
    # unordered, and 90% of a correct size looks exactly like a correct size.
    if abs(total - 1.0) > 1e-6:
        errors.append(f'the parts add up to {round(total, 6)}, not 1 — '
                      f'{"some of the position would never be ordered" if total < 1 else "more than the position would be ordered"}')

    for i, leg in enumerate(legs, 1):
        if leg.get('sl_kind') == 'none':
            errors.append(f'leg {i} has no stop — it cannot be sized or ranked')
        elif leg.get('sl_kind') == 'anchored':
            warnings.append(f'leg {i} stop follows an indicator — it goes out as a '
                            'fixed level and will not trail')
        if leg.get('tp_kind') == 'anchored':
            warnings.append(f'leg {i} target follows an indicator — it cannot rest '
                            'at a broker, so that part rides the stop')
        elif leg.get('tp_kind') == 'none':
            errors.append(f'leg {i} has no target and is not the runner')
        elif leg.get('tp_kind') == 'default_r':
            warnings.append('no target in the strategy — the screener supplies 2R')
        elif leg.get('tp_kind') == 'rule':
            order_errors.append(
                'this strategy exits on a RULE, not at a price — no broker can '
                'watch for that. It alerts correctly; it must not be auto-traded '
                'unless you give it a target, or the order would be a different '
                'strategy from the one that was tested')

    # See the note in normalise(). Said out loud on every order, because a
    # position whose exit lives on this side rather than at the broker is one
    # that stops being managed the moment this side stops running — and that
    # failure is otherwise completely silent.
    if protocol.get('has_exit_rule'):
        warnings.append('this strategy also leaves on a RULE. No broker can '
                        'watch for that, so the box closes the position itself '
                        '— if the box is not running, the position is not '
                        'managed and only the stop is protecting it')

    if r_fraction > 0:
        if runner.get('manage') == 'manual':
            warnings.append(f'{int(round(r_fraction * 100))}% is a runner you manage '
                            'BY HAND — the box will not close it')
        else:
            warnings.append(f'{int(round(r_fraction * 100))}% is a runner with no '
                            'target — it rides the stop until the end-of-session close')

    return {
        'ok': not errors,
        'errors': errors,
        # Can it be alerted? Can it be ordered? Two questions, two answers.
        'order_ok': not errors and not order_errors,
        'order_errors': order_errors,
        'warnings': warnings,
    }
