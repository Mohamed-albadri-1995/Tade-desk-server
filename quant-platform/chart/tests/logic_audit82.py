"""09:35: does the BACKTEST do what the strategy SAYS, on every trade?

Asked as: "half at 2R, the rest leaves on the VWAP cross only after that —
make sure this is what really happens and what drives the backtest results,
not just what is supposed to happen."

A comment in the engine saying so is not evidence. This file is:

  1. It loads the REAL 09:35 strategy — chart/seeds/or_vwap.json, long and
     short, exactly as seeded — and runs the REAL backtest engine on it
     (`strategy.evaluate`, the function chart/backtest.py calls per pair).

  2. It runs the same days through chart/exports/or_vwap_0935.py — the setup
     written out as plain Python from the rules in English, sharing no code
     with the engine.

  3. It compares them TRADE BY TRADE: entry, stop, the 2R level, the bar the
     half banked, the bar and reason the rest left, and the return.

  4. Independently of both, it checks the claim itself on every engine trade:
     the runner never leaves on the VWAP rule before the 2R half has banked,
     and every trade whose price crossed VWAP before 2R was still held.

  5. It checks the NUMBER the report adds up: each trade's return is
     half × the 2R leg + half × the runner's exit, recomputed from prices.

Seeded random days, so a failure is reproducible. The generator biases the
opening five minutes so the gates pass often enough to test the exit.

Known, deliberate difference between the two implementations, allowed for
and counted rather than hidden: when the rule fires, the engine (next_open
fill) leaves at the NEXT bar's open — the first price an order can get — and
the reference books the cross bar's own close. Same decision bar; the price
differs by one bar. And a stop the bar GAPS through fills at the open in the
engine (the real cost) and at the stop in the reference.
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

HERE = pathlib.Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
sys.path.insert(0, str(HERE.parents[1] / 'exports'))
import chart.strategy as S                                          # noqa: E402
import tools.compare_server as cs                                   # noqa: E402
import or_vwap_0935 as REF                                          # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name}   {extra}')


SEED = json.loads((HERE.parents[1] / 'seeds' / 'or_vwap.json').read_text())
SEED = SEED if isinstance(SEED, list) else SEED.get('strategies', [SEED])
BY_SIDE = {s['side']: s for s in SEED if 'OR + VWAP 09:35' in s.get('name', '')}

ET = 'America/New_York'


def day_frame(rng, day, side):
    """Yesterday's last hour for ATR warm-up, then today 09:30-11:59."""
    prev = pd.Timestamp(day, tz=ET) - pd.Timedelta(days=1)
    idx, o, h, l, c, v = [], [], [], [], [], []
    px = 20.0 + rng.normal(0, 2)

    def bar(t, drift, vol):
        nonlocal px
        op = px
        px = max(1.0, px * (1 + drift + rng.normal(0, vol)))
        hi = max(op, px) * (1 + abs(rng.normal(0, vol / 2)))
        lo = min(op, px) * (1 - abs(rng.normal(0, vol / 2)))
        idx.append(t); o.append(op); h.append(hi); l.append(lo); c.append(px)
        v.append(float(rng.integers(20_000, 200_000)))

    for k in range(60):
        bar(prev + pd.Timedelta(hours=15, minutes=k), 0, 0.002)
    # overnight gap
    px *= 1 + rng.normal(0, 0.01)
    sgn = 1 if side == 'long' else -1
    t0 = pd.Timestamp(day, tz=ET) + pd.Timedelta(hours=9, minutes=30)
    for k in range(150):
        if k < 5:                                  # an opening drive
            drift = sgn * rng.uniform(0.0005, 0.004)
        else:                                      # then anything
            drift = rng.normal(0, 0.0012)
        bar(t0 + pd.Timedelta(minutes=k), drift, 0.0025)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v},
                        index=pd.DatetimeIndex(idx).tz_convert('UTC'))


