"""Live alert watcher — pure-logic checks (no threads, no feed).

PART A — scan_once: fires on entry_now, dedupes the same signal bar,
         suppresses repeats for 10 minutes, re-alerts after suppression,
         isolates a crashing eval.
PART B — in_window: strategy session windows gate the watch list
         (5-minute pre-window grace).
PART C — _symbols_today: R1 + Shortlist union, deduped, screener-down safe.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.alerts as al

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

S1 = {'name': 'SetupA', 'side': 'long', 'risk': {'window_start': 1000, 'window_end': 1330}}
S2 = {'name': 'SetupB', 'side': 'short', 'risk': {}}

print("=" * 64)
print("PART A — scan_once: fire, dedupe, suppress, re-arm, isolate")
print("=" * 64)
al._SEEN.clear(); al._STATE['alerts'] = []
SIG = {'ok': True, 'entry_now': True, 'last': '2026-07-20 10:00 ET'}
def ev(sig_map):
    return lambda s, sym: sig_map.get((s['name'], sym), {'ok': True, 'entry_now': False})

a1 = al.scan_once([S1, S2], ['AAA', 'BBB'], ev({('SetupA', 'AAA'): SIG}), now_epoch=1000)
ok("signal fires once, correct fields",
   len(a1) == 1 and a1[0]['symbol'] == 'AAA' and a1[0]['strategy'] == 'SetupA'
   and a1[0]['side'] == 'long' and a1[0]['bar'] == '2026-07-20 10:00 ET', f"{a1}")
a2 = al.scan_once([S1], ['AAA'], ev({('SetupA', 'AAA'): SIG}), now_epoch=1030)
ok("same signal bar again → deduped", a2 == [], f"{a2}")
SIG2 = {'ok': True, 'entry_now': True, 'last': '2026-07-20 10:01 ET'}
a3 = al.scan_once([S1], ['AAA'], ev({('SetupA', 'AAA'): SIG2}), now_epoch=1060)
ok("next bar still true within 10 min → suppressed", a3 == [], f"{a3}")
SIG3 = {'ok': True, 'entry_now': True, 'last': '2026-07-20 10:12 ET'}
a4 = al.scan_once([S1], ['AAA'], ev({('SetupA', 'AAA'): SIG3}), now_epoch=1000 + 601)
ok("after the suppression window → re-alerts", len(a4) == 1, f"{a4}")
def boom(s, sym):
    if sym == 'BAD':
        raise RuntimeError('feed died')
    return SIG3 if sym == 'CCC' else {'ok': True, 'entry_now': False}
al._SEEN.clear()
a5 = al.scan_once([S1], ['BAD', 'CCC'], boom, now_epoch=5000)
ok("a crashing symbol is isolated; the next one still alerts",
   len(a5) == 1 and a5[0]['symbol'] == 'CCC', f"{a5}")
ok("alerts ring in state; recent(since) slices by ts",
   len(al.recent(0)) >= 2 and al.recent(4999)[0]['symbol'] == 'CCC')

print("=" * 64)
print("PART B — in_window: session gating with pre-window grace")
print("=" * 64)
ok("inside window", al.in_window(S1, 1100))
ok("before window minus grace → out", not al.in_window(S1, 940))
ok("5-min grace before start → in", al.in_window(S1, 955))
ok("after window_end → out", not al.in_window(S1, 1331))
ok("no window → always in", al.in_window(S2, 933))

print("=" * 64)
print("PART C — _symbols_today: R1 + Shortlist union, failure-safe")
print("=" * 64)
def regs(reg):
    return {'R1': {'ok': True, 'rows': [{'ticker': 'aaa'}, {'ticker': 'BBB'}]},
            'Shortlist': {'ok': True, 'rows': [{'ticker': 'BBB'}, {'ticker': 'CCC'}]}}[reg]
ok("union, uppercased, deduped, order kept",
   al._symbols_today(regs) == ['AAA', 'BBB', 'CCC'], f"{al._symbols_today(regs)}")
def regs_down(reg):
    raise RuntimeError('screener down')
ok("screener down → empty list, no crash", al._symbols_today(regs_down) == [])

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
