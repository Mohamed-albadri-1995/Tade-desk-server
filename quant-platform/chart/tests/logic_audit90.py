"""The live decision, replayed minute by minute, takes the backtest's trades.

Asked 2026-09-25: "carefully inspect live decision and manager and make sure
they are accurate". The live desk never sees a whole day. At each minute it
asks chart/decide.py about bars that END at the bar just closed, with
fill='live', and places a pick only when its entry is stamped that minute
(anything older is dropped as stale by src/setups/runner.js). A backtest sees
the whole day at once with fill='desk'.

So this replays a day the way the desk lives it: for every minute of the
setup's window, the frame is cut at that minute and decide.evaluate_symbol is
called exactly as qp's /api/strategy/decide calls it. The picks collected that
way must be the backtest's trades — same decision minute, same side, same
stop — for:

  - OR + VWAP 09:35 (the seed, both sides), one decision minute;
  - Test (a long with a VWAP-band stop and scale-out targets), a two-hour
    window with re-entries.

Random but seeded days, so a failure is reproducible. A final check proves the
harness can see a difference: a stop measured differently, or an entry a bar
late, must NOT match.
"""
import json
import pathlib
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.decide as D                                             # noqa: E402
import chart.strategy as S                                           # noqa: E402
import tools.compare_server as cs                                    # noqa: E402

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


ET = 'America/New_York'
DAY = '2026-09-16'
RULES = {'rth_entries': True, 'eod_close': True}
PR = lambda k, **p: {'kind': 'primitive', 'key': k, 'source': 'close', 'params': p}  # noqa: E731
CLOSE = {'kind': 'price', 'field': 'close'}
TEST = {
    'name': 'Test', 'side': 'long',
    'risk': {'sl': {'type': 'prim', 'value': None,
                    'anchor': dict(PR('vwap.stdev_bands', mult=0.2), sub='lower', hold=True)},
             'tp': {'type': '', 'value': None},
             'window_start': 930, 'window_end': 1130,
             'targets': [{'fraction': 0.1, 'r_multiple': 3}, {'fraction': 0.8, 'r_multiple': 6}]},
    'entry': {'logic': 'AND', 'window': 10, 'k': 1, 'rules': [
        {'left': CLOSE, 'op': 'gt', 'right': PR('levels.day_open')},
        {'left': CLOSE, 'op': 'gt', 'right': PR('vwap.session')},
        {'left': PR('ma.sma', length=9), 'op': 'gt', 'right': PR('ma.sma', length=13)},
        {'left': PR('ma.sma', length=13), 'op': 'cross_above', 'right': PR('vwap.session')}]},
    'exit': {'logic': 'AND', 'window': 10, 'k': 1, 'rules': []},
}
_seed = json.loads((pathlib.Path(__file__).resolve().parents[1] / 'seeds' / 'or_vwap.json').read_text())
_seed = _seed if isinstance(_seed, list) else _seed.get('strategies', [_seed])
ORV = [s for s in _seed if 'OR + VWAP 09:35' in s.get('name', '')]


def day_frame(rng):
    """Yesterday's session, today's premarket from 08:30, then 09:30-12:30
    with a push in the first five minutes — enough to make both setups fire."""
    prev = pd.Timestamp(DAY, tz=ET) - pd.Timedelta(days=1)
    idx, o, h, l, c, v = [], [], [], [], [], []
    px = [20.0 + rng.normal(0, 2)]

    def bar(t, drift, vol):
        op = px[0]
        px[0] = max(1.0, px[0] * (1 + drift + rng.normal(0, vol)))
        idx.append(t); o.append(op); c.append(px[0])
        h.append(max(op, px[0]) * (1 + abs(rng.normal(0, vol / 2))))
        l.append(min(op, px[0]) * (1 - abs(rng.normal(0, vol / 2))))
        v.append(float(rng.integers(20000, 200000)))
    for k in range(390):
        bar(prev + pd.Timedelta(hours=9, minutes=30 + k), 0, 0.002)
    px[0] *= 1 + rng.normal(0, 0.01)
    for k in range(60):
        bar(pd.Timestamp(DAY, tz=ET) + pd.Timedelta(hours=8, minutes=30 + k), rng.normal(0, 0.001), 0.002)
    sgn = rng.choice([-1, 1])
    t0 = pd.Timestamp(DAY, tz=ET) + pd.Timedelta(hours=9, minutes=30)
    for k in range(180):
        drift = sgn * rng.uniform(0.0005, 0.004) if k < 5 else rng.normal(0, 0.0015)
        bar(t0 + pd.Timedelta(minutes=k), drift, 0.0025)
    return pd.DataFrame({'open': o, 'high': h, 'low': l, 'close': c, 'volume': v},
                        index=pd.DatetimeIndex(idx).tz_convert('UTC'))


