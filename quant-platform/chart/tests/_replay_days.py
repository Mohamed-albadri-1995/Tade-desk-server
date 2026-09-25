"""Shared by logic_audit90 (the decision) and logic_audit93 (the manager):
seeded random days, the two live setups, and a way to serve a frame."""
import json
import pathlib

import numpy as np
import pandas as pd

import tools.compare_server as cs

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


