"""Review pass — bugs found by re-auditing the whole tool. Each PART is a
FAILING case that was reproduced before the fix, so a regression re-breaks it.

PART A — the account block charged NO per-order commission minimum: the panel
         posts `fee_min`, the block read `fee_min_per_order`. A $1 minimum
         silently became $0 in the real-account P&L (the TTP block charged it,
         so the two blocks disagreed on the same run).
PART B — the CAPITAL cap was PER TRADE. A register backtest opens many symbols
         at the same time; each was allowed a full-balance position, so a
         $100k account could hold $500k of stock. The cap is now portfolio-
         wide: buying power is balance minus what is already open.
PART C — the report page CRASHED (TypeError formatting None) whenever no trade
         could be sized (e.g. a strategy with no stop) — the one case where
         the user most needs to be told why.
PART D — required_days let the per-timeframe CEILING shrink the window the
         caller asked for: adding ANY indicator to a 200-day 5m request cut
         the fetch to 120 days. The ceiling must bound the warm-up BUMP only.
PART E — two alert-watcher faults. (1) start() after stop() spawned a SECOND
         watcher thread while the first was still inside its sleep, doubling
         every scan and alert. (2) start() called status() from INSIDE the
         module lock — a plain Lock, not an RLock — so a second "start" click
         deadlocked holding it, hanging every later /api/alerts/* call for the
         life of the process. ("a start() while already running is a no-op"
         below is that deadlock: before the fix this test never returned.)
PART F — the print sheet's days_before/days_after were CALENDAR days, so on a
         Monday "1 day before" landed on Sunday (no session) instead of
         Friday — the previous session the docstring promised.
"""
import sys, pathlib, time
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

from chart import backtest as bt
from chart import server as srv
from chart import data_manager as dm
from chart import alerts as al

def trade(entry, exit_, stop, e_ts, x_ts, side='long'):
    return {'entry': entry, 'exit': exit_, 'stop': stop, 'side': side,
            'entry_ts': e_ts, 'exit_ts': x_ts, 'legs': []}

print("=" * 64)
print("PART A — the per-order commission MINIMUM reaches the account block")
print("=" * 64)
SPEC = {'account_equity': 100000, 'risk_pct': 0.5}
a_ui = bt._account_block([trade(10.0, 11.0, 9.0, 1, 2)], {**SPEC, 'fee_min': 1.0})
a_out = bt._account_block([trade(10.0, 11.0, 9.0, 1, 2)],
                          {**SPEC, 'fee_min_per_order': 1.0})
ok("the panel's `fee_min` is charged (2 orders x $1)", a_ui['fees_usd'] == 2.0,
   f"{a_ui['fees_usd']}")
ok("`fee_min_per_order` still works (same number)",
   a_out['fees_usd'] == a_ui['fees_usd'], f"{a_out['fees_usd']}")
ok("the minimum is echoed back so the report can print it",
   a_ui['fee_min_per_order'] == 1.0)
a_free = bt._account_block([trade(10.0, 11.0, 9.0, 1, 2)], SPEC)
ok("no fee configured → no fee charged", a_free['fees_usd'] == 0.0)

print("=" * 64)
print("PART B — the capital cap is PORTFOLIO-wide, not per trade")
print("=" * 64)
# 5 names entered at the SAME second, all still open — a $100k cash account
# can hold $100k of stock in TOTAL, not $100k each.
CONC = [trade(10.0, 10.5, 9.99, 100, 9999) for _ in range(5)]
r = bt._account_block(CONC, {'account_equity': 100000, 'risk_pct': 0.5})
notionals = [t['ctx']['acct_notional_usd'] for t in CONC if 'acct_notional_usd' in (t.get('ctx') or {})]
ok("total notional of the concurrent book <= the balance",
   sum(notionals) <= 100000 + 1e-6, f"sum={sum(notionals)} parts={notionals}")
ok("the first trade takes the whole balance (tight stop → capped)",
   notionals and abs(notionals[0] - 100000) < 1e-6, f"{notionals[:1]}")
ok("later trades with no buying power left are SKIPPED, not sized",
   r['skipped_no_capital'] == 4, f"{r['skipped_no_capital']}")
ok("the skip is written on the trade so the CSV shows it",
   CONC[-1]['ctx']['acct_note'].startswith('no buying power'),
   f"{CONC[-1].get('ctx')}")
