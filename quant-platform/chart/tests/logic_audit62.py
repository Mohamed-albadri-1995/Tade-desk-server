"""Audit 62 — the CANSLIM gate on a backtest, and the three answers it gives.

Audit 61 proved that `chart/canslim.py` will not hand back a letter it cannot
reconstruct as of a date. This file is about the other half: what happens when
a BACKTEST is told to gate on those letters.

Two failures are possible and they are opposite in shape.

    THE RUN THAT SHOULD NOT HAVE HAPPENED. A rule names a letter that cannot
    be reconstructed, the run proceeds anyway on today's value, and the curve
    is a lie with a chart attached. The gate must refuse BEFORE the first pair
    — not skip the rule, not warn, not fall back.

    THE RUN THAT LOOKS SELECTIVE AND WAS BLIND. A pair the gate could not read
    is quietly dropped and counted with the ones that genuinely failed the
    screen, so a run that verified almost nothing reports as a run that
    filtered hard. "Failed the screen" and "the screen could not be run" are
    different facts about a pair, and this file checks they stay apart.

Everything here executes. A gate that reads correctly in the source and does
nothing in the loop is exactly the bug — and this repo has shipped that bug
before, in `reconcile.confirmed()`, which was written, correct, and called by
nothing for a fortnight.
"""

import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import numpy as np                                         # noqa: E402
import pandas as pd                                        # noqa: E402

import tools.compare_server as cs                          # noqa: E402
import chart.backtest as bt                                # noqa: E402
import chart.canslim as canslim                            # noqa: E402

PASS = FAIL = 0


def ok(label, cond, got=None):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {label}')
    else:
        FAIL += 1
        print(f'  FAIL {label}' + (f'\n       got: {got!r}' if got is not None
                                   else ''))


print('=' * 64)
print('audit 62 — the CANSLIM gate: refuse, block, or admit you could not read')
print('=' * 64)


# ── 1. THE SPEC IS CHECKED BEFORE ANY WORK IS DONE ──────────────────────
print()
print('== a rule naming an unreconstructable letter stops the run ==')

ok('no rules means no gate, and no cost',
   bt._canslim_spec({}) == (None, ()) and bt._canslim_spec({'canslim': {}})
   == (None, ()))
ok('an all-empty rule set is the same as none — a blank field in a form is '
   'not a filter', bt._canslim_spec({'canslim': {'l_pct_min': None,
                                                 'i_direction': []}})
   == (None, ()))

_r, _l = bt._canslim_spec({'canslim': {'m_status': ['confirmed_uptrend'],
                                       'l_pct_min': 80}})
ok('the letters are derived from the rules, not restated by the caller',
   _l == ('l', 'm'), _l)

try:
    bt._canslim_spec({'canslim': {'q_bogus': 1}})
    ok('an unknown rule name raises', False)
except ValueError as e:
    ok('an unknown rule name raises, and lists what IS known',
       'q_bogus' in str(e) and 'l_pct_min' in str(e))
try:
    bt._canslim_spec({'canslim': 'confirmed_uptrend'})
    ok('a rule set that is not an object raises', False)
except ValueError as e:
    ok('a rule set that is not an object raises, with an example of one that '
       'is', 'canslim must be an object' in str(e))

# THE ONE THAT MATTERS. With C unreconstructable, a spec that gates on C must
# raise — not drop the rule, not warn and continue.
_saved = dict(canslim.POINT_IN_TIME)
try:
    canslim.POINT_IN_TIME['c'] = False
    canslim.WHY_NOT['c'] = 'no filing dates were stored'
    try:
        bt._canslim_spec({'canslim': {'c_eps_chg_min': 25}})
        ok('gating on a letter that cannot be reconstructed RAISES', False)
    except ValueError as e:
        ok('gating on a letter that cannot be reconstructed RAISES',
           'cannot be backtested honestly' in str(e))
        ok('...and the message names the letter and the missing fact, so the '
           'fix is visible from the error',
           'C —' in str(e) and 'no filing dates were stored' in str(e), str(e))
        ok('...and says what gating on it would mean, rather than only that it '
           'is not allowed',
           'did not exist on the day' in str(e), str(e))
    # A rule on a DIFFERENT letter is unaffected — the refusal is per letter,
    # not a blanket switch-off of the whole gate.
    ok('a rule on a letter that IS reconstructable still runs',
       bt._canslim_spec({'canslim': {'l_pct_min': 80}})[1] == ('l',))
