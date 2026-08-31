"""Audit part 47 — the SWING sheet: a year before, the found day, and since.

WHY THIS EXISTS.

The register print sheet is a DAY TRADE sheet and every choice in it says so:
1-minute bars, a window of one or two sessions, extended hours shaded because
the premarket is where the setup forms. It answers "what did this stock do on
the morning it was found".

A swing sheet asks the other question —

    where was this stock in its OWN year when the scanner found it, and what
    has it done in every session since?

— and NOT ONE of those choices survives the change. This file exists because
the cheap way to build it (the intraday sheet with different numbers) produces
a page that is wrong in three ways at once and looks right in all of them:

PART A — the window: a trading year BEFORE, and everything AFTER, to the last
         bar that exists rather than to a number somebody picked.
PART B — the found day is MARKED, which is the rule the intraday sheet
         deliberately breaks the other way.
PART C — the numbers the sheet exists to produce, INCLUDING the adverse one.
PART D — the legend cannot describe a chart nobody drew.
PART E — the page it renders is valid, and the two mark-setters do not erase
         each other.
"""
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0
FAIL = 0


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {name}')
    else:
        FAIL += 1
        print(f'  FAIL {name} {extra}')


from chart import server as srv                                # noqa: E402

SRC = (pathlib.Path(__file__).resolve().parents[1] / 'server.py').read_text()


print('== A. the window: a year before, everything after ==')
w, span = srv._swing_window('2026-08-19', 252)
ok('the window starts a trading YEAR before the found day',
   350 <= (__import__('pandas').Timestamp('2026-08-19', tz=w.tz) - w).days <= 380,
   (__import__('pandas').Timestamp('2026-08-19', tz=w.tz) - w).days)

# TRADING days, not calendar. 252 calendar days back from a Wednesday is eight
# months, not a year, and the 52-week high would simply not be on the chart.
w60, _ = srv._swing_window('2026-08-19', 60)
ok('...counted in TRADING days, so 60 is ~12 weeks and not 60 days',
   80 <= (__import__('pandas').Timestamp('2026-08-19', tz=w60.tz) - w60).days <= 95,
   (__import__('pandas').Timestamp('2026-08-19', tz=w60.tz) - w60).days)

# THE FETCH RUNS TO NOW. An older register day needs MORE history fetched, not
# the same amount shifted back — the whole point is every session since.
old, span_old = srv._swing_window('2026-01-15', 252)
ok('an older found day needs a longer fetch, because "since" is longer',
   span_old > span, (span_old, span))

# ...and there is no days_after at all. A fixed number after would give a name
# found last week the same window as one found in January, and only one of
# those is the honest answer for that name.
# The SIGNATURE, not the docstring — the docstring says so in words, and a
# search that matched those words would pass on an endpoint that took one.
_sig = SRC.split('def r1_swing(')[1].split('):')[0]
ok('there is no days_after parameter on the swing endpoint',
   'days_after' not in _sig, _sig)
ok('...and the request is LIVE, not anchored to the found day',
   "asof" not in SRC.split('def _build_swing_sheets(')[1].split('\ndef ')[0]
   .split('cs.compute_data(')[1].split(')')[0])


print()
print('== B. the found day is marked ==')
# The intraday sheet's rule is the opposite ON PURPOSE — there the window is
# two sessions and you can see which is which. Here it is one bar in three
# hundred, and unmarked it cannot be found at all. Both rules are in the file.
ok('the intraday sheet still refuses to colour its register day',
   'the register day gets no special colour' in SRC)
ok('...and the swing sheet says why it does the opposite',
   'bar in three hundred' in SRC.replace('\n', ' ').replace('#', ' '))

# Found BY DATE, not by an assumed hour. Daily bars are stamped at the session
# date and the hour differs between loaders; an assumed one marks nothing on
# the feed that disagrees.
ok('the found bar is located by its ET DATE', '.tz_convert(cs._ET).date()' in SRC)

# A missing bar on the found day is SAID, never silently unmarked: an unmarked
# chart looks like every other one and would be read as "found here", pointing
# at nothing.
ok('no bar on the found day is reported, not skipped',
   'no daily bar ON the found day' in SRC)


print()
print('== C. the numbers, including the one nobody wants ==')
bars = [
    {'time': 100, 'open': 9, 'high': 10, 'low': 9, 'close': 10.0},   # before
    {'time': 200, 'open': 10, 'high': 10, 'low': 10, 'close': 10.0},  # FOUND
    {'time': 300, 'open': 10, 'high': 11, 'low': 7.5, 'close': 8.0},  # dipped
    {'time': 400, 'open': 8, 'high': 15, 'low': 8, 'close': 13.0},    # then ran
]
s = srv._swing_stats(bars, 200)
ok('where it was when it was found', s['close'] == 10.0)
ok('where it is now', s['last'] == 13.0)
ok('...and the move since, from the found CLOSE', s['since_pct'] == 30.0, s)
ok('how far up it got', s['max_up_pct'] == 50.0, s)

# THE ADVERSE EXCURSION IS NOT OPTIONAL. A sheet that showed only "+30% since"
# is a machine for making every register look good: this name reached +30%
# AFTER going to −25%, and the −25% is the half that decides whether anyone
# could have held it.
ok('...and how far DOWN it went first', s['max_dn_pct'] == -25.0, s)
ok('the sessions before and after are both counted',
   (s['bars_before'], s['bars_after']) == (1, 2), s)

