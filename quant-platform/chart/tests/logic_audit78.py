"""The card told you to take the wheel from a machine that was steering.

Reported as: "It's not just collapsing. It's not useful and I think it's even
wrong statement."

The sentence, on every setup with a moving stop:

    leg 1 stop follows an indicator — it goes out as a fixed level and will
      not trail

and on the order alert:

    the stop trails an indicator — sent as a fixed level, so it will NOT
      follow. Manage it yourself

Both false, and false in the direction that makes things worse. Three places
in this platform already knew better:

    chart/manage.py           managed = has_rules or (stop_kind == 'anchored'
                              and not frozen)

    src/setups/manager.js     closes when `breached && stop_kind ===
                              'anchored'`, on every bar

    manager.js's own header   "Test has a stop that MOVES and RATCHETS — up
                              with the lower VWAP band, never down. A broker is
                              handed one price. Neither can be sent. BOTH CAN
                              BE WATCHED. This is the watching."

So two files in one platform said opposite things about the same stop, and the
one on the card said the false one. A person acting on it would close by hand a
position the box was already following — and the tests were all green, because
nothing checked the claim against the code that implements it.

WHAT IS ACTUALLY TRUE is the cost manage.py already names: a synthetic stop
fills at the NEXT OBSERVATION, not at the level. The backtest fills a within-bar
touch AT the stop and this cannot see inside a bar. That is a real, measurable
difference between live and tested on every trade — a number to watch, not an
instruction to intervene.

These check the sentence against the behaviour, so the two cannot drift again.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import chart.exit_protocol as EP                                    # noqa: E402

DESK = ROOT.parent                      # the screener repo beside quant-platform

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}' + (f'   [{extra}]' if extra else ''))


def warns(legs, has_rule=False):
    """The warnings validate() produces for one exit shape."""
    proto = {'version': EP.VERSION, 'legs': legs, 'runner': {'fraction': 0.0},
             'has_exit_rule': has_rule}
    return EP.validate(proto)['warnings']


ANCH = {'sl_kind': 'anchored', 'tp_kind': 'r_multiple', 'fraction': 1.0}
TWO = [{**ANCH, 'fraction': 0.5}, {**ANCH, 'fraction': 0.5}]


print('\n── the false sentence is gone, in both places it was said ────────')

one = ' '.join(warns([ANCH]))
for dead in ('will not trail', 'it goes out as a fixed level',
             'Manage it yourself'):
    ok(f'the card no longer says "{dead}"', dead not in one, one[:90])

# The ORDER alert's copy of the same claim is checked on the desk side, by
# running unmanagedLine() rather than grepping a file whose comments now quote
# the sentence they replaced — see tests/setups.anchoredStop.test.js.


print('\n── and what it says instead is what the box does ─────────────────')

ok('the card says the BOX follows it', 'BOX follows it' in one, one[:90])
ok('and that it closes on a breach', 'closes on a breach' in one)
# The cost that IS real, and the reason it is a cost.
ok('it names the fill difference', 'NEXT bar rather than at the level' in one)
ok('and that a gap is worse', 'far more on a gap' in one)

# THE CROSS-CHECK. The claim on the card is a claim about another file; if that
# file stops doing it, the card becomes false again and nothing else would say
# so.
mgr = (DESK / 'src' / 'setups' / 'manager.js').read_text()
ok('the manager really does close on an anchored breach',
   "answer.breached && answer.stop_kind === 'anchored'" in mgr)
manage_py = (ROOT / 'chart' / 'manage.py').read_text()
ok('and qp really does call that shape managed',
   "'managed': bool(has_rules or (stop_kind == 'anchored' and not frozen))"
   in manage_py)
# The clause that fits on one source line — the sentence is split across two.
ok('the fill note the card borrows is qp\'s own words',
   'fills at the next observation, not at the' in manage_py
   and 'far worse than the backtest assumed' in manage_py)


print('\n── once, not once per leg ────────────────────────────────────────')

# Three legs anchored to one line is one fact and a number. Printed three times
# it filled the card and pushed the RULE warning below it out of sight — and
# only two warnings are shown before the rest folds.
for n in (1, 2, 3):
    legs = [{**ANCH, 'fraction': 1.0 / n} for _ in range(n)]
    got = [w for w in warns(legs) if 'follow' in w and 'stop' in w]
    ok(f'{n} anchored leg(s) produce one stop warning',
       len(got) == 1, f'{len(got)}: {got}')

ok('and it carries the count when there is more than one',
   'all 2 legs' in ' '.join(warns(TWO)))


print('\n── the sentence agrees with itself ───────────────────────────────')

# "the stops on all 2 legs follow an indicator — the box follows IT" is a
# sentence disagreeing with itself, on a card read at 09:35.
many = [w for w in warns(TWO) if 'legs follow' in w]
ok('a plural subject takes a plural verb', bool(many) and 'follows them' in many[0],
   many[0][:110] if many else 'no plural warning')
ok('…and plural levels with it', bool(many) and 'the levels it was given' in many[0])
single = [w for w in warns([ANCH]) if 'stop follows' in w]
ok('a single leg stays singular', bool(single) and 'follows it and closes' in single[0])
ok('…and does not say "legs"', bool(single) and ' legs ' not in single[0])


print('\n── the target warning got the same treatment ─────────────────────')

TP = {'sl_kind': 'fixed', 'tp_kind': 'anchored', 'fraction': 0.5}
two_tp = [w for w in warns([TP, {**TP}]) if 'target' in w]
ok('two anchored targets are one line', len(two_tp) == 1, str(two_tp))
ok('and it is plural', bool(two_tp) and two_tp[0].startswith('2 targets follow'))
one_tp = [w for w in warns([TP, {'sl_kind': 'fixed', 'tp_kind': 'r_multiple',
                                 'fraction': 0.5}]) if 'target' in w]
ok('one is singular', bool(one_tp) and one_tp[0].startswith('the target follows'))


print('\n── "if the box is not running" is said for BOTH kinds ────────────')

# It was said only for an exit RULE. A setup whose stop is anchored and which
# has no rule is managed here too — so the one warning about a box-managed
# exit never appeared for half the setups that have one.
no_rule = ' '.join(warns([ANCH], has_rule=False))
ok('an anchored stop with no exit rule says where the exit lives',
   'if the box is not running' in no_rule, no_rule[:120])
ok('…and what is left when it is not',
   'only the level the broker was given at entry' in no_rule)

with_rule = warns([ANCH], has_rule=True)
ok('a rule setup keeps its own sentence',
   any('leaves on a RULE' in w for w in with_rule))
ok('and does not say the consequence twice',
   sum('if the box is not running' in w for w in with_rule) == 1,
   str(with_rule))


print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