ok("concurrency is reported", r['max_concurrent_positions'] == 1,
   f"{r['max_concurrent_positions']}")
# ...but a book that FITS is fully taken — the cap must not punish concurrency
# per se. 5 names, $1.00 stop → 500 sh x $10 = $5k each, $25k of $100k used.
FITS = [trade(10.0, 10.5, 9.0, 100, 9999) for _ in range(5)]
r_fit = bt._account_block(FITS, {'account_equity': 100000, 'risk_pct': 0.5})
ok("5 concurrent positions that FIT the balance are all taken",
   r_fit['trades_sized'] == 5 and r_fit['skipped_no_capital'] == 0
   and r_fit['size_capped_by_leverage'] == 0, f"{r_fit['trades_sized']}")
ok("they are reported as 5 held at once",
   r_fit['max_concurrent_positions'] == 5, f"{r_fit['max_concurrent_positions']}")
ok("their combined notional is the sum, not one position's",
   abs(sum(t['ctx']['acct_notional_usd'] for t in FITS) - 25000) < 1e-6,
   f"{[t['ctx']['acct_notional_usd'] for t in FITS]}")
# ...and sequential trades are UNAFFECTED: each closes before the next entry
SEQ = [trade(10.0, 10.5, 9.0, 100, 200), trade(10.0, 10.5, 9.0, 300, 400)]
r2 = bt._account_block(SEQ, {'account_equity': 100000, 'risk_pct': 0.5})
ok("sequential trades are not capped (the balance was free again)",
   r2['skipped_no_capital'] == 0 and r2['size_capped_by_leverage'] == 0
   and r2['trades_sized'] == 2, f"{r2['trades_sized']} {r2['skipped_no_capital']}")
ok("each sequential trade risked the full 0.5% ($500 / $1.00 stop = 500 sh)",
   SEQ[0]['ctx']['acct_shares'] == 500.0, f"{SEQ[0]['ctx']['acct_shares']}")
# margin: 2x leverage doubles the SHARED budget (still one pool, just bigger)
LEV = [trade(10.0, 10.5, 9.99, 100, 9999) for _ in range(5)]
r3 = bt._account_block(LEV, {'account_equity': 100000, 'risk_pct': 0.5,
                             'max_leverage': 2})
lev_notional = [t['ctx']['acct_notional_usd'] for t in LEV if 'acct_notional_usd' in (t.get('ctx') or {})]
ok("max_leverage 2 doubles the shared pool to $200k",
   abs(sum(lev_notional) - 200000) < 1e-6, f"{lev_notional}")
ok("...it is still ONE pool: the rest are skipped, not each given $200k",
   r3['skipped_no_capital'] == 4, f"{r3['skipped_no_capital']}")

print("=" * 64)
print("PART C — the report never crashes when nothing could be sized")
print("=" * 64)
none_sized = bt._account_block([trade(10.0, 11.0, None, 1, 2)], SPEC)
ok("a stopless run still returns a block (so the user is told)",
   none_sized is not None and none_sized['trades_sized'] == 0)
try:
    html = srv._account_html({'account': none_sized})
    crashed = False
except Exception as e:                                   # noqa: BLE001
    crashed = True; html = str(e)
ok("the account HTML renders instead of raising", not crashed, html[:80])
ok("it says NO trade could be sized", 'NO trade could be sized' in html)
ok("empty metrics print as a dash, not as 'None'",
   '—' in html and 'None' not in html, html[:200])
good = srv._account_html({'account': bt._account_block(SEQ[:1], SPEC)})
ok("a normal run still prints its numbers", '$100' in good and 'None' not in good)

print("=" * 64)
print("PART D — the timeframe ceiling bounds the WARM-UP, never the request")
print("=" * 64)
OV = [{'key': 'ma.sma', 'params': {'length': 9}}]
ok("a 200-day 5m request keeps 200 days once an indicator is added",
   dm.required_days(OV, '5m', 200) == 200, f"{dm.required_days(OV, '5m', 200)}")
ok("with no indicator it was always honoured (unchanged)",
   dm.required_days([], '5m', 200) == 200)
ok("a 365-day 1m request is not cut to 60",
   dm.required_days(OV, '1m', 365) == 365, f"{dm.required_days(OV, '1m', 365)}")
