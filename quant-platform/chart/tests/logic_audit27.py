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

# fake register: two good tickers + one that will fail to load. Rows carry the
# screener's frozen CARD (score/rvol/gap/... plus an extra column) exactly as
# register_rows(full=True) returns it, so the sheet and the cards export are
# tested against real-shaped metadata, not bare tickers.
def _fake_rows(register='R1', date=None, full=False):
    def row(t, sc_, px, rv):
        return {'ticker': t, 'date': date or DAY, 'score': sc_, 'price': px,
                'change': 0.12, 'gapPct': 18.4, 'rvol': rv, 'atr': 0.31,
                'regime': 'trend', 'secBias': 'up', 'sector': 'Biotech',
                'bias': 'long', 'catalyst': 'PR', 'inShortlist': True,
                'method': 'auto', 'floatShares': 4.2e6}
    return {'ok': True, 'rows': [row('AAA', 91, 10.5, 7.2), row('BBB', 74, 4.8, 3.1),
                                 row('ZZZ', 55, 2.0, 1.4)]}
sc.register_rows = _fake_rows

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
ok("names register, day and tf in the header",
   'R1' in html and DAY in html and '5m' in html)

print("=" * 64)
print("PART F — every indicator is NAMED with its own colour")
print("=" * 64)
# the series the engine produced carry a name and a colour...
if aaa:
    s0 = aaa[0]['series'][0]
    ok("series carries a human name", bool(s0.get('name')), f"{s0.get('name')}")
    ok("series carries the colour it is drawn with",
       s0.get('color') == '#2563eb', f"{s0.get('color')}")
    # ...and the sheet legend uses THOSE, so a swatch cannot disagree with a line
    ok("sheet legend names the indicator with a matching swatch",
       f'background:{s0["color"]}' in html and str(s0['name']) in html,
       f"name={s0.get('name')} color={s0.get('color')}")
ok("legend is labelled 'indicators:'", '<b>indicators:</b>' in html)
# PRINTING: browsers drop background colours by default, so on paper (and in
# Save-as-PDF) every swatch, the register-day header and the warning band came
# out blank — the "name every indicator with its colour" legend identified
# nothing. Verified against a real 40-page export.
ok("the sheet forces colours to survive printing",
   'print-color-adjust:exact' in html and '-webkit-print-color-adjust:exact' in html)
ok("...inside the @media print block too, not only on screen",
   html.split('@media print')[1][:220].count('print-color-adjust:exact') >= 1)
ok("the swatch has a border, so it is visible even if the fill is dropped",
   'border:1px solid rgba(0,0,0,.45)' in html)
if aaa:
    ok("each indicator NAME is drawn in its own line colour (text always prints)",
       f'<span class="ind" style="color:{s0["color"]}">' in html)
ok("the per-chart legend colours its names too",
   "'<span class=\"ind\" style=\"color:'+(s.color||'#2563eb')" in html)
ok("each chart also carries its own per-chart legend",
   "lg.innerHTML = c.series.map" in html)
ok("a failed indicator is labelled '(failed)', never drawn silently",
   "s.error ? ' (failed)'" in html and '(failed)' in html)

print("=" * 64)
print("PART G — multi-day indicators get real warm-up (2d VWAP, 5d MA)")
print("=" * 64)
from chart import data_manager as _dm
import qp as _qp
from qp.registry import REGISTRY as _REG
# 5-day MA: default length is 1950 ONE-MINUTE bars = 5 RTH sessions. Its
# warm-up must not depend on the chart timeframe, and must survive the picker
# sending params:{} (registry defaults).
d5_none = _dm.required_days([{'key': 'ma.pine_5day', 'params': {}}], '5m', 3)
d5_15m = _dm.required_days([{'key': 'ma.pine_5day', 'params': {}}], '15m', 3)
ok("5-day MA with DEFAULT params still gets multi-session warm-up",
   d5_none >= 7, f'{d5_none}d')
ok("5-day MA warm-up is timeframe-INVARIANT (computed on 1m)",
   d5_none == d5_15m, f'5m={d5_none} 15m={d5_15m}')
ok("5-day MA does not explode the fetch on a coarse TF",
   d5_15m <= 20, f'{d5_15m}d')