finally:
    canslim.POINT_IN_TIME.clear()
    canslim.POINT_IN_TIME.update(_saved)
    canslim.WHY_NOT.pop('c', None)

ok('...and the table is restored, so later parts test the real thing',
   canslim.refusals('canslim') == {})


# ── 2. THREE ANSWERS, KEPT APART ────────────────────────────────────────
print()
print('== pass, blocked, and "could not be read" are three answers ==')

GOOD = {'refused': {}, 'm': {'status': 'confirmed_uptrend'},
        'l': {'group_pct': 92}, 'rs': 88.0,
        'c': {'latest': {'eps_chg': 40.0, 'sales_chg': 12.0}},
        'a': {'growth_3yr_pct': 30.0, 'roe_pct': 22.0},
        'i': {'direction': 'rising', 'share_pct': 14.0}}
ALL = {'m_status': ['confirmed_uptrend'], 'l_pct_min': 80, 'rs_min': 80,
       'c_eps_chg_min': 25, 'c_sales_chg_min': 5, 'a_growth_min': 25,
       'a_roe_min': 17, 'i_direction': ['rising', 'turning up'],
       'i_share_pct_min': 10}

ok('a reading that clears every rule passes', bt._canslim_ok(GOOD, ALL)
   == (True, None), bt._canslim_ok(GOOD, ALL))
ok('EVERY rule in the table is exercised by that pass — a rule the gate '
   'silently ignores would still read as a filter on the report',
   set(ALL) == set(bt.CANSLIM_RULES), sorted(set(bt.CANSLIM_RULES) - set(ALL)))

_v, _w = bt._canslim_ok(GOOD, {'l_pct_min': 95})
ok('a reading that falls short is BLOCKED (False), and says by how much',
   _v is False and '92' in _w and '95' in _w, (_v, _w))

# A PERCENTILE, NOT A RANK. 20 is the top fifth as a rank and the bottom fifth
# as a percentile, and `groups.rank_to_pct` exists because that reversal has
# already been got wrong in this system once.
ok('the L rule is a PERCENTILE floor: 92 clears 80 and fails 95',
   bt._canslim_ok(GOOD, {'l_pct_min': 80})[0] is True
   and bt._canslim_ok(GOOD, {'l_pct_min': 95})[0] is False)
ok('...and the source says so, because a bare number is excellent as a rank '
   'and poor as a percentile',
   'percentile counts down' in
   pathlib.Path(bt.__file__).read_text())

_v, _w = bt._canslim_ok({'refused': {'c': 'no EDGAR record for this ticker'}},
                        {'c_eps_chg_min': 25})
ok('a letter REFUSED for that stock is unverifiable (None), NOT a fail — the '
   'company did not fail a test that was never run',
   _v is None and 'no EDGAR record' in _w, (_v, _w))

# O'NEIL'S OWN REFUSAL PASSES THROUGH AS UNVERIFIABLE. A percentage from a
# loss-making base is arithmetic without meaning (edgar.pct_change), so the
# growth number is absent — and absent is not "below 25".
_v, _w = bt._canslim_ok({'refused': {}, 'c': {'latest': {'eps_chg': None}}},
                        {'c_eps_chg_min': 25})
ok('an n/a growth figure is unverifiable, not a fail — a loss-making base is '
   'a missing comparison, not a small one', _v is None, (_v, _w))

_v, _w = bt._canslim_ok({'refused': {}}, {'m_status': ['confirmed_uptrend']})
ok('a letter that is simply absent from the reading is unverifiable',
   _v is None and 'missing' in _w, (_v, _w))

ok('a blocked pair reports WHICH rule blocked it, not just that one did',
   'M is' in bt._canslim_ok({**GOOD, 'm': {'status': 'market_in_correction'}},
                            {'m_status': ['confirmed_uptrend']})[1])
