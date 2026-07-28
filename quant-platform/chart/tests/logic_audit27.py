"""Print R1 sheet — one chart per register ticker, your TF + your indicators.

The sheet must show the register DAY in full extended hours (04:00-20:00 ET)
PLUS `days_before` prior calendar days, so the previous session's post-market
and the overnight into that morning's premarket are on the same chart.

PART A — window: bars start at 04:00 ET `days_before` days back, pre/post
         bars are KEPT (view='all') and tagged so the sheet can tint them.
PART B — every register ticker gets a chart; a broken symbol is skipped and
         named, never silently dropped.
PART C — indicator series are computed by qp and sliced to the same window.
PART D — the page renders with the chart library and each symbol's data.
"""
import sys, pathlib, json, re
import numpy as np, pandas as pd
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs
import chart.server as srv
import chart.screener as sc

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

ET = 'America/New_York'
DAY = '2026-07-14'

# 3 calendar days of 5m bars, 04:00-20:00 ET (pre + RTH + post)
def frame(sym):
    idx = []
    for d in ('2026-07-12', '2026-07-13', '2026-07-14'):
        t = pd.Timestamp(f'{d} 04:00', tz=ET)
        while t.hour < 20:
            idx.append(t); t += pd.Timedelta(minutes=5)
    idx = pd.DatetimeIndex(idx).tz_convert('UTC')
    n = len(idx)
    px = np.linspace(10.0, 11.0, n) if sym == 'AAA' else np.linspace(5.0, 4.5, n)
    return pd.DataFrame({'open': px, 'high': px + .05, 'low': px - .05,
                         'close': px, 'volume': np.full(n, 1e5)}, index=idx)

FR = {'AAA': frame('AAA'), 'BBB': frame('BBB')}
class Stub:
    def load(self, sym, tf, start, end):
        f = FR.get(sym)
        if f is None:
            raise RuntimeError('no data for ' + sym)
        return f[(f.index >= start) & (f.index < end)]
cs._LOADERS['prt'] = Stub()

# fake register: two good tickers + one that will fail to load
sc.register_rows = lambda register='R1', date=None, full=False: {
    'ok': True, 'rows': [{'ticker': 'AAA'}, {'ticker': 'BBB'}, {'ticker': 'ZZZ'}]}

OVS = [{'id': 'o1', 'key': 'ma.sma', 'source': 'close',
        'params': {'length': 9}, 'color': '#2563eb'}]

sc.available_dates = lambda register='R1': ['2026-07-13', '2026-07-14']

def sheets_of(html):
    m = re.search(r'const SHEETS = (\[.*?\]);\n', html, re.S)
    return json.loads(m.group(1)) if m else []

html = srv.r1_print(day=DAY, tf='5m', feed='prt', overlays=json.dumps(OVS),
                    register='R1', days_before=1, cols=1).body.decode()
sheets = sheets_of(html)
data = sheets[0]['charts'] if sheets else []

print("=" * 64)
print("PART A — window: 04:00 ET one day back, through the register day")
print("=" * 64)
ok("page built with chart data", bool(data), 'no DATA payload')
aaa = [c for c in data if c['symbol'] == 'AAA']
ok("AAA present", len(aaa) == 1)
if aaa:
    bars = aaa[0]['bars']
    first = pd.Timestamp(bars[0]['time'], unit='s', tz='UTC').tz_convert(ET)
    last = pd.Timestamp(bars[-1]['time'], unit='s', tz='UTC').tz_convert(ET)
    ok("starts 04:00 ET on the PREVIOUS day (07-13), not 09:30",
       first.strftime('%Y-%m-%d %H:%M') == '2026-07-13 04:00',
       f'first={first}')
    ok("ends on the register day (07-14), post-market included",
       last.strftime('%Y-%m-%d') == '2026-07-14' and last.hour >= 19,
       f'last={last}')
    sess = {b.get('sess') for b in bars}
    ok("pre / rth / post bars all kept and tagged",
       {'pre', 'rth', 'post'} <= sess, f'sess={sess}')
    ok("no bar older than the window start",
       all(b['time'] >= int(pd.Timestamp('2026-07-13 04:00', tz=ET).timestamp())
           for b in bars))