d2v = _dm.required_days([{'key': 'vwap.nday_block', 'params': {'n_days': 2}}], '1m', 3)
ok("2-day VWAP gets the multi-session floor", d2v >= 40, f'{d2v}d')
# Warm-up is EXTRA history added BEFORE the window (see logic_audit28 PART I),
# so every indicator adds something — but a 9-bar SMA must add a token amount,
# not a multi-session block like the 5-day MA does.
_sma9 = _dm.required_days([{'key': 'ma.sma', 'params': {'length': 9}}], '5m', 3)
ok("a plain 9-SMA adds only a token warm-up, never a multi-session block",
   3 < _sma9 <= 6, f'{_sma9}d for a 3-day window')
ok("...and far less than the 5-day MA needs",
   _sma9 < _dm.required_days([{'key': 'ma.pine_5day', 'params': {}}], '5m', 3),
   f'{_sma9} vs {_dm.required_days([{"key": "ma.pine_5day", "params": {}}], "5m", 3)}')
# the print sheet must ASK for that warm-up (it calls required_days per chart)
ok("the print sheet sizes its fetch with required_days",
   'dm.required_days(ovs, tf, span)' in
   open(pathlib.Path(__file__).resolve().parents[1] / 'server.py').read())

# days_before=0 must start on the register day itself
html0 = srv.r1_print(day=DAY, tf='5m', feed='prt', overlays='[]',
                     register='R1', days_before=0).body.decode()
d0 = sheets_of(html0)[0]['charts']
f0 = pd.Timestamp(d0[0]['bars'][0]['time'], unit='s', tz='UTC').tz_convert(ET)
ok("days_before=0 starts 04:00 ET on the register day",
   f0.strftime('%Y-%m-%d %H:%M') == '2026-07-14 04:00', f'{f0}')

print("=" * 64)
print("PART E — days AFTER, NO day highlight, session shading, DATE RANGE")
print("=" * 64)
# days_after=0 must stop at the end of the register day
if data:
    lastd = pd.Timestamp(data[0]['bars'][-1]['time'], unit='s',
                         tz='UTC').tz_convert(ET).strftime('%Y-%m-%d')
    ok("days_after=0 ends on the register day", lastd == '2026-07-14', lastd)
# NO register-day highlight: every day must be drawn identically. Only the
# SESSION is coloured, on ALL days (pre / post shaded, RTH plain).
if data:
    ok("no register-day flag on any bar (all days look the same)",
       all('rd' not in b for b in data[0]['bars']),
       f"flagged={[b for b in data[0]['bars'] if 'rd' in b][:1]}")
ok("the page has NO register-day tint colour",
   'rgba(253,230,138,.55)' not in html and 'fde68a' not in html.split('h3.day')[-1][:400])
ok("pre and post are coloured, RTH is transparent",
   "b.sess==='pre'  ? 'rgba(59,130,246,.16)'" in html
   and "b.sess==='post' ? 'rgba(168,85,247,.16)'" in html
   and "'rgba(0,0,0,0)'" in html)
ok("legend explains the shading applies to EVERY day",
   'extended hours on every day' in html and 'premarket' in html
   and 'post-market' in html)
# the shading must actually appear on a CONTEXT day too, not just the reg day
if data:
    ctx_sess = {b['sess'] for b in data[0]['bars']
                if pd.Timestamp(b['time'], unit='s', tz='UTC').tz_convert(ET)
                .strftime('%Y-%m-%d') == '2026-07-13'}
    ok("the day BEFORE also carries pre/rth/post tags (so it is shaded too)",
       {'pre', 'rth', 'post'} <= ctx_sess, f'{ctx_sess}')

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
   and 'h.textContent = "register day " + sheet.day' in htmlR
   and 'page-break-before:always' in htmlR)
# a range that matches no frozen day says so instead of printing nothing
htmlN = srv.r1_print(start='2020-01-01', end='2020-01-02', feed='prt').body.decode()
ok("empty range is reported, not silently blank", 'no frozen' in htmlN)

print("=" * 64)
print("PART H — CSV export: the SAME numbers as the sheet, one row per bar")
print("=" * 64)
import csv as _csv, io as _io
res = srv.r1_csv(day=DAY, tf='5m', feed='prt', overlays=json.dumps(OVS),
                 register='R1', days_before=1, days_after=0)
body = res.body.decode()
rows = list(_csv.reader(_io.StringIO(body)))
head, data_rows = rows[0], [r for r in rows[1:] if r and not r[0].startswith('#')]
ok("it downloads as a file, not a page",
   'attachment' in res.headers.get('content-disposition', '')
   and 'text/csv' in res.headers.get('content-type', ''),
   f"{res.headers.get('content-disposition')}")
