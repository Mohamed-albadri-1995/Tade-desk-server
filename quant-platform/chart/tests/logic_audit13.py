"""Audit part 13 — Phase-1 foundation: higher-timeframe look-ahead.

Daily bars are stamped at the day's START, so the default at-or-before
reindex hands day D's COMPLETED daily value (full-day range/volume) to D's
own intraday bars. That matches TradingView's historical intraday drawing
(how atr_daily/avg_volume passed TV verification) so the CHART keeps it —
but the STRATEGY/BACKTEST layer must be causal: intraday bars during D may
only see D-1's completed value. This pins both behaviors.
"""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.strategy as S

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")

# ── controlled data ──────────────────────────────────────────────────────────
# dailies (stamped at ET midnight = day start), hand-picked true ranges:
#   D2 (Jan-10): H11 L10 C10.5, prevC 10   -> TR = max(1, 1, 0)   = 1.0
#   D3 (Jan-11): H15 L10 C14,   prevC 10.5 -> TR = max(5, 4.5, .5) = 5.0
_daily_idx = pd.DatetimeIndex([pd.Timestamp(f'2024-01-{d:02d} 00:00',
                               tz='America/New_York') for d in (8, 9, 10, 11)]).tz_convert('UTC')
DAILY = pd.DataFrame({'open':  [10, 10, 10.2, 11],
                      'high':  [10.5, 10.5, 11, 15],
                      'low':   [9.5, 9.5, 10, 10],
                      'close': [10, 10, 10.5, 14],
                      'volume': [1000, 1000, 2000, 9000]}, index=_daily_idx)

class FakeLoader:
    def load(self, symbol, tf, start, end):
        assert tf == '1d', f'test loader only serves dailies, asked {tf}'
        return DAILY

# display: 1m bars during D3's morning (09:30-09:34 ET, Jan-11)
_disp_idx = pd.date_range('2024-01-11 09:30', periods=5, freq='1min',
                          tz='America/New_York').tz_convert('UTC')
BARS = pd.DataFrame({'open': 11.0, 'high': 11.1, 'low': 10.9, 'close': 11.0,
                     'volume': 500.0}, index=_disp_idx)
CTX = {'symbol': 'X', 'tf': '1m', 'loader': FakeLoader(),
       'start': _disp_idx[0], 'end': _disp_idx[-1]}
OV = {'key': 'volatility.atr_daily', 'source': 'close', 'params': {'length': 1}}

print("== 1. default (chart/TV-parity): intraday D3 sees D3's full-day TR ==")
_, _, lines = cs.overlay_arrays(BARS, OV, CTX)
chkv('chart mode = 5.0 (D3 TR, the TV repaint)', round(float(lines[0][1][0]), 4), 5.0)

print("== 2. causal (strategy/backtest): intraday D3 sees D2's TR only ==")
_, _, linesC = cs.overlay_arrays(BARS, OV, CTX, causal=True)
chkv('causal mode = 1.0 (last COMPLETED day)', round(float(linesC[0][1][0]), 4), 1.0)
chkv('same on every bar of the day', {round(float(v), 4) for v in linesC[0][1]}, {1.0})

print("== 3. avg_volume: same law ==")
OVV = {'key': 'volume.avg_volume', 'source': 'close', 'params': {'length': 2}}
_, _, lv = cs.overlay_arrays(BARS, OVV, CTX)
_, _, lvC = cs.overlay_arrays(BARS, OVV, CTX, causal=True)
chkv('chart avg_vol includes D3 ((2000+9000)/2)', round(float(lv[0][1][0]), 1), 5500.0)
chkv('causal avg_vol ends at D2 ((1000+2000)/2)', round(float(lvC[0][1][0]), 1), 1500.0)

print("== 4. the ENGINE reads causally ==")
arr = S._operand_array({'kind': 'primitive', 'key': 'volatility.atr_daily',
                        'params': {'length': 1}}, BARS, CTX)
chkv('engine operand = causal 1.0', round(float(arr[0]), 4), 1.0)
# and inside an expr (the user's 'moved > 2 daily ATR' pattern)
expr = {'kind': 'expr', 'op': 'mul',
        'a': {'kind': 'primitive', 'key': 'volatility.atr_daily', 'params': {'length': 1}},
        'b': {'kind': 'const', 'value': 2}}
arr2 = S._operand_array(expr, BARS, CTX)
chkv('expr sees causal too (2x1.0)', round(float(arr2[0]), 4), 2.0)

print("== 5. same-TF display (daily chart): no reindex, both modes equal ==")
CTX_D = {**CTX, 'tf': '1d'}
_, _, ld = cs.overlay_arrays(DAILY, OV, CTX_D)
_, _, ldC = cs.overlay_arrays(DAILY, OV, CTX_D, causal=True)
chkv('daily display identical in both modes',
     [round(float(v), 4) for v in ld[0][1]] == [round(float(v), 4) for v in ldC[0][1]], True)
chkv('daily D3 value is its own TR (known at D3 close)', round(float(ld[0][1][-1]), 4), 5.0)

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