ok('a direction rule accepts a bare string as well as a list, since one '
   'allowed value is the common case',
   bt._canslim_ok(GOOD, {'i_direction': 'rising'})[0] is True
   and bt._canslim_ok(GOOD, {'i_direction': 'falling'})[0] is False)


# ── 3. END TO END THROUGH run(), OVER A STUB FEED ───────────────────────
#
# The gate reading correctly in isolation proves nothing about the loop. This
# repo has shipped a function that was written, correct, and called by nothing.
print()
print('== the gate in the loop: counted, not vanished ==')


class StubLoader:
    def load(self, symbol, tf, start, end):
        r = np.random.default_rng(abs(hash((symbol, str(start), str(end))))
                                  % (2 ** 31))
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:6000]
        n = len(idx)
        base = (100 if symbol == 'AAA' else 50) + np.cumsum(r.normal(0, 0.02, n))
        o = base
        c = base + 0.01
        return pd.DataFrame({'open': o, 'high': np.maximum(o, c) + 0.02,
                             'low': np.minimum(o, c) - 0.02, 'close': c,
                             'volume': 1000.0}, index=idx)


cs._LOADERS['stub62'] = StubLoader()

_T = {'kind': 'time', 'field': 'hhmm'}
_strategy = {'name': 's', 'side': 'long',
             'entry': {'logic': 'AND',
                       'rules': [{'left': _T, 'op': 'eq',
                                  'right': {'kind': 'const', 'value': 1000}}]},
             'exit': {'logic': 'AND',
                      'rules': [{'left': _T, 'op': 'eq',
                                 'right': {'kind': 'const', 'value': 1100}}]}}
_spec = {'strategy': _strategy, 'tf': '1m', 'days': 2, 'feed': 'stub62',
         'view': 'all', 'fill': 'close', 'start': '2024-01-09',
         'end': '2024-01-11',
         'universe': {'kind': 'symbols', 'symbols': ['AAA', 'BBB']}}

_base = bt.run(dict(_spec))
ok('the ungated run trades every pair, so the gate has something to remove',
   _base['summary']['pairs'] == 6 and _base['summary']['trades'] == 6,
   (_base['summary']['pairs'], _base['summary']['trades']))

_asked = []
_saved_asof = canslim.asof


def _stub_asof(symbol, date, want=('m', 'l'), log=None):
    """AAA passes, BBB is blocked — and one BBB day cannot be read at all."""
    _asked.append((symbol, date))
    if symbol == 'BBB' and date == '2024-01-10':
        return {'symbol': symbol, 'date': date,
                'refused': {'l': 'no group for this stock on that day'}}
    pct = 92 if symbol == 'AAA' else 30
    return {'symbol': symbol, 'date': date, 'refused': {},
            'l': {'group_pct': pct, 'group': 'Stub & related'}}


try:
    canslim.asof = _stub_asof
    _gated = bt.run({**_spec, 'canslim': {'l_pct_min': 80}})
finally:
    canslim.asof = _saved_asof

_s = _gated['summary']
_c = _s['coverage']
ok('only the passing symbol trades', _s['trades'] == 3, _s['trades'])
ok('the blocked pairs are COUNTED, not dropped in silence',
   _c.get('canslim_blocked') == 2, _c.get('canslim_blocked'))
ok('...and the unreadable one is counted SEPARATELY — "failed the screen" and '
   '"the screen could not be run" are different facts',
   _c.get('canslim_unknown') == 1, _c.get('canslim_unknown'))
# THE ARITHMETIC THAT MAKES THE COUNTS WORTH PRINTING. Every pair is accounted
# for; a gate whose exclusions do not add up is hiding a third outcome.
ok('every pair is accounted for: evaluated + blocked + unreadable = pairs',
   _c['evaluated'] + _c['canslim_blocked'] + _c['canslim_unknown'] == _c['pairs'],
   (_c['evaluated'], _c['canslim_blocked'], _c['canslim_unknown'], _c['pairs']))
ok('the rules the run was gated on ride with the coverage, so a result cannot '
   'be read without them', _c.get('canslim') == {'l_pct_min': 80},
   _c.get('canslim'))