# Found today: nothing since yet. Distinct from a failure, and the page says so
# rather than dropping the line — an absent line reads as a sheet that broke.
s0 = srv._swing_stats(bars[:2], 200)
ok('a name found today reports no sessions since, not a broken stat',
   s0.get('bars_after') == 0 and 'since_pct' not in s0, s0)
ok('...and the page says which', 'no sessions since yet' in SRC)

# A found day that is not in the bars at all yields nothing rather than
# inventing a reference price to measure against.
ok('an absent found bar produces no statistics at all',
   srv._swing_stats(bars, 999) == {})


print()
print('== D. the legend cannot describe a chart nobody drew ==')
# The intraday legend claims premarket and post-market shading and a window in
# trading days either side. On a year of daily bars there IS no premarket to
# shade, and the shading means something else entirely.
sig = SRC.split('def _sheet_page(')[1].split('"""')[0]
ok('the renderer takes its window sentence from the caller', 'window_html' in sig)
ok('...and its shading legend too', 'shade_html' in sig)
ok('the swing sheet passes both', "window_html=(f'window: {lookback} trading days" in SRC)
ok('...and its legend names the mark, not the premarket',
   'the day the scanner found it' in SRC)

# And the bars themselves. A daily bar is stamped at MIDNIGHT ET, which the
# session classifier reads as post-market — so view='all' would return a year
# of candles shaded as after-hours from end to end, under a legend explaining
# that they are.
ok("daily bars are fetched as 'regular', not 'all'",
   "view='regular'" in SRC.split('def _build_swing_sheets(')[1].split('\ndef ')[0])
ok('...and the reason is written down where it would be undone',
   'session classifier reads as post-market' in SRC)


print()
print('== E. the page renders, and the marks do not erase each other ==')
sheet = [{'day': '2026-08-19', 'charts': [{
    'symbol': 'WULF', 'bars': bars, 'series': [],
    'card': {'score': 71, 'sector': 'Tech'},
    'found': {'time': 200, 'date': '2026-08-19', **s},
    'history_days': 1,
}]}]
page = srv._sheet_page(sheet, [], [], 'R1 SWING', '2026-08-19', '1d', 'polygon',
                       252, 0, 1, 420, day_prefix='found on ',
                       window_html='window: 252 trading days before → last bar',
                       shade_html='marked = found').body.decode()
ok('a sheet renders', '<html>' in page and 'WULF' in page)
ok('...carrying the found day into the payload', '"found"' in page)
ok('...and the caller\'s window sentence, not the intraday one', page.count(
    '04:00–20:00 ET, pre/post included') == 0, 'the intraday legend leaked in')

js = page.split('<script>')[-1].split('</script>')[0]
ok('the payload is valid JSON', isinstance(
    json.loads(js.split('const SHEETS = ')[1].split(';\nconst H')[0]), list))

# THE BUG THIS PART EXISTS FOR. setMarkers REPLACES rather than adds, so the
# found arrow and a trade's IN/OUT arrows each calling it means the second
# silently erases the first — on the page, with no error, which is the shape of
# a fault nobody finds.
ok('there is exactly ONE setMarkers call on the chart',
   len(re.findall(r'cs_\.setMarkers\(', js)) == 1,
   re.findall(r'cs_\.setMarkers\([^)]*', js))
ok('...fed by one list both the found day and a trade push to',
   'MARKS.push' in js and js.count('MARKS.push') >= 3, js.count('MARKS.push'))
ok('...sorted, which the library requires or it drops the whole list',
   'MARKS.sort' in js)

# The stripe and the tint: the request drawn rather than described.
ok('the found bar gets its own colour', "b.time === F" in js)
ok('...and every session since is tinted', "b.time  >  F" in js)

# A swing chart has no `sess`, so the intraday shading must fall through to
# transparent rather than colouring the year.
ok('bars with no session class stay unshaded', "'rgba(0,0,0,0)'" in js)


print()
print('== F. wired, and not silently sharing the intraday settings ==')
UI = (pathlib.Path(__file__).resolve().parents[1]
      / 'static' / 'index.html').read_text()
ok('the sheet can be opened from the print panel', "api/r1/swing?" in UI)
ok('...and exported', "api/r1/swing.csv?" in UI)
# tf / days_before / days_after are intraday settings that this endpoint
# ignores. Sending them anyway is a dead parameter someone later believes in.
ok('it builds its OWN query rather than borrowing the intraday one',
   'const swingQuery = ()' in UI)
ok('...pinning the timeframe rather than passing the picker', "tf: '1d'" in UI)

# EVERY ID THE HANDLERS LOOK UP MUST EXIST IN THE MARKUP. The panel is built
# from a template string and wired by getElementById straight after, so a typo
# between the two is a button that renders, clicks, and does nothing at all —
# no error, no console line, just a sheet that never opens.
for _id in ('prSwingGo', 'prSwingCsv', 'prSwingBack'):
    ok(f'#{_id} is both created and wired',
       f'id="{_id}"' in UI and f"getElementById('{_id}')" in UI)
ok('the CSV says which side of the found day each bar is on',
   "'phase'" in SRC and "'pct_from_found'" in SRC)

# HOW MUCH HISTORY ACTUALLY ARRIVED. Yahoo serves at most a year of daily bars
# per call whatever was asked for, so "a year before the found day" can come
# back starting ON it — and a truncated fetch looks exactly like a stock that
# listed the week it was scanned.
ok('a short history is reported rather than drawn as fact',
   'feed did not return it' in SRC)
ok('...naming the feed that does serve it', 'polygon serves the longer' in SRC)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