def serve(df):
    ts = [int(x.value // 10**9) for x in df.index]
    cs.prepare_bars = lambda *a, **k: (df, ts, {'end': df.index[-1]})
    return ts


def engine(strategy, df):
    ts = serve(df)
    r = S.evaluate(strategy, 'X', '1m', 2, feed='yahoo', view='all', fill='next_open')
    if not r.get('ok'):
        raise RuntimeError(r.get('error'))
    return r, ts


rng = np.random.default_rng(935)
DAYS = pd.bdate_range('2026-03-02', periods=160)
stats = {'days': 0, 'eng': 0, 'ref': 0, 'both': 0, 'banked': 0, 'runner_exit': 0,
         'crossed_before_2R_and_held': 0, 'gap_price': 0, 'skipped_2R_under_10c': 0}
mism = []
early = []
retbad = []
held_bad = []

for side in ('long', 'short'):
    strategy = BY_SIDE[side]
    # The claim under test, stated from the file rather than assumed.
    assert strategy['exit']['scope'] == 'runner'
    assert strategy['risk']['targets'] == [{'fraction': 0.5, 'r_multiple': 2.0}]
    for day in DAYS:
        df = day_frame(rng, day.strftime('%Y-%m-%d'), side)
        stats['days'] += 1
        r, ts = engine(strategy, df)
        closed = [t for t in (r.get('trades') or [])
                  if pd.Timestamp(t['entry_ts'], unit='s', tz='UTC').tz_convert(ET).date() == day.date()]
        ref = REF.run_day(df, side=side)
        e = closed[0] if closed else None
        stats['eng'] += bool(e)
        stats['ref'] += bool(ref)
        if not e and not ref:
            continue
        if bool(e) != bool(ref):
            # An open engine trade at the frame's end is not a mismatch of
            # ENTRY: the reference books those 'eod'.
            ot = r.get('open_trade')
            if ref and ot:
                continue
            # THE STRATEGY'S OWN RULE, which the plain-Python reference does not
            # carry: `risk.min_target_usd: 0.1` skips a signal whose 2R target
            # is under ten cents from the fill. Counted, and checked to be
            # exactly that and nothing else.
            if ref and not e and (r.get('entry_drops') or {}).get('target_too_close') \
                    and abs(ref.target - ref.entry) < strategy['risk']['min_target_usd']:
                stats['skipped_2R_under_10c'] += 1
                continue
            mism.append((str(day.date()), side, 'entered in one only',
                         bool(e), ref and ref.reason))
            continue
        stats['both'] += 1
        idx = {t: i for i, t in enumerate(ts)}
        ei = idx[e['entry_ts']]
        xi = idx[e['exit_ts']]
        rix = df.index.get_loc(ref.entry_time)
        legs = e.get('legs') or []

        # 1. same entry, same stop, same 2R level
        same = (ei == rix and abs(e['entry'] - ref.entry) < 1e-9
                and abs(e['stop'] - ref.stop) < 1e-9)
        if legs:
            same = same and abs(legs[0]['price'] - ref.target) < 1e-9
        if not same:
            mism.append((str(day.date()), side, 'entry/stop/target',
                         (e['entry'], e['stop'], legs and legs[0]['price']),
                         (ref.entry, ref.stop, ref.target)))
            continue

        # 2. the half banked on the same bar, or neither banked
        eng_leg_bar = idx[legs[0]['exit_ts']] if legs else None
        ref_leg_bar = df.index.get_loc(ref.legs[0][0]) if ref.legs else None
        if (eng_leg_bar is None) != (ref_leg_bar is None) or \
                (eng_leg_bar is not None and eng_leg_bar != ref_leg_bar):
            mism.append((str(day.date()), side, '2R leg bar', eng_leg_bar, ref_leg_bar))
            continue
        stats['banked'] += bool(legs)

        # 3. the rest left on the same DECISION bar, for the same reason
        want = {'vwap exit': 'exit', 'SL': 'SL', 'eod': None}[ref.reason]
        ref_x = df.index.get_loc(ref.exit_time)
        reason = 'SL' if e['reason'] == 'trail' else e['reason']
        eng_decide = xi - 1 if reason == 'exit' else xi
        if reason != want or eng_decide != ref_x:
            mism.append((str(day.date()), side, 'exit', (e['reason'], eng_decide),
                         (ref.reason, ref_x)))
            continue

        # 4. THE CLAIM, checked on the engine's own trade: the VWAP rule never
        #    took the runner before the 2R half banked...
        if reason == 'exit':
            stats['runner_exit'] += 1
            if not legs or eng_leg_bar > eng_decide:
                early.append((str(day.date()), side, eng_leg_bar, eng_decide))
        # ...and a VWAP cross BEFORE 2R did not close it.
        vw = S._eval_group(strategy['exit'], df, {})
        first_cross = next((j for j in range(ei, xi) if vw[j]), None)
        if first_cross is not None and (eng_leg_bar is None or first_cross < eng_leg_bar):
            # Closed BY THE RULE on that cross would be the old live bug. Any
            # other outcome — held past it, or the stop on a later bar — is
            # the strategy as written.
            if reason == 'exit' and eng_decide == first_cross:
                held_bad.append((str(day.date()), side, first_cross, xi, e['reason']))
            else:
                stats['crossed_before_2R_and_held'] += 1

        # 5. THE NUMBER: half at 2R + the rest at its exit price
        sgn = 1 if side == 'long' else -1
        want_ret = sum(g['fraction'] * sgn * (g['price'] / e['entry'] - 1) for g in legs) \
            + (1 - sum(g['fraction'] for g in legs)) * sgn * (e['exit'] / e['entry'] - 1)
        if abs(want_ret - e['ret'] / (100.0 if abs(e['ret']) > 1.5 else 1.0)) > 1e-6 \
                and abs(want_ret * 100 - e['ret']) > 1e-4:
            retbad.append((str(day.date()), side, e['ret'], want_ret))
        if reason == 'SL' and abs(e['exit'] - ref.stop) > 1e-9:
            stats['gap_price'] += 1

# ── THE BOX'S 09:35 HAS NO `freeze` ON ITS STOP ──────────────────────────
#
# tools/audit_0935.py, run on the box 2026-09-24, printed "stop prim moving"
# for the strategy every stored run used — the seed says frozen. It should not
# matter, and this says whether it does: `levels.window_low/high(930, 935)` is
# the window [09:30, 09:35), and qp holds it flat for the rest of the day
# once the window closes (qp/primitives/levels.py `_window_extreme`). So the
# stop measured on every bar after the 09:34 decision is the same number.
# Run, not argued: the same days, the stop un-frozen, identical trades.
import copy                                                         # noqa: E402
unfrozen_diff = []
rng2 = np.random.default_rng(935)
for side in ('long', 'short'):
    frozen = BY_SIDE[side]
    loose = copy.deepcopy(frozen)
    loose['risk']['sl'].pop('freeze', None)
    for day in DAYS:
        df = day_frame(rng2, day.strftime('%Y-%m-%d'), side)
        a, _ = engine(frozen, df)
        b, _ = engine(loose, df)
        key = lambda r: [(t['entry_ts'], t['exit_ts'], t['reason'], round(t['ret'], 12),  # noqa: E731
                          t.get('stop')) for t in (r.get('trades') or [])]
        if key(a) != key(b):
            unfrozen_diff.append((str(day.date()), side))

print('\n── 09:35 as seeded, real engine vs plain-rules reference ─────────')
print(f'   {stats}')
ok('the engine and the reference found trades on the same days',
   not [m for m in mism if m[2] == 'entered in one only'],
   [m for m in mism if m[2] == 'entered in one only'][:5])
ok('same entry, same stop (OR mid), same 2R level on every shared trade',
   not [m for m in mism if m[2] == 'entry/stop/target'],
   [m for m in mism if m[2] == 'entry/stop/target'][:5])
ok('the half banked at 2R on the same bar on every shared trade',
   not [m for m in mism if m[2] == '2R leg bar'],
   [m for m in mism if m[2] == '2R leg bar'][:5])
ok('the rest left on the same bar, for the same reason',
   not [m for m in mism if m[2] == 'exit'], [m for m in mism if m[2] == 'exit'][:5])
ok('THE CLAIM: the VWAP rule never took the runner before 2R banked',
   not early, early[:5])
ok('THE CLAIM: a VWAP cross before 2R did not close the trade',
   not held_bad, held_bad[:5])
ok('every return is half × 2R leg + half × runner exit, from the prices',
   not retbad, retbad[:5])
ok('enough trades to mean something (≥ 40 shared, ≥ 10 runner exits, '
   '≥ 10 held through an early cross)',
   stats['both'] >= 40 and stats['runner_exit'] >= 10
   and stats['crossed_before_2R_and_held'] >= 10, stats)

ok("the box's un-frozen stop trades identically to the seed's frozen one "
   '(the opening range is held flat after 09:34)', not unfrozen_diff, unfrozen_diff[:5])

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
