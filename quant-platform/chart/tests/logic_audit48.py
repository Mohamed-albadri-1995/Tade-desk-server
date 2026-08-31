"""Audit part 48 — the exit contract, across the language boundary.

WHY THIS EXISTS.

The order a broker receives is built in two languages. qp decides the exit and
hands it over as `exit_plan`; the desk's `planOrder` (JavaScript) reads that
object and turns it into the bodies that go on the wire.

NOTHING CHECKED THAT THE TWO WERE STILL TALKING ABOUT THE SAME OBJECT. The
field names are matched by hand across the boundary, and every way they can
drift apart is SILENT — the JSON stays valid, SignalStack accepts it, the
broker acts on it, and the position is simply not the one that was tested.

Measured on the desk, not imagined. "Half at 2R, half rides the stop", 100
shares:

    correct                     50 @ 2R  +  50 riding the stop
    `runner` becomes a dict     100 @ 2R         — the runner is DELETED
    leg `price` renamed         100, no target   — the WHOLE thing rides

One field, either direction, and the strategy that trades is not the strategy
that was backtested. Neither raises. Neither logs. Both spend real money.

The desk side is pinned by tests/broker.exitContract.test.js, which replays
every strategy's real plan through the order builder. That file can only be as
good as the fixture it reads, and the fixture is generated from HERE.

So this part does the two things that must happen on the qp side:

PART A — the field names the desk reads are the ones qp emits. Checked against
         the desk's own source, so a rename in either language fails here.
PART B — the committed fixture is CURRENT. A qp change the fixture never
         learned about would leave every assertion over there passing against
         last month's contract while the live desk sends something else.
PART C — the shapes that cannot rest at a broker are marked as such, because
         for those strategies the correct JSON has FEWER targets than the
         strategy's own shape claims.
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name} {extra}')


from chart.exports import exit_contract as ec        # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[3]
DESK = (ROOT / 'src' / 'broker' / 'signalstack.js').read_text()
RUNNER = (ROOT / 'src' / 'setups' / 'runner.js').read_text()

CONTRACT = ec.contract()
PLAN = CONTRACT['strategies'][0]['sides']['long']


print('== A. the field names the desk reads are the ones qp emits ==')
#
# Each row: what the DESK reads, where it reads it, and what qp must therefore
# put on the object. Both halves are checked — a rename in either language
# breaks exactly one of them, and that is the point.
#
# This list is the contract. Adding a field the desk reads without adding it
# here is the only way to lose cover, which is why it names the source too.
CONTRACT_FIELDS = [
    # (desk expression,             where,   qp key,        must be)
    ('plan.legs',                   'desk',  'legs',        list),
    ('plan.runner',                 'desk',  'runner',      (int, float)),
    ('plan.trail',                  'desk',  'trail',       (dict, type(None))),
    ('plan.stop_anchored',          'alert', 'stop_anchored', bool),
    ('plan.exit_rule',              'alert', 'exit_rule',   bool),
    ('plan.breakeven_after_leg',    'alert', 'breakeven_after_leg', bool),
]
for expr, where, key, want in CONTRACT_FIELDS:
    src = DESK if where == 'desk' else RUNNER
    ok(f'the {where} reads {expr}', expr in src,
       f'{expr} is not read anywhere in {where} — this row is stale')
    ok(f'...and qp emits {key!r} as {getattr(want, "__name__", want)}',
       key in PLAN and isinstance(PLAN[key], want),
       (key in PLAN, type(PLAN.get(key)).__name__))

# THE RUNNER IS A NUMBER, and this is not a formality. Emitting it as a dict is
# truthy in JavaScript but Number({}) is NaN, so `runnerFraction > 0` is false
# and the runner is silently folded into the last target: the whole position
# leaves at 2R. Measured on the desk; see the module note.
ok('the runner is a plain fraction, never an object',
   isinstance(PLAN.get('runner'), (int, float))
   and not isinstance(PLAN.get('runner'), bool),
   type(PLAN.get('runner')).__name__)

# The per-leg fields, same idea one level down.
LEG_FIELDS = [('leg.price', 'price'), ('leg.fraction', 'fraction'),
              ('leg.stop', 'stop'), ('leg.trail', 'trail'),
              ('leg.r_multiple', 'r_multiple')]
#
# EVERY READ HERE IS A .get(), AND THAT IS THE WHOLE POINT.
#
# The first version indexed these directly, which meant that when the field it
# was checking for actually went missing, the audit DIED on the KeyError —
# before Part B could say "the exit contract changed, here is the command to
# regenerate it, read the diff". The gate still went red, so nothing shipped,
# but the person reading it got a traceback pointing at the test instead of a
# sentence naming what changed about their live orders.
#
# Caught by drifting decide.py on purpose and watching the output. An audit
# that crashes on the fault it exists to describe has reported the fault in
# the least useful way available.
leg = (PLAN.get('legs') or [{}])[0]
for expr, key in LEG_FIELDS:
    # The desk destructures these off `leg`, so the read is `l.price` / `leg.price`.
    reads = (f'l.{key}' in DESK) or (f'leg.{key}' in DESK)
    ok(f'the desk reads {expr}', reads, f'no read of {key} in the order builder')
    ok(f'...and every leg carries {key!r}',
       all(key in lg for s in CONTRACT['strategies']
           for side in (s.get('sides') or {}).values()
           for lg in (side.get('legs') or [])),
       f'{key!r} is gone from the plan — the desk reads it and will get undefined')
ok('a leg fraction is a number', isinstance(leg.get('fraction'), (int, float)))
# `price` is None for a target that cannot be priced at the decision — that is
# a real state, not a missing field, and the desk distinguishes them. `.get`
# with a sentinel keeps the two apart without indexing.
_price = leg.get('price', '<missing>')
ok('a leg price is a number or an explicit None',
   _price is None or isinstance(_price, (int, float)), _price)

# A trail, when there is one, is {kind, value} — the two names the desk turns
# into stop_loss_price_percent / _distance.
ok("the desk turns trail.kind 'pct' into a percent stop",
   "trail.kind === 'pct'" in DESK and 'stop_loss_price_percent' in DESK)
ok('...and anything else into a distance', 'stop_loss_price_distance' in DESK)


print()
print('== B. the committed fixture is current ==')
FIX = ROOT / 'tests' / 'fixtures' / 'exit-plans.json'
REFRESH = 'python chart/exports/exit_contract.py --write'
ok('the fixture exists', FIX.exists(),
   f'the desk\'s contract test reads it — generate it with: {REFRESH}')
if FIX.exists():
    on_disk = FIX.read_text(encoding='utf-8')
    fresh = ec.dumps(CONTRACT)
    ok('...and matches what qp produces today', on_disk == fresh,
       'THE EXIT CONTRACT CHANGED. tests/broker.exitContract.test.js is now '
       f'checking the desk against an old one. Regenerate it: {REFRESH} — '
       'then READ THE DIFF, because it is the list of strategies whose live '
       'orders just changed shape.')
    if on_disk != fresh:
        try:
            a = json.loads(on_disk)
            b = json.loads(fresh)
            changed = [s['name'] for s in b['strategies']
                       if s not in a['strategies']]
            print(f'         changed: {", ".join(changed) or "(ordering only)"}')
        except ValueError:
            pass

# Every strategy the platform holds is in it. A strategy added to qp and not to
# the fixture is one the desk's contract test never looks at — and the newest
# strategy is the one most likely to have an exit nobody has placed yet.
from chart import store                              # noqa: E402
ok('every strategy the platform holds is under contract',
   len(CONTRACT['strategies']) == len(store.list_strategies() or []),
   (len(CONTRACT['strategies']), len(store.list_strategies() or [])))


print()
print('== C. what cannot rest at a broker is marked ==')
#
# For several real strategies the correct JSON has FEWER targets than the
# strategy's own shape claims, and that is not a bug — it is the honest
# handling. A target anchored to an indicator is wherever that line sits on
# each bar; no resting order can follow it, and a plausible-looking price would
# put a target where the backtest never had one. Those shares ride the stop and
# the BOX manages them.
#
# The danger is that it is invisible. "1 SL / 3 TP" reads as three targets at
# the broker, and for RubberBand Scalp two rest there and the third does not.
# .get() throughout, for the reason written in Part A: this section must be
# able to DESCRIBE a contract that has drifted, not die on it.
def _legs(p):
    return p.get('legs') or []


anchored = [(s.get('name'), side,
             sum(1 for l in _legs(p) if l.get('price', '<missing>') is None),
             len(_legs(p)))
            for s in CONTRACT['strategies']
            for side, p in (s.get('sides') or {}).items()
            if any(l.get('price', '<missing>') is None for l in _legs(p))]
ok('the strategies with an unplaceable target are visible in the contract',
   len(anchored) > 0, 'expected at least the scalps')
print(f'         {len({a[0] for a in anchored})} strategy(ies) carry a target '
      'no broker can hold:')
for name, side, n, total in sorted(set(anchored))[:8]:
    if side == 'long':
        print(f'           {name}: {n} of {total} leg(s) ride instead')

# An unplaceable leg is marked, not just unpriced — the desk and the alert both
# read the flag rather than re-deriving it from a null.
ok('an unplaceable leg says so explicitly',
   all(l.get('anchored') for s in CONTRACT['strategies']
       for side in (s.get('sides') or {}).values()
       for l in _legs(side) if l.get('price', '<missing>') is None))

# ...and the alert says it out loud, because a strategy managed by the box and
# one managed at the broker look identical from a phone.
ok('the alert tells you which targets are not at the broker',
   'cannot rest at the ' in RUNNER and 'that part rides the stop' in RUNNER)
ok('...and who closes a rule exit', 'the box watches for that' in RUNNER)

# A strategy that cannot be ordered AT ALL carries the refusal, so the runner
# can alert it and never send it.
refused = [s.get('name') for s in CONTRACT['strategies'] if not s.get('order_ok', True)]
ok('a strategy that must never reach a broker says so, with a reason',
   all(s.get('order_errors') for s in CONTRACT['strategies']
       if not s.get('order_ok', True)),
   refused)
print(f'         alert-only: {", ".join(refused) or "none"}')


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