BIG = [{'key': 'ma.ema', 'params': {'length': 20000}}]     # ~74d of 1m bars
ok("the ceiling still caps a runaway warm-up bump (74d → 60d on 1m)",
   dm.required_days(BIG, '1m', 5) == 60, f"{dm.required_days(BIG, '1m', 5)}")
ok("...but even a capped bump never shrinks a bigger request",
   dm.required_days(BIG, '1m', 90) == 90, f"{dm.required_days(BIG, '1m', 90)}")
ok("a normal warm-up bump still happens",
   dm.required_days([{'key': 'vwap.nday_block', 'params': {'n_days': 2}}], '1m', 3) >= 40)

print("=" * 64)
print("PART E — restarting the alert watcher never leaves two threads running")
print("=" * 64)
# count cycles instead of trusting timing: a retired thread must never run
# another scan, no matter where it was when stop() landed.
_CYCLES = {'n': 0}
def _fake_cycle(*a, **k):
    _CYCLES['n'] += 1
    return []
al._cycle = _fake_cycle
al._STATE['interval'] = 15        # clamped minimum: a real sleep, not a spin

al.start()
t1 = al._THREAD
for _ in range(100):              # let generation 1 do its first cycle
    if _CYCLES['n'] >= 1:
        break
    time.sleep(0.01)
ok("the watcher runs a cycle when started", _CYCLES['n'] == 1, f"{_CYCLES['n']}")
al.stop()
al.start()                        # restart at once, while t1 may still be in its wait
t2 = al._THREAD
ok("start() after stop() creates a NEW thread", t2 is not None and t2 is not t1)
for _ in range(200):              # the retired one must exit on its own
    if not t1.is_alive():
        break
    time.sleep(0.01)
ok("the RETIRED thread exits instead of sleeping out its interval",
   not t1.is_alive())
ok("only one watcher thread is alive", t2.is_alive() and not t1.is_alive())
before = _CYCLES['n']
time.sleep(0.3)
ok("exactly ONE cycle ran per generation — no doubled scans",
   _CYCLES['n'] == before == 2, f"{_CYCLES['n']} (want 2)")
ok("a start() while already running is a no-op, not a third thread",
   al.start() and al._THREAD is t2)
al.stop()
for _ in range(200):
    if not t2.is_alive():
        break
    time.sleep(0.01)
ok("stop() ends the live thread promptly", not t2.is_alive())
ok("no cycle ran after the final stop", _CYCLES['n'] == 2, f"{_CYCLES['n']}")

print("=" * 64)
print("PART F — print-sheet day offsets are TRADING days, not calendar days")
print("=" * 64)
import pandas as pd
mon = '2026-07-27'                     # a Monday
ws, we = srv._print_window(mon, 1, 0)
ok("Monday, 1 day before → FRIDAY 04:00 (the previous session)",
   ws.strftime('%a %Y-%m-%d %H:%M') == 'Fri 2026-07-24 04:00', f"{ws}")
ok("...through the register day's post-market close",
   we.strftime('%a %Y-%m-%d %H:%M') == 'Mon 2026-07-27 20:00', f"{we}")
ws2, we2 = srv._print_window('2026-07-14', 1, 1)      # Tue → Mon..Wed
ok("Tuesday ±1 → Monday 04:00 through Wednesday 20:00",
   ws2.strftime('%Y-%m-%d') == '2026-07-13' and we2.strftime('%Y-%m-%d') == '2026-07-15',
   f"{ws2} {we2}")
ws3, we3 = srv._print_window('2026-07-14', 0, 0)
ok("0 before / 0 after is the register day alone (04:00-20:00)",
   ws3.strftime('%Y-%m-%d %H:%M') == '2026-07-14 04:00'
   and we3.strftime('%Y-%m-%d %H:%M') == '2026-07-14 20:00', f"{ws3} {we3}")
ws4, we4 = srv._print_window('2026-07-24', 0, 1)      # Friday +1 → Monday
ok("Friday, 1 day after → the NEXT session (Monday), not Saturday",
   we4.strftime('%a %Y-%m-%d') == 'Mon 2026-07-27', f"{we4}")
ok("the fetch span covers the whole calendar window, weekend included",
   srv._print_span(ws4, we4) >= 4, f"{srv._print_span(ws4, we4)}")
ok("a same-day window still fetches at least one day",
   srv._print_span(ws3, we3) >= 1, f"{srv._print_span(ws3, we3)}")

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
