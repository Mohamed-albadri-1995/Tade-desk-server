"""Audit part 15 — backtest COVERAGE honesty.
A backtest that quietly skips half its universe (feed returns no bars) must
SAY so: summary.coverage counts evaluated / no-data / signal / traded pairs,
per-day pair counts, the median bar count, and the tf/feed/fill actually used.
Also: '' from an untouched UI select must normalize (feed '' -> polygon),
never reach the loaders as a mystery feed."""
import sys, pathlib
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.backtest as bt
import chart.screener as sc

PASS = 0; FAIL = 0
def chkv(name, got, exp):
    global PASS, FAIL
    if got == exp: PASS += 1
    else: FAIL += 1; print(f"  FAIL {name}: got={got!r} exp={exp!r}")


class StubLoader:
    """GOOD has 24/7 1m bars; NONE is a symbol the feed simply doesn't carry
    (empty frame) — the alpaca-IEX-small-cap situation."""
    def load(self, symbol, tf, start, end):
        if symbol == 'NONE':
            return pd.DataFrame({'open': [], 'high': [], 'low': [], 'close': [],
                                 'volume': []},
                                index=pd.DatetimeIndex([], tz='UTC'))
        idx = pd.date_range(start, end, freq='1min', tz='UTC')[:5000]
        base = np.full(len(idx), 50.0)
        return pd.DataFrame({'open': base, 'high': base + 0.05, 'low': base - 0.05,
                             'close': base + 0.01, 'volume': 1000.0}, index=idx)


cs._LOADERS['stub15'] = StubLoader()
T = lambda: {'kind': 'time', 'field': 'hhmm'}
C = lambda v: {'kind': 'const', 'value': v}
STRAT = {'name': 'cov', 'side': 'long',
         'entry': {'logic': 'AND', 'rules': [{'left': T(), 'op': 'eq', 'right': C(1400)}]},
         'exit': {'logic': 'AND', 'rules': []}}
RULES = {'rth_entries': True, 'eod_close': True}

print("== 1. symbols universe: no-data pairs are COUNTED, never silent ==")
out = bt.run({'strategy': STRAT, 'tf': '1m', 'days': 1, 'feed': 'stub15',
              'view': 'all', 'fill': 'close',
              'start': '2024-01-09', 'end': '2024-01-10',
              'universe': {'kind': 'symbols', 'symbols': ['GOOD', 'NONE']},
              'rules': RULES})
cov = out['summary'].get('coverage') or {}
chkv('4 pairs total', cov.get('pairs'), 4)
chkv('2 pairs actually had bars', cov.get('evaluated'), 2)
chkv('2 pairs had NO data', cov.get('no_data'), 2)
chkv('the no-data pairs are named',
     cov.get('no_data_samples'), ['2024-01-09 NONE', '2024-01-10 NONE'])
chkv('entry signal fired on both GOOD days', cov.get('signal_pairs'), 2)
chkv('one signal per day counted', cov.get('signals_on_day'), 2)
chkv('both signal days produced a trade', cov.get('traded_pairs'), 2)
chkv('pairs per day', cov.get('pairs_per_day'),
     {'2024-01-09': 2, '2024-01-10': 2})
chkv('median bars recorded', (cov.get('bars_median') or 0) > 100, True)
chkv('tf/feed/fill the run REALLY used',
     (cov.get('tf'), cov.get('feed'), cov.get('fill')), ('1m', 'stub15', 'close'))
chkv('trades match traded_pairs (eod-closed)', len(out['trades']), 2)
chkv('no errors — no-data is not an error', out['summary']['errors'], 0)

print("== 2. '' from untouched UI selects normalizes, never hits loaders ==")
_orig_poly = cs._LOADERS.get('polygon')
cs._LOADERS['polygon'] = StubLoader()
try:
    out2 = bt.run({'strategy': STRAT, 'tf': '', 'feed': '', 'view': '',
                   'fill': '', 'days': '',
                   'start': '2024-01-09', 'end': '2024-01-09',
                   'universe': {'kind': 'symbols', 'symbols': ['GOOD']},
                   'rules': RULES})
    cov2 = out2['summary'].get('coverage') or {}
    chkv("feed '' -> polygon", cov2.get('feed'), 'polygon')
    chkv("tf '' -> 5m", cov2.get('tf'), '5m')
    chkv("fill '' -> close", cov2.get('fill'), 'close')
    chkv('normalized run still evaluates', cov2.get('evaluated'), 1)
finally:
    if _orig_poly is not None:
        cs._LOADERS['polygon'] = _orig_poly
    else:
        cs._LOADERS.pop('polygon', None)

print("== 3. register universe: per-day membership visible in coverage ==")
_orig_ad, _orig_rr = sc.available_dates, sc.register_rows
try:
    sc.available_dates = lambda reg='R1': ['2024-01-09', '2024-01-10', '2024-01-11']
    _ROWS = {'2024-01-09': [{'ticker': 'GOOD', '_score': 9, 'regime': 2}],
             '2024-01-10': [{'ticker': 'GOOD', '_score': 5},
                            {'ticker': 'NONE', '_score': 1}]}
    sc.register_rows = lambda reg, d, full=False: {'ok': True, 'rows': _ROWS.get(d, [])}
    out3 = bt.run({'strategy': STRAT, 'tf': '1m', 'days': 1, 'feed': 'stub15',
                   'view': 'all', 'fill': 'close',
                   'start': '2024-01-09', 'end': '2024-01-10',   # excludes the 11th
                   'universe': {'kind': 'register', 'register': 'R1'},
                   'rules': RULES})
    cov3 = out3['summary'].get('coverage') or {}
    chkv('register pairs follow per-day membership', cov3.get('pairs_per_day'),
         {'2024-01-09': 1, '2024-01-10': 2})
    chkv('register no-data ticker counted', cov3.get('no_data'), 1)
    chkv('register card still rides on the trade',
         out3['trades'][0]['ctx'].get('_score'), 9)
finally:
    sc.available_dates, sc.register_rows = _orig_ad, _orig_rr

print(f"\nPASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