print("=" * 64)
print("PART B — every ticker charted; a broken one is named, not hidden")
print("=" * 64)
syms = [c['symbol'] for c in data]
ok("both good tickers charted", syms == ['AAA', 'BBB'], f'{syms}')
ok("the failing ticker is reported in the page", 'ZZZ' in html and 'skipped' in html)

print("=" * 64)
print("PART C — indicators computed by qp, sliced to the same window")
print("=" * 64)
if aaa:
    ser = aaa[0]['series']
    ok("the requested overlay produced a series", len(ser) >= 1, f'{len(ser)}')
    if ser:
        vals = ser[0]['values']
        ok("series has values", len(vals) > 10, f'{len(vals)}')
        ok("series never starts before the bars (same window)",
           vals[0]['time'] >= bars[0]['time'])
        # spot-check the 9-SMA against a hand computation on the same closes
        closes = [b['close'] for b in bars]
        want = sum(closes[:9]) / 9.0
        got = [v for v in vals if v['time'] == bars[8]['time']]
        ok("9-SMA value matches a hand-computed mean at bar 9",
           bool(got) and abs(got[0]['value'] - want) < 1e-6,
           f'got={got[:1]} want={want}')

print("=" * 64)
print("PART D — the page is self-contained and renderable")
print("=" * 64)
ok("loads the local chart library", '/static/lightweight-charts.js' in html)
ok("has a print button", 'window.print()' in html)
ok("names register, day, tf and indicators in the header",
   'R1' in html and DAY in html and '5m' in html and 'ma.sma' in html)

# days_before=0 must start on the register day itself
html0 = srv.r1_print(day=DAY, tf='5m', feed='prt', overlays='[]',
                     register='R1', days_before=0).body.decode()
d0 = sheets_of(html0)[0]['charts']
f0 = pd.Timestamp(d0[0]['bars'][0]['time'], unit='s', tz='UTC').tz_convert(ET)
ok("days_before=0 starts 04:00 ET on the register day",
   f0.strftime('%Y-%m-%d %H:%M') == '2026-07-14 04:00', f'{f0}')

print("=" * 64)
print("PART E — days AFTER, register-day highlight, and a DATE RANGE")
print("=" * 64)
# days_after=0 must stop at the end of the register day
if data:
    lastd = pd.Timestamp(data[0]['bars'][-1]['time'], unit='s',
                         tz='UTC').tz_convert(ET).strftime('%Y-%m-%d')
    ok("days_after=0 ends on the register day", lastd == '2026-07-14', lastd)
# the register day itself is flagged for the highlight band
if data:
    rd = {pd.Timestamp(b['time'], unit='s', tz='UTC').tz_convert(ET).strftime('%Y-%m-%d')
          for b in data[0]['bars'] if b.get('rd')}
    other = {pd.Timestamp(b['time'], unit='s', tz='UTC').tz_convert(ET).strftime('%Y-%m-%d')
             for b in data[0]['bars'] if not b.get('rd')}
    ok("ONLY the register day's bars carry the highlight flag",
       rd == {'2026-07-14'} and '2026-07-14' not in other, f'rd={rd} other={other}')
ok("the page draws a distinct register-day colour + a legend",
   'rgba(253,230,138,.55)' in html and 'register day' in html)

# a RANGE prints one section per register day
htmlR = srv.r1_print(start='2026-07-13', end='2026-07-14', tf='5m', feed='prt',
                     overlays='[]', register='R1', days_before=0,
                     days_after=0).body.decode()
sh = sheets_of(htmlR)
ok("range 07-13 → 07-14 prints BOTH register days",
   [x['day'] for x in sh] == ['2026-07-13', '2026-07-14'], f'{[x["day"] for x in sh]}')
# the day headers are rendered client-side from SHEETS, so assert the DATA
# drives them (one labelled section per register day) plus the page-break CSS
ok("each register day becomes its own labelled, page-broken section",
   len(sh) == 2 and all(x.get('day') for x in sh)
   and "h.textContent = 'register day ' + sheet.day" in htmlR
   and 'page-break-before:always' in htmlR)
# a range that matches no frozen day says so instead of printing nothing
htmlN = srv.r1_print(start='2020-01-01', end='2020-01-02', feed='prt').body.decode()
ok("empty range is reported, not silently blank", 'no frozen' in htmlN)

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
