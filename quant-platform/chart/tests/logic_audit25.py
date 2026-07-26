"""Real-account risk sizing — hand-computed, no assumptions.

$100,000 account, 0.5% risk per trade. Size comes from the STOP:
  shares = (equity x risk%) / (entry - stop)
so every stop-out loses exactly risk% of the equity that existed at entry,
and equity COMPOUNDS in trade order.

PART A — a stop-out loses exactly 0.5%; a 2R winner makes exactly 1.0%.
PART B — compounding: the 2nd trade is sized on the equity AFTER the 1st.
PART C — no stop → excluded (never silently sized).
PART D — capital cap: a position can never exceed the cash balance.
PART E — scale-out legs are sized off the same share count.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import chart.backtest as bt

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

def T(entry, exit_, stop, side='long', ets=1, xts=2, legs=None):
    return {'date': '2026-07-01', 'symbol': 'X', 'side': side,
            'entry_ts': ets, 'exit_ts': xts, 'entry': entry, 'exit': exit_,
            'stop': stop, 'ret': 0.0, 'reason': 'SL', 'legs': legs or []}

SPEC = {'account_equity': 100000, 'risk_pct': 0.5}

print("=" * 64)
print("PART A — one stop-out loses exactly 0.5%; a 2R win makes 1.0%")
print("=" * 64)
# entry 10.00, stop 9.90 → risk $0.10/share → 500/0.10 = 5000 shares
a = bt._account_block([T(10.00, 9.90, 9.90)], SPEC)
ok("stop-out: -$500 exactly (0.5% of 100k)", abs(a['net_pnl_usd'] + 500) < 1e-6,
   f"got={a['net_pnl_usd']}")
ok("equity 100000 → 99500", abs(a['equity_end'] - 99500) < 1e-6, f"{a['equity_end']}")
ok("return -0.50%", abs(a['return_pct'] + 0.5) < 1e-9, f"{a['return_pct']}")
b = bt._account_block([T(10.00, 10.20, 9.90)], SPEC)     # +0.20 = 2R
ok("2R winner: +$1000 (=1.0%)", abs(b['net_pnl_usd'] - 1000) < 1e-6,
   f"got={b['net_pnl_usd']}")

print("=" * 64)
print("PART B — equity compounds in trade order")
print("=" * 64)
# trade 1 stops out (-500 → 99,500). trade 2 sized on 99,500:
# risk 497.50 / 0.10 = 4975 sh; +0.10 move = +$497.50
c = bt._account_block([T(10.00, 9.90, 9.90, ets=1, xts=2),
                       T(10.00, 10.10, 9.90, ets=3, xts=4)], SPEC)
ok("2nd trade sized on POST-loss equity (+$497.50, not +$500)",
   abs(c['net_pnl_usd'] - (-500 + 497.5)) < 1e-6, f"net={c['net_pnl_usd']}")
ok("ending equity 99,997.50", abs(c['equity_end'] - 99997.5) < 1e-6, f"{c['equity_end']}")
# a trade entered BEFORE the first closes must NOT see its P&L
d = bt._account_block([T(10.00, 9.90, 9.90, ets=1, xts=10),
                       T(10.00, 9.90, 9.90, ets=2, xts=11)], SPEC)
ok("concurrent trade sized on equity at ITS entry (both risk full 0.5%)",
   abs(d['net_pnl_usd'] + 1000) < 1e-6, f"net={d['net_pnl_usd']}")

print("=" * 64)
print("PART C — no stop → EXCLUDED, never silently sized")
print("=" * 64)
e = bt._account_block([T(10.00, 11.00, None)], SPEC)
ok("no-stop trade excluded, counted", e['trades_sized'] == 0
   and e['unsized_no_stop'] == 1 and e['net_pnl_usd'] == 0, f"{e}")
f = bt._account_block([T(10.00, 11.00, 10.00)], SPEC)     # stop AT entry = 0 risk
ok("stop at entry (zero risk) also excluded", f['unsized_no_stop'] == 1, f"{f}")

print("=" * 64)
print("PART D — CAPITAL cap: a position can never exceed the account")
print("=" * 64)
# entry 10, stop 9.999 → risk $0.001/sh → 500/0.001 = 500,000 sh = $5m notional
# on a $100k CASH account. Cap = 100k/10 = 10,000 shares ($100k of stock).
g = bt._account_block([T(10.00, 10.01, 9.999)], SPEC)
ok("shares capped at the cash balance (10,000 sh x $0.01 = $100)",
   abs(g['net_pnl_usd'] - 100) < 1e-6 and g['size_capped_by_leverage'] == 1,
   f"net={g['net_pnl_usd']} capped={g['size_capped_by_leverage']}")
# a NORMAL trade must be unaffected: 5,000 sh x $10 = $50k < $100k
ok("a normal-stop trade is NOT capped (notional under the balance)",
   bt._account_block([T(10.00, 9.90, 9.90)], SPEC)['size_capped_by_leverage'] == 0)
# explicit margin only if asked for
g4 = bt._account_block([T(10.00, 10.01, 9.999)], {**SPEC, 'max_leverage': 4})
ok("max_leverage=4 opts into margin (40,000 sh → $400)",
   abs(g4['net_pnl_usd'] - 400) < 1e-6, f"net={g4['net_pnl_usd']}")
# a $500 stock: 0.5% risk wants a huge notional → capped to 200 shares
big = bt._account_block([T(500.0, 501.0, 499.5)], SPEC)
ok("$500 stock: capped to 200 sh ($100k), P&L $200 not $1000",
   abs(big['net_pnl_usd'] - 200) < 1e-6, f"net={big['net_pnl_usd']}")

print("=" * 64)
print("PART E — scale-out legs use the same sized share count")
print("=" * 64)
# 5000 sh; half at +0.20 (=$500), runner at +0.10 (=$250) → $750
h = bt._account_block([T(10.00, 10.10, 9.90,
                         legs=[{'price': 10.20, 'fraction': 0.5,
                                'ret': 0.02, 'reason': 'T1'}])], SPEC)
ok("half at +0.20 + runner at +0.10 = $750", abs(h['net_pnl_usd'] - 750) < 1e-6,
   f"net={h['net_pnl_usd']}")

print("=" * 64)
print("PART F — commissions charged per ORDER on the sized shares")
print("=" * 64)
i = bt._account_block([T(10.00, 9.90, 9.90)],
                      {**SPEC, 'fee_per_share': 0.005, 'fee_min_per_order': 0.75})
# 5000 sh: entry order 5000*0.005 = $25, exit order $25 → $50 fees
ok("fees = $50 on a 5,000-share round trip", abs(i['fees_usd'] - 50) < 1e-6,
   f"fees={i['fees_usd']}")
ok("net = -$550 (risk + commissions)", abs(i['net_pnl_usd'] + 550) < 1e-6,
   f"net={i['net_pnl_usd']}")

print("=" * 64)
print("PART G — off by default (opt-in only)")
print("=" * 64)
ok("no account_equity → no account block", bt._account_block([T(10, 11, 9)], {}) is None)
ok("equity but no risk_pct → no block",
   bt._account_block([T(10, 11, 9)], {'account_equity': 100000}) is None)

print("\n" + "=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
