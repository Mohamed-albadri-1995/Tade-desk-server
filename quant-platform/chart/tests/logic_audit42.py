"""Audit part 42 — the ranking is taken at the DECISION price, never the fill.

THE BUG THIS EXISTS TO PREVENT.

The user ran the 09:35 setup live for two weeks and then backtested the same
fortnight with the same rank settings. Both sides were configured identically:
`vwap_extension`, top 3 per day. They picked DIFFERENT STOCKS.

`vwap_extension` is the distance from price to the stop. It was measured from
`entry` — and `entry` is whatever the fill model produced. Under fill
'next_open' that is the following bar's open, a price that had not printed when
the choice was made. So the backtest sorted its candidates on information the
live desk could not have.

Measured on the user's own data, 2026-08-19, WULF short with a 15.74 stop:

    decision close 15.37  ->  extension 2.41%     what the desk ranked on
    next-bar open  15.45  ->  extension 1.88%     what the backtest ranked on

Twenty-eight percent apart on the number that chooses three trades out of
thirty. Not a P&L difference — a different book.

The fix is one idea in two places: the simulation records `signal_px`, the
close of the bar the strategy looked at, and the ranker reads THAT.

PART A — decision_px prefers signal_px over the fill, at both nesting levels.
PART B — old rows without it still rank, on `entry`, rather than crashing.
PART C — vwap_extension and tight_stop both go through it.
PART D — THE PROOF: the same candidates rank identically under every fill
         model. This is the property the bug violated.
PART E — the WULF case, with the user's real numbers.
PART F — the sim carries signal_px out of itself, on every path.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart.backtest import RANK_METRICS, decision_px, select_by_rank  # noqa: E402

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


print('== A. decision_px prefers the signal price over the fill ==')
ok('top-level signal_px wins over entry',
   decision_px({'entry': 15.45, 'signal_px': 15.37}) == 15.37)
# The backtester tucks diagnostics into ctx to avoid a schema change, so the
# key legitimately lives one level down on stored rows.
ok('ctx.signal_px is found too',
   decision_px({'entry': 15.45, 'ctx': {'signal_px': 15.37}}) == 15.37)
ok('top level is preferred when both are present',
   decision_px({'entry': 15.45, 'signal_px': 15.37,
                'ctx': {'signal_px': 99.0}}) == 15.37)


print()
print('== B. rows written before signal_px existed still rank ==')
# A stored backtest from last month has no signal_px anywhere. Raising on it
# would make every historical result unreadable; falling back to `entry`
# reproduces exactly the old behaviour for exactly the old rows.
ok('missing everywhere -> entry', decision_px({'entry': 15.45}) == 15.45)
ok('present but null -> entry',
   decision_px({'entry': 15.45, 'signal_px': None}) == 15.45)
ok('null in ctx -> entry',
   decision_px({'entry': 15.45, 'ctx': {'signal_px': None}}) == 15.45)
ok('ctx absent entirely -> entry', decision_px({'entry': 15.45, 'ctx': None}) == 15.45)
ok('nothing at all -> None, not a crash', decision_px({}) is None)


print()
print('== C. both distance-to-stop metrics go through it ==')
# They are the same measurement read in opposite directions. Fixing one and
# not the other would leave the bug alive for every tight-stop strategy.
row = {'side': 'short', 'entry': 15.45, 'signal_px': 15.37, 'stop': 15.74}
for name in ('vwap_extension', 'tight_stop'):
    fn, _dir = RANK_METRICS[name]
    ok(f'{name} scores from the decision price',
       abs(fn(row) - 2.4073) < 0.001, fn(row))
ok('vwap_extension sorts descending by default',
   RANK_METRICS['vwap_extension'][1] == 'desc')
ok('tight_stop sorts ascending by default',
   RANK_METRICS['tight_stop'][1] == 'asc')


print()
print('== D. THE PROPERTY: ranking is fill-model INDEPENDENT ==')
# This is the whole fix stated as a test. Three shorts firing in the same
# minute, each with its own stop. `entry` is what the fill model produced and
# differs between the two runs; `signal_px` is the bar close the strategy
# looked at and does not. The selection must not move.
#
# Note the entries are chosen so that ranking on THEM reverses the order —
# otherwise the test would pass with the bug still in place.
def cand(sym, sig, fill, stop):
    return {'date': '2026-08-19', 'symbol': sym, 'side': 'short',
            'entry_ts': 1000, 'entry': fill, 'signal_px': sig, 'stop': stop,
            'ctx': {}}


#                       signal  close-fill  next_open-fill   stop
close_run = [cand('AAA', 15.37, 15.37, 15.74),
             cand('BBB', 20.00, 20.00, 20.30),
             cand('CCC', 30.00, 30.00, 30.20)]
open_run = [cand('AAA', 15.37, 15.45, 15.74),
            cand('BBB', 20.00, 19.80, 20.30),
            cand('CCC', 30.00, 29.50, 30.20)]

k1, s1 = select_by_rank(close_run, 'vwap_extension', None, 2)
k2, s2 = select_by_rank(open_run, 'vwap_extension', None, 2)
picked1 = [t['symbol'] for t in k1]
picked2 = [t['symbol'] for t in k2]
ok('the close-fill run picks the two most extended', picked1 == ['AAA', 'BBB'], picked1)
ok('the next_open-fill run picks THE SAME TWO', picked2 == picked1, picked2)
ok('and scores them identically to six places',
   [t['ctx']['rank_metric'] for t in k1] == [t['ctx']['rank_metric'] for t in k2],
   [t['ctx']['rank_metric'] for t in k2])
ok('the third is dropped by rank, not lost',
   s1['dropped_by_rank'] == 1 and s2['dropped_by_rank'] == 1, (s1, s2))

# Proof the fixture actually discriminates: rank the SAME rows on the fill and
# the answer changes. Without this, part D could pass on a fixture where the
# two orderings happened to agree, which would prove nothing.
def on_fill(rows):
    return sorted(rows, key=lambda t: -((t['stop'] / t['entry'] - 1.0) * 100.0))[:2]


ok('ranking on the FILL would have chosen differently',
   [t['symbol'] for t in on_fill(open_run)] != picked2,
   [t['symbol'] for t in on_fill(open_run)])


print()
print('== E. the WULF case, with the real numbers ==')
# 2026-08-19. Short, stop 15.74. The desk decided on the 09:35 close of 15.37.
# The backtest filled at the 09:36 open of 15.45 and measured from there.
fn, _ = RANK_METRICS['vwap_extension']
desk = fn({'side': 'short', 'entry': 15.37, 'signal_px': 15.37, 'stop': 15.74})
bt_old = fn({'side': 'short', 'entry': 15.45, 'stop': 15.74})      # no signal_px
bt_new = fn({'side': 'short', 'entry': 15.45, 'signal_px': 15.37, 'stop': 15.74})
ok('the desk saw 2.41% extension', abs(desk - 2.4073) < 0.001, desk)
ok('the old backtest saw 1.88%', abs(bt_old - 1.8770) < 0.001, bt_old)
ok('they were 28% apart', abs(desk / bt_old - 1.0) > 0.25, desk / bt_old)
ok('the fixed backtest agrees with the desk', abs(bt_new - desk) < 1e-9, bt_new)


print()
print('== F. the sim projects signal_px OUT of itself ==')
# The prices live in the simulation loop's locals. `run_strategy` builds fresh
# dicts for its return value, and a key omitted THERE does not exist
# downstream — the ranker then falls back to the fill and the bug is alive
# again with the fix apparently in place. Both projections, plus open_trade.
SRC = (pathlib.Path(__file__).resolve().parents[1] / 'strategy.py').read_text()
ok("'signal_px' is captured at entry as the signal bar's close",
   'sig_cur = close[j]' in SRC)
ok('the closed-trade appenders carry it',
   SRC.count("'signal_px': float(sig_cur)") == 2,
   SRC.count("'signal_px': float(sig_cur)"))
ok('the open trade carries it',
   "'signal_px': (float(sig_cur) if sig_cur is not None else None)" in SRC)
ok('the trades PROJECTION carries it out',
   "'signal_px': t.get('signal_px')" in SRC)
ok('the open_trade PROJECTION carries it out',
   "'signal_px': open_trade.get('signal_px')" in SRC)
ok('and `decided` rides out with it on both',
   "'decided': t.get('decided')" in SRC
   and "'decided': open_trade.get('decided')" in SRC)


print()
print(f'        {PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