ok("the filename names register, range and timeframe",
   '.csv' in res.headers.get('content-disposition', '')
   and 'R1' in res.headers.get('content-disposition', '')
   and '5m' in res.headers.get('content-disposition', ''))
ok("header carries the bar columns", head[:10] ==
   ['register_day', 'symbol', 'datetime_et', 'epoch', 'session',
    'open', 'high', 'low', 'close', 'volume'], f"{head[:10]}")
ok("...plus one column per indicator, named as the legend names it",
   head[10:] == ['sma(length=9)'], f"{head[10:]}")
# EXACTLY the sheet's bars — same count, same tickers, same window
sheet_bars = sum(len(c['bars']) for c in data)
ok("one row per bar of every chart on the sheet",
   len(data_rows) == sheet_bars, f"csv={len(data_rows)} sheet={sheet_bars}")
ok("the same tickers, and only those",
   sorted({r[1] for r in data_rows}) == ['AAA', 'BBB'],
   f"{sorted({r[1] for r in data_rows})}")
ok("every row is stamped with its register day",
   {r[0] for r in data_rows} == {DAY}, f"{ {r[0] for r in data_rows} }")
# value fidelity: the CSV close and indicator must EQUAL the chart's
aaa_csv = [r for r in data_rows if r[1] == 'AAA']
b0 = aaa[0]['bars'][0]
r0 = aaa_csv[0]
ok("row 1 is the chart's first bar (same epoch)", int(r0[3]) == b0['time'],
   f"{r0[3]} vs {b0['time']}")
ok("OHLCV match the chart bar exactly",
   [float(r0[5]), float(r0[6]), float(r0[7]), float(r0[8])]
   == [b0['open'], b0['high'], b0['low'], b0['close']], f"{r0[5:10]}")
ok("the session tag rides along (pre / rth / post)",
   {r[4] for r in aaa_csv} == {'pre', 'rth', 'post'}, f"{ {r[4] for r in aaa_csv} }")
ok("datetime is rendered in ET, not UTC",
   r0[2].endswith('04:00:00') and r0[2].startswith('2026-07-13'), f"{r0[2]}")
# the indicator column: warm-up EMPTY, then the chart's exact value
ind_by_ts = {int(v['time']): v['value'] for v in aaa[0]['series'][0]['values']}
csv_ind = {int(r[3]): r[10] for r in aaa_csv}
matched = [t for t in ind_by_ts if csv_ind.get(t) not in (None, '')]
ok("every drawn indicator value is in the CSV",
   len(matched) == len(ind_by_ts), f"{len(matched)}/{len(ind_by_ts)}")
ok("...to the same value, bar for bar",
   all(abs(float(csv_ind[t]) - ind_by_ts[t]) < 1e-9 for t in matched))
# and NOTHING is invented: a filled cell exists only where the chart had a
# point. (The window here starts AFTER the 9-SMA warmed up, so every bar has
# one — the empty-vs-zero rule is proved on the un-warmed indicator below.)
ok("no CSV value exists where the chart drew none",
   {t for t, v in csv_ind.items() if v != ''} == set(ind_by_ts))
# an indicator that never warms up inside the window must be BLANK, not 0 —
# a spreadsheet full of zeros would read as "the average was zero".
res0 = srv.r1_csv(day=DAY, tf='5m', feed='prt', register='R1', days_before=0,
                  overlays=json.dumps([{'id': 'w', 'key': 'ma.sma', 'source': 'close',
                                        'params': {'length': 5000}, 'color': '#000'}]))
r0rows = list(_csv.reader(_io.StringIO(res0.body.decode())))
w_col = [r[10] for r in r0rows[1:] if r and not r[0].startswith('#')]
ok("an indicator with no value in the window is EMPTY, never zero",
   bool(w_col) and set(w_col) == {''}, f"{sorted(set(w_col))[:3]}")
# a symbol that could not load is NAMED in the file, not silently missing
ok("the skipped ticker is recorded IN the csv", 'ZZZ' in body and '# skipped' in body)
# the sheet links to the csv of the SAME request
ok("the print sheet has a one-click CSV button for its own query",
   '/api/r1/csv?' in html and 'Bars CSV' in html)
