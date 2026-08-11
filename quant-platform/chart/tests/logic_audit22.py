"""In-Play universe filter (min_rvol) — honest SMB RVOL, not the snapshot.

The register's ctx_rvol is TradingView's `relative_volume_intraday|5`: the
relative volume of ONE 5-minute bar at the ~09:36 capture (SHPH printed 0.02
on a genuine M&A gap day, LUCY 2940 on one bar). SMB's screener number —
"RVOL > 5 tells us generally how In Play the stock is" (trades_.pdf) — is the
CUMULATIVE volume so far today vs the average by the same time of day. The
backtest's opt-in `min_rvol` filter therefore computes qp `volume.rel_volume`
at the strategy's session start and gates day·symbol PAIRS on it.

PART A — _rvol_at hand-checks: HOT 10x day → ~10, COLD flat → ~1,
         NEWB (no prior sessions) → None (unverifiable).
PART B — runner integration: min_rvol=5 trades HOT only; COLD counted
         'rvol_below', NEWB counted 'rvol_unknown'; the honest value rides
         in ctx as rvol_day; filter OFF trades all three and adds no keys.
"""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.backtest as bt

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

# 22 business days of 5m RTH bars (09:30..10:00 ET, 7 bars/day). HOT's last
# day runs 10x its baseline volume; COLD is flat; NEWB exists only on the
# last day (rel_volume has no prior sessions → NaN → unverifiable).
DAYS = [d.strftime('%Y-%m-%d') for d in pd.bdate_range(end='2024-02-01', periods=22)]
LAST = DAYS[-1]

def _mk(sym):
    idx, vol = [], []
    days = DAYS if sym != 'NEWB' else [LAST]
    for d in days:
        for k in range(7):
            idx.append(pd.Timestamp(f'{d} 09:30', tz='America/New_York')
                       + pd.Timedelta(minutes=5 * k))
            vol.append(1000.0 if (sym == 'HOT' and d == LAST) else 100.0)
    idx = pd.DatetimeIndex(idx).tz_convert('UTC')
    n = len(idx)
    px = np.full(n, 10.0)
    return pd.DataFrame({'open': px, 'high': px + 0.05, 'low': px - 0.05,
                         'close': px, 'volume': vol}, index=idx)

FRAMES = {s: _mk(s) for s in ('HOT', 'COLD', 'NEWB')}
class StubLoader:
    def load(self, symbol, tf, start, end):
        f = FRAMES.get(symbol)
        if f is None:
            return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'],
                                index=pd.DatetimeIndex([], tz='UTC'))
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['rv'] = StubLoader()

print("=" * 64)
print("PART A — _rvol_at: cumulative same-time-of-day RVOL, causal")
print("=" * 64)
rv_hot = bt._rvol_at('HOT', LAST, 'rv', 'all', 1000)
rv_cold = bt._rvol_at('COLD', LAST, 'rv', 'all', 1000)
rv_newb = bt._rvol_at('NEWB', LAST, 'rv', 'all', 1000)
ok("HOT: 10x volume day reads ~10.0", rv_hot is not None and abs(rv_hot - 10.0) < 0.01,
   f"got={rv_hot}")
ok("COLD: flat volume reads ~1.0", rv_cold is not None and abs(rv_cold - 1.0) < 0.01,
   f"got={rv_cold}")
ok("NEWB: no prior sessions → None (unverifiable)", rv_newb is None, f"got={rv_newb}")

print("=" * 64)
print("PART B — runner: min_rvol gates PAIRS, counts exclusions, rides ctx")
print("=" * 64)
STRAT = {'name': 'rvtest', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': [
             {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
              'right': {'kind': 'const', 'value': 0}}]},
         'exit': {'logic': 'AND', 'rules': [
             {'left': {'kind': 'price', 'field': 'close'}, 'op': 'gt',
              'right': {'kind': 'const', 'value': 0}}]},
         'risk': {'entry_mode': 'status'}}
def spec(**kw):
    return {'strategy': STRAT, 'tf': '5m', 'feed': 'rv', 'view': 'all',
            'fill': 'close', 'days': 1, 'start': LAST, 'end': LAST,
            'universe': {'kind': 'symbols', 'symbols': ['HOT', 'COLD', 'NEWB']},
            **kw}

r = bt.run(spec(min_rvol=5))
syms = {t['symbol'] for t in r['trades']}
cov = (r['summary'].get('coverage') or {})
ok("filtered run trades HOT only", syms == {'HOT'}, f"syms={syms}")
ok("COLD counted rvol_below, NEWB counted rvol_unknown",
   cov.get('rvol_below') == 1 and cov.get('rvol_unknown') == 1,
   f"cov={ {k: v for k, v in cov.items() if str(k).startswith('rvol')} }")
ok("filter setup recorded (min 5 at 1000 ET, samples named)",
   cov.get('rvol_min') == 5 and cov.get('rvol_at') == 1000
   and any('COLD' in s for s in cov.get('rvol_samples', [])),
   f"cov={cov.get('rvol_min'), cov.get('rvol_at'), cov.get('rvol_samples')}")
ok("the HONEST rvol rides in ctx as rvol_day (~10)",
   all(abs(float(t['ctx'].get('rvol_day', 0)) - 10.0) < 0.01 for t in r['trades'])
   and bool(r['trades']), f"ctx={[t['ctx'] for t in r['trades'][:1]]}")

r0 = bt.run(spec())
syms0 = {t['symbol'] for t in r0['trades']}
cov0 = (r0['summary'].get('coverage') or {})
ok("filter OFF: all three symbols trade", syms0 == {'HOT', 'COLD', 'NEWB'},
   f"syms={syms0}")
ok("filter OFF: no rvol keys in coverage, no rvol_day in ctx",
   'rvol_min' not in cov0
   and all('rvol_day' not in (t.get('ctx') or {}) for t in r0['trades']))

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