def serve(df):
    ts = [int(x.value // 10**9) for x in df.index]
    cs.prepare_bars = lambda *a, **k: (df, ts, {'end': df.index[-1]})


def hhmm(t):
    return f'{t.hour:02d}:{t.minute:02d}'


def rnd(x):
    return round(float(x), 4) if x is not None and x == x else None


def backtest(strats, df):
    """(decision minute, side, stop) of every trade on DAY — the decision is
    the bar before the desk fill's entry."""
    serve(df)
    out = []
    for s in strats:
        r = S.evaluate(s, 'X', '1m', 2, feed='yahoo', view='all', fill='desk', rules=RULES)
        assert r.get('ok'), r.get('error')
        rows = [(t['entry_ts'], t.get('stop')) for t in r.get('trades') or []]
        ot = r.get('open_trade')
        if ot:
            rows.append((ot.get('time', ot.get('entry_ts')), ot.get('stop')))
        for ets, stop in rows:
            dec = pd.Timestamp(ets - 60, unit='s', tz='UTC').tz_convert(ET)
            if dec.date().isoformat() == DAY:
                out.append((hhmm(dec), s['side'], rnd(stop)))
    return sorted(out)


def live(strats, df, lo, hi, fill='live'):
    """Every minute of the window: bars cut at that minute, decide as qp does,
    keep the picks stamped that minute (the runner drops older ones)."""
    et = df.index.tz_convert(ET)
    picks, errs = set(), []
    for m in range(len(df)):
        t = et[m]
        if t.date().isoformat() != DAY or not (lo <= t.hour * 60 + t.minute <= hi):
            continue
        serve(df.iloc[:m + 1])
        for r in D.evaluate_symbol(strats, 'X', DAY, '1m', 'yahoo', days=2, fill=fill, view='all'):
            if r.get('error'):
                errs.append((hhmm(t), r['error']))
            elif r.get('entry_at') == hhmm(t):
                picks.add((hhmm(t), r['side'], rnd(r.get('stop'))))
    return sorted(picks), errs


CASES = [('OR + VWAP 09:35', ORV, 9 * 60 + 34, 9 * 60 + 34),
         ('Test', [TEST], 9 * 60 + 29, 11 * 60 + 29)]
ok('the OR + VWAP 09:35 seed is found', len(ORV) >= 1, [s.get('name') for s in _seed])

rng = np.random.default_rng(7)
frames = [day_frame(rng) for _ in range(8)]
real_orig = cs.prepare_bars
try:
    for name, strats, lo, hi in CASES:
        print(f'== {name}: 8 days replayed minute by minute ==')
        n_trades, bad = 0, []
        for i, df in enumerate(frames):
            bt = backtest(strats, df)
            lv, errs = live(strats, df, lo, hi)
            n_trades += len(bt)
            if bt != lv or errs:
                bad.append((i, bt, lv, errs[:2]))
        ok(f'{name}: every live pick is a backtest trade and every trade a live pick',
           not bad, bad[:2])
        ok(f'{name}: the days produced trades to compare', n_trades >= 3, n_trades)

    print('== the replay can see a difference ==')
    import copy
    wider = copy.deepcopy(TEST)
    wider['risk']['sl']['anchor']['params']['mult'] = 0.3
    late = stop_off = 0
    for df in frames:
        bt = backtest([TEST], df)
        stop_off += bt != live([wider], df, 9 * 60 + 29, 11 * 60 + 29)[0]
        late += bt != live([TEST], df, 9 * 60 + 29, 11 * 60 + 29, fill='next_open')[0]
    ok('a live stop 0.3 bands out instead of 0.2 is caught', stop_off > 0, stop_off)
    ok('a live entry a bar late (next_open) is caught', late > 0, late)
finally:
    cs.prepare_bars = real_orig

print(f'PASS={PASS} FAIL={FAIL}')
sys.exit(1 if FAIL else 0)