ok("...carrying the same window parameters", 'days_before=1' in html and 'tf=5m' in html)
# duplicate indicator labels stay addressable (the user's two 5-day MAs)
res2 = srv.r1_csv(day=DAY, tf='5m', feed='prt', register='R1', days_before=0,
                  overlays=json.dumps([OVS[0], {**OVS[0], 'id': 'o2', 'color': '#dc2626'}]))
h2 = list(_csv.reader(_io.StringIO(res2.body.decode())))[0]
ok("the same indicator added twice yields two DISTINCT columns",
   h2[10:] == ['sma(length=9)', 'sma(length=9) #2'], f"{h2[10:]}")
# an empty range explains itself instead of producing a blank file
empty = srv.r1_csv(start='2020-01-01', end='2020-01-02', feed='prt').body.decode()
ok("an empty range says why, in the file", 'no frozen' in empty)

print("=" * 64)
print("PART I — the REGISTER CARD rides with every chart, and exports")
print("=" * 64)
# the sheet already fetched the register rows and kept only the ticker, so a
# chart showed a stock with no record of WHY the screener flagged it.
ok("each chart carries its register card",
   bool(aaa) and isinstance(aaa[0].get('card'), dict) and aaa[0]['card'].get('ticker') == 'AAA',
   f"{(aaa[0].get('card') if aaa else None)}")
ok("the rows are fetched with full=True (every frozen column, not the summary)",
   'sc.register_rows(register, d, full=True)' in
   open(pathlib.Path(__file__).resolve().parents[1] / 'server.py').read())
ok("the sheet renders the card under each chart", 'card-meta' in html and 'c.card' in html)
ok("well-known fields come first, in a FIXED order across charts",
   "['score','price','change','gapPct','rvol','atr','regime'," in html)
ok("...then any other column the register carried, alphabetically",
   'Object.keys(c.card).sort()' in html)
ok("empty fields are dropped, not printed as blanks",
   "if (v === null || v === undefined || v === '') return ''" in html)

cres = srv.r1_cards_csv(day=DAY, register='R1')
crows = list(_csv.reader(_io.StringIO(cres.body.decode())))
chead, cdata = crows[0], [r for r in crows[1:] if r and not r[0].startswith('#')]
ok("cards download as their own file",
   'attachment' in cres.headers.get('content-disposition', '')
   and 'cards' in cres.headers.get('content-disposition', ''))
ok("first two columns are the register day and the ticker",
   chead[:2] == ['register_day', 'ticker'], f"{chead[:2]}")
ok("one row per ticker on the register — INCLUDING ones with no chart",
   sorted(r[1] for r in cdata) == ['AAA', 'BBB', 'ZZZ'],
   f"{[r[1] for r in cdata]}")
ok("every row is stamped with the register day",
   {r[0] for r in cdata} == {DAY}, f"{ {r[0] for r in cdata} }")
ok("the known card fields keep their fixed column order",
   [c for c in chead if c in ('score', 'price', 'gapPct', 'rvol', 'atr')]
   == ['score', 'price', 'gapPct', 'rvol', 'atr'], f"{chead}")
ok("an extra column the register carried lands after the known ones",
   chead.index('floatShares') > chead.index('inShortlist'), f"{chead}")
# a range spans every register day in it
cres2 = srv.r1_cards_csv(start='2026-07-13', end='2026-07-14', register='R1')
c2 = [r for r in list(_csv.reader(_io.StringIO(cres2.body.decode())))[1:]
      if r and not r[0].startswith('#')]
ok("a date RANGE returns every register day in it",
   sorted({r[0] for r in c2}) == ['2026-07-13', '2026-07-14'],
   f"{sorted({r[0] for r in c2})}")
ok("an empty range says why", 'no frozen' in
   srv.r1_cards_csv(start='2020-01-01', end='2020-01-02').body.decode())
ok("the sheet links to BOTH exports for its own query",
   '/api/r1/cards.csv?' in html and 'Cards CSV' in html and 'Bars CSV' in html)

print("=" * 64)
print("PART J — print MY OWN (ticker, date) list, not a whole register day")
print("=" * 64)
P = srv.parse_pairs
ok("plain lines", P('AAA,2026-07-14\nBBB,2026-07-13')
   == [('AAA', '2026-07-14'), ('BBB', '2026-07-13')])
