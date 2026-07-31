"""How much history does each primitive need for TODAY'S value to be right?

Method: compute over a long history to get the reference value on the last
bars, then recompute over progressively shorter histories. The shortest
history whose value matches the reference is the warm-up actually required.
This measures the thing that matters (is the value on screen correct?) rather
than "when did the first non-NaN appear", which depends on where the frame
happens to start.
"""
import sys
sys.path.insert(0, '/home/user/Tade-desk-server/quant-platform')
import numpy as np, pandas as pd
import tools.compare_server as cs
from chart import data_manager as dm
import qp
from qp.registry import REGISTRY

ET = 'America/New_York'
END = pd.Timestamp('2026-07-30', tz=ET)
MASTER_DAYS = 400

# 1-minute master, weekdays, 04:00-20:00 ET. Every timeframe is resampled from
# it, so a compute_tf='1m' primitive really does get 1m bars.
idx = []
d = (END - pd.Timedelta(days=MASTER_DAYS)).normalize()
while d <= END:
    if d.weekday() < 5:
        idx.append(pd.date_range(d.replace(hour=4), d.replace(hour=19, minute=59),
                                 freq='1min', tz=ET))
    d += pd.Timedelta(days=1)
idx = pd.DatetimeIndex(np.concatenate([i.values for i in idx])).tz_localize(ET).tz_convert('UTC')
n = len(idx)
rng = np.random.default_rng(11)
px = 50 + np.cumsum(rng.normal(0, .01, n))
M1 = pd.DataFrame({'open': px, 'high': px + .05, 'low': px - .05, 'close': px,
                   'volume': rng.integers(1e3, 1e5, n).astype(float)}, index=idx)
print(f'master: {n} 1m bars, {idx[0]} -> {idx[-1]}')

_AGG = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'volume': 'sum'}
_RULE = {'1m': '1min', '2m': '2min', '5m': '5min', '15m': '15min', '30m': '30min',
         '1h': '1h', '1d': '1D'}
_CACHE = {}
def frame(tf):
    if tf not in _CACHE:
        _CACHE[tf] = (M1 if tf == '1m'
                      else M1.resample(_RULE.get(tf, '5min')).agg(_AGG).dropna())
    return _CACHE[tf]

class Stub:
    def load(self, sym, tf, start, end):
        f = frame(tf)
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['probe'] = Stub()

TF = '5m'
ASOF = '2026-07-30'
LADDER = [1, 2, 3, 5, 7, 10, 14, 20, 30, 45, 60, 90, 120, 200, 300]

def tail_values(days, key, params):
    """The last 40 RTH values of `key` computed over `days` of history.
    RTH, not simply the last bars: session primitives (every vwap.*,
    today_high, rel_volume) are NaN outside 09:30-16:00 by design, and the
    final bars of a 04:00-20:00 frame are post-market — sampling those would
    report a correct primitive as 'never produced a value'."""
    bars, ts, ctx = cs.prepare_bars('X', TF, days, 'probe', 'all', ASOF)
    if len(bars) < 50:
        return None, None
    _, _, lines = cs.overlay_arrays(
        bars, {'key': key, 'source': 'close', 'params': params}, ctx, causal=True)
    arr = np.asarray(lines[0][1], dtype=float)
    et = bars.index.tz_convert(ET)
    rth = np.array([(t.hour > 9 or (t.hour == 9 and t.minute >= 30)) and t.hour < 16
                    for t in et])
    pos = np.nonzero(rth)[0][-40:]
    if not len(pos):
        return None, None
    return bars.index[pos], arr[pos]

print(f'\n{"primitive":26s} {"needs(d)":>9s} {"granted":>8s}  verdict')
print('-' * 74)
bad, notes = [], []
for key, m in sorted(REGISTRY.items()):
    params = {p.name: p.default for p in (m.params or ())}
    try:
        _, ref = tail_values(300, key, params)
    except Exception as e:
        notes.append(f'{key}: ERR {str(e)[:50]}'); continue
    if ref is None or not np.isfinite(ref).any():
        notes.append(f'{key}: no finite value even with 300d'); continue
    need = None
    for h in LADDER:
        try:
            _, got = tail_values(h, key, params)
        except Exception:
            continue
        if got is None:
            continue
        both = np.isfinite(ref) & np.isfinite(got)
        # same finite pattern AND same numbers on the last bars
        if (np.isfinite(ref) == np.isfinite(got)).all() and both.any() \
                and np.allclose(ref[both], got[both], rtol=1e-9, atol=1e-9):
            need = h; break
    granted = dm.required_days([{'key': key, 'params': {}}], TF, 0)
    if need is None:
        bad.append((key, '>300', granted))
        print(f'{key:26s} {">300":>9s} {granted:8d}  NEEDS MORE THAN 300d')
    elif need > granted:
        bad.append((key, need, granted))
        print(f'{key:26s} {need:9d} {granted:8d}  UNDER-WARMED')
    else:
        print(f'{key:26s} {need:9d} {granted:8d}  ok')

print('\nUNDER-WARMED:')
for k, nd, g in bad:
    print(f'  {k}: needs {nd}d, granted {g}d')
if notes:
    print('\nnotes:')
    for x in notes:
        print('  ' + x)
