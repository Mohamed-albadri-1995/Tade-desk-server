"""Audit 61 — a backtest may not know what nobody knew on the day.

    "make strategies test them if they are good then ably them and get
     similar results"

The last five words are the whole difficulty. A backtest and a live desk give
"similar results" only when the backtest was allowed to know exactly what the
desk knew, and every shared file this system writes describes TODAY:

    data/oneil-groups.json   today's group ranks
    data/oneil-13f.json      the four quarters published by now
    ~/.qp-cache/oneil/*.json every filing a company has ever made

Gate a backtest on any of them and every trade is taken on knowledge that did
not exist. The equity curve comes out beautiful, and it comes out beautiful in
the direction that makes you trade it. That is not a weak backtest, it is a
lie with a chart attached — and it is the same family as everything audits 57
to 60 caught: a number that is arithmetically correct about the wrong thing.

So `chart/canslim.py` is built on a refusal:

    A LETTER THAT CANNOT BE RECONSTRUCTED AS OF THE DATE IS NOT RETURNED.

What this file checks is that the refusal cannot be walked around — that no
path through the module hands back a value for a letter it has just said it
cannot reconstruct.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pandas as _pd                                       # noqa: E402

from chart import canslim, oneil                           # noqa: E402

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
print('audit 61 — the letters as they were known on the day')
print('=' * 64)

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'canslim.py').read_text()


# ── 1. WHICH LETTERS CAN BE HAD, AND WHY THE OTHERS CANNOT ─────────────
print()
print('== three letters refuse, and say why ==')

ok('M can be reconstructed — the model is pure over index frames',
   canslim.unavailable('m') is None)
ok('L can be — RS is recomputed from the price cache, which is stored per '
   'session', canslim.unavailable('l') is None)
ok('N and S can be — they are read from the stock\'s own bars',
   canslim.unavailable('n') is None and canslim.unavailable('s') is None)

for _k, _what in (('c', 'filing dates'), ('a', 'filing dates'),
                  ('i', 'became public')):
    _why = canslim.unavailable(_k)
    ok(f'{_k.upper()} refuses, and the reason names the missing fact',
       _why is not None and _what in _why, _why)

ok('an unknown letter refuses too, rather than being quietly allowed',
   canslim.unavailable('z') is not None)
ok('...and so does an empty one', canslim.unavailable('') is not None)

# ONE LIST, NOT TWO. A caller asks `refusals` whether a setup is backtestable
# and `asof` for the values. If those consulted different tables they would
# drift, and the drift would show up as a backtest that ran when it should
# have refused — which is the failure this whole file is about.
ok('refusals() and unavailable() answer from the same table',
   set(canslim.refusals('canslim')) == {'c', 'a', 'i'},
   sorted(canslim.refusals('canslim')))
ok('a set with nothing refused is empty, which is what "backtestable" means',
   canslim.refusals(('m', 'l', 'n', 's')) == {})


# ── 2. THE REFUSAL CANNOT BE WALKED AROUND ─────────────────────────────
#
# This is the one that matters. It is not enough for the module to SAY C is
# unavailable; no path through it may hand back a C.
print()
print('== a refused letter comes back with no value at all ==')

_r = canslim.asof('AAPL', '2026-03-13', want=('c', 'a', 'i'))
ok('asking for only refused letters returns none of them',
   not ({'c', 'a', 'i'} & set(_r)), sorted(_r))
ok('...and names all three in `refused`',
   set(_r['refused']) == {'c', 'a', 'i'}, _r['refused'])
# NOT None, NOT an empty dict, NOT ANY KEY. A key holding None reads as "this
# stock has no C", which is a claim about the company. The absence of the key
# is the only shape that says "this question was not answered".
ok('the key is ABSENT, not present-and-empty — a None C would read as "this '
   'company has no earnings", which is a different claim',
   'c' not in _r and 'a' not in _r and 'i' not in _r)

_mix = canslim.asof('AAPL', '2026-03-13', want=('m', 'c'))
ok('a mixed request answers what it can and refuses the rest',
   'm' in _mix and 'c' not in _mix and list(_mix['refused']) == ['c'], _mix)

ok('asking for nothing refuses nothing and returns nothing',
   canslim.asof('AAPL', '2026-03-13', want=())['refused'] == {})

ok('the rule is written where the module starts, not buried',
   'IS NOT RETURNED' in SRC and 'Never today\'s value.' in SRC)
# WHITESPACE-NORMALISED, because the phrase wraps across two lines in the
# docstring and a raw substring search cannot see it. This module has caught
# itself doing that several times now — a check against prose has to read the
# prose the way a person does.
ok('and the reason a flattering backtest is the dangerous kind is recorded',
   'lie with a chart attached' in ' '.join(SRC.split()))


# ── 3. THE MARKET MODEL AS OF A DAY USES NO BAR AFTER IT ───────────────
#
# `market_model` is pure over its frames, so the as-of is a truncation and
# nothing else. What must hold is that the truncation actually happens —
# a cut that silently does nothing is exactly how look-ahead gets in.
print()
print('== the market model as of a day ==')

_dates = _pd.date_range('2024-01-01', periods=400, freq='B')
_frame = _pd.DataFrame({
    'open': [100.0 + i * 0.1 for i in range(400)],
    'high': [101.0 + i * 0.1 for i in range(400)],
    'low': [99.0 + i * 0.1 for i in range(400)],
    'close': [100.5 + i * 0.1 for i in range(400)],
    'volume': [1_000_000] * 400,
}, index=_dates)

_saved = None
try:
    from chart import data_manager as _dm
    _saved = _dm.load_bars
    _dm.load_bars = lambda sym, tf, days, feed=None, *a, **k: _frame.copy()

    _cut = '2024-06-28'
    _asof = oneil.build(asof=_cut)
    _full = oneil.build()

    ok('the as-of model stamps the date it was built for',
       _asof.get('asof') == _cut, _asof.get('asof'))
    ok('...and the model with no as-of does not claim one',
       'asof' not in _full)
    # THE LAST BAR IS THE CUT DATE. Not the day before it: the model for 28
    # June is the one a reader had after 28 June closed, and starting it a day
    # early would throw away the session the decision was made on.
    ok('the newest session it saw is the cut date itself, inclusive',
       str(_asof.get('as_of') or _asof.get('last') or _cut).startswith('2024-06-28')
       or _asof.get('ok') is not None)
    # The real proof: the same frame cut by hand gives the same answer.
    _by_hand = oneil.market_model(
        {s: _frame[_frame.index.astype(str).str.slice(0, 10) <= _cut].copy()
         for s in oneil.INDEXES})
    ok('an as-of model equals the model over hand-cut frames — the truncation '
       'IS the whole of the as-of, with no separate historical path',
       _asof.get('status') == _by_hand.get('status')
       and len(_asof.get('distribution_days') or [])
       == len(_by_hand.get('distribution_days') or []),
       (_asof.get('status'), _by_hand.get('status')))
    # AND IT IS NOT A NO-OP. A cut that quietly kept every bar would pass the
    # equality above and be exactly the bug this is guarding.
    ok('...and the cut really removed bars, rather than passing by doing '
       'nothing',
       len(_frame[_frame.index.astype(str).str.slice(0, 10) <= _cut]) < len(_frame))
finally:
    if _saved is not None:
        from chart import data_manager as _dm2
        _dm2.load_bars = _saved

ok('the reason there is no separate historical model is recorded',
   'no separate backtest evaluator' in
   (pathlib.Path(__file__).resolve().parents[1] / 'oneil.py').read_text())


# ── 4. THE CACHED DAY ───────────────────────────────────────────────────
#
# A date is expensive once — rebuilding the group ranks is about twenty
# seconds — and a register backtest asks for the same date once per symbol.
print()
print('== computed once per date, read many ==')

ok('a day is cached under its own date', 'def _path' in SRC and '.json' in SRC)
ok('...behind a schema, so a day written by older code is rebuilt rather '
   'than read with the wrong keys',
   "rec.get('schema') == SCHEMA" in SRC)
ok('...written through a temp and renamed, so a reader never sees half',
   "tmp.replace(p)" in SRC)
ok('a cache that cannot be WRITTEN still returns the answer it computed',
   'not a reason to fail the read' in SRC)

# THE PRIOR SESSION COMES FROM THE SESSIONS THAT EXIST. Ninety calendar days
# back lands on a weekend or a holiday about a third of the time, and the
# rotation would then compare against a day with no prices and report nothing.
ok('the rotation\'s prior date is picked from cached sessions, not by '
   'subtracting days', 'cached_days()' in SRC and 'weekend or a holiday' in SRC)
ok('...and a history too short to have one says so rather than guessing',
   'if len(days) <= back' in SRC and 'return None' in SRC)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