ok("a pasted TABLE with extra columns (result, entry, catalyst…)",
   P('1\tAAA\t2026-07-14\t8.46R\t2.48\tGap Up\n2\tBBB\t2026-07-13\t1.2R\t9\tM&A')
   == [('AAA', '2026-07-14'), ('BBB', '2026-07-13')])
ok("the same table pasted VERTICALLY, one cell per line",
   P('1\nAAA\n2026-07-14\n8.46R\n2.48\nGap Up\n2\nBBB\n2026-07-13')
   == [('AAA', '2026-07-14'), ('BBB', '2026-07-13')])
ok("prose words are not mistaken for tickers",
   P('Gap Up Bankruptcy Dilution AAA 2026-07-14') == [('AAA', '2026-07-14')])
ok("the SAME ticker on two dates is two entries (the journal case)",
   P('AAA,2026-07-13\nAAA,2026-07-14')
   == [('AAA', '2026-07-13'), ('AAA', '2026-07-14')])
ok("an exact duplicate line is collapsed",
   P('AAA,2026-07-14\nAAA,2026-07-14') == [('AAA', '2026-07-14')])
ok("junk yields nothing rather than a wrong pair", P('hello world 12345') == [])
ok("the preview endpoint reports what will be read",
   srv.pairs_parse({'pairs': 'AAA,2026-07-14'})
   == {'ok': True, 'count': 1, 'pairs': [{'ticker': 'AAA', 'date': '2026-07-14'}]})

lp = srv.pairs_print(pairs='AAA,2026-07-14\nBBB,2026-07-13', tf='5m', feed='prt',
                     overlays=json.dumps(OVS), days_before=1, days_after=0).body.decode()
lsh = sheets_of(lp)
ok("one section per DATE in the list, oldest first",
   [s['day'] for s in lsh] == ['2026-07-13', '2026-07-14'], f"{[s['day'] for s in lsh]}")
ok("each date charts only the tickers named for THAT date",
   [[c['symbol'] for c in s['charts']] for s in lsh] == [['BBB'], ['AAA']],
   f"{[[c['symbol'] for c in s['charts']] for s in lsh]}")
# the window is the same rule as the register sheet
lb = [c for s in lsh if s['day'] == '2026-07-14' for c in s['charts']][0]['bars']
first = pd.Timestamp(lb[0]['time'], unit='s', tz='UTC').tz_convert(ET)
ok("same window rule: 04:00 ET one TRADING day before the named date",
   first.strftime('%Y-%m-%d %H:%M') == '2026-07-13 04:00', f'{first}')
ok("same session tags, so the same pre/post shading",
   {b.get('sess') for b in lb} >= {'pre', 'rth', 'post'})
ok("the register card is still attached when the date IS a register day",
   any(c.get('card', {}).get('ticker') == 'AAA'
       for s in lsh for c in s['charts']))
ok("the day header has NO 'register day' prefix (these are your dates)",
   "h.textContent = \"\" + sheet.day" in lp, )
ok("the page names it as your list", 'my list' in lp)
ok("it carries its own CSV link", '/api/pairs/csv?' in lp)
ok("no Cards CSV button (a named date need not be a register day)",
   'Cards CSV' not in lp)
# a date the register never froze still charts — that is the whole point
free = srv.pairs_print(pairs='AAA,2026-07-12', tf='5m', feed='prt',
                       overlays='[]', days_before=0, days_after=0).body.decode()
ok("a NON-register date still produces a chart",
   [c['symbol'] for s in sheets_of(free) for c in s['charts']] == ['AAA'],
   f"{sheets_of(free)}")
# CSV of the list
lc = srv.pairs_csv(pairs='AAA,2026-07-14', tf='5m', feed='prt',
                   overlays=json.dumps(OVS), days_before=0, days_after=0)
lrows = list(_csv.reader(_io.StringIO(lc.body.decode())))
ok("the list CSV has the same columns as the register CSV",
   lrows[0][:10] == ['register_day', 'symbol', 'datetime_et', 'epoch', 'session',
                     'open', 'high', 'low', 'close', 'volume']
   and lrows[0][10:] == ['sma(length=9)'], f"{lrows[0]}")
ok("...and downloads as a file",
   'attachment' in lc.headers.get('content-disposition', ''))
ok("an unparseable list explains itself instead of printing nothing",
   'no TICKER' in srv.pairs_print(pairs='nothing here', feed='prt').body.decode())

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