ok('...and the letters they needed', _c.get('canslim_letters') == ['l'],
   _c.get('canslim_letters'))
ok('samples name the day, the symbol and the reason',
   any('BBB' in x and '30' in x for x in (_c.get('canslim_samples') or [])),
   _c.get('canslim_samples'))
ok('the gate is asked AS OF THE PAIR\'S OWN DAY, never once for the run',
   len({d for _s2, d in _asked}) == 3 and ('AAA', '2024-01-09') in _asked,
   sorted(set(_asked)))
ok('the gate is OFF by default, and leaves no counters behind when it is — an '
   'empty count reads as a filter that ran and found nothing',
   'canslim' not in _base['summary']['coverage']
   and 'canslim_blocked' not in _base['summary']['coverage'])

# THE READING RIDES WITH THE TRADE. A report that can say a trade was allowed
# but not what it was allowed on cannot be checked against the live desk.
_ctx = [t.get('ctx') or {} for t in _gated['trades']]
ok('every trade carries the reading the gate saw',
   all(((c.get('canslim_asof') or {}).get('l') or {}).get('group_pct') == 92
       for c in _ctx), _ctx[:1])


# ── 4. A FAILED READ IS UNVERIFIABLE, NEVER A PASS ──────────────────────
#
# The direction of this one is the whole point. If an exception let the pair
# through, every outage would silently relax the screen and the run would
# report the wide result as though the gate had been applied.
print()
print('== an outage narrows the run, it does not widen it ==')


def _boom(symbol, date, want=('m', 'l'), log=None):
    raise RuntimeError('EDGAR unreachable')


try:
    canslim.asof = _boom
    _out = bt.run({**_spec, 'canslim': {'l_pct_min': 80}})
finally:
    canslim.asof = _saved_asof

_oc = _out['summary']['coverage']
ok('a gate that cannot be read takes NO trades', _out['summary']['trades'] == 0)
ok('...and every pair lands in unreadable, not in blocked',
   _oc['canslim_unknown'] == 6 and _oc['canslim_blocked'] == 0,
   (_oc['canslim_unknown'], _oc['canslim_blocked']))
ok('...and the reason survives to the samples, so the outage is diagnosable '
   'from the result rather than from the logs',
   any('EDGAR unreachable' in x for x in _oc.get('canslim_samples') or []),
   _oc.get('canslim_samples'))


# ── 5. COMPUTED ONCE PER DATE ───────────────────────────────────────────
#
# A register backtest asks for the same date once per symbol in that day's
# register. Rebuilding the group ranks each time turns a twenty-second job
# into an hour of them.
print()
print('== a date is built once and read many ==')

_built = []
_saved_build = canslim.build_day
_saved_cache = canslim.CACHE
try:
    canslim.CACHE = pathlib.Path(tempfile.mkdtemp())

    def _count(date, log=lambda _m: None):
        _built.append(date)
        return {'schema': canslim.SCHEMA, 'date': date,
                'm': {'status': 'confirmed_uptrend'},
                'l': {'stocks': {'AAA': {'group_pct': 92}}}, 'rs': {'AAA': 88}}

    canslim.build_day = _count
    a = canslim.day('2024-03-14')
    b = canslim.day('2024-03-14')
    ok('the same date is built once, however many times it is asked for',
       len(_built) == 1, _built)
    ok('...and the second read is the same answer, not a fresh one', a == b)
    ok('...written through a temp and renamed, so a reader never sees half a '
       'file', (canslim.CACHE / '2024-03-14.json').exists()
       and not list(canslim.CACHE.glob('*.tmp')))

    # A DAY WRITTEN BY OLDER CODE IS REBUILT, not read with the wrong keys.
    (canslim.CACHE / '2024-03-14.json').write_text(
        '{"schema": 0, "date": "2024-03-14"}')
    canslim.day('2024-03-14')
    ok('a cached day from an older schema is rebuilt rather than trusted',
       len(_built) == 2, _built)
finally:
    canslim.build_day = _saved_build
    canslim.CACHE = _saved_cache


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
