"""The professional report: every statistic checked against hand arithmetic.

A tearsheet is read as authority. If profit factor is computed on the wrong
set, or flat sessions are dropped from the daily series so Sharpe doubles, the
error is invisible — the number still looks like a number. So each metric here
is asserted against a value worked out by hand from a five-trade fixture small
enough to verify by reading it.

PART A — the fixture's statistics, hand-computed.
PART B — the daily series counts EVERY session in the range, not only the days
         that traded (dropping flat days inflates every ratio).
PART C — the journal carries every field, and reconstructs the stop price on
         runs recorded before the stop was stored.
PART D — the report page renders, exports link, and states its own basis.
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

PASS = 0; FAIL = 0
def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond: PASS += 1; print(f"  ok   {name}")
    else: FAIL += 1; print(f"  FAIL {name} {extra}")

import pandas as pd
from chart import report as rpt

ET = 'America/New_York'


def ts(day, hhmm):
    return int(pd.Timestamp(f'{day} {hhmm}', tz=ET).timestamp())


# FIVE trades, hand-built. Net dollars: +200, -100, +400, -100, +100 = +500.
#   winners  +200, +400, +100  → gross profit 700, avg win  233.333…
#   losers   -100, -100        → gross loss   200, avg loss -100
#   profit factor 700/200 = 3.5 · payoff 233.33/100 = 2.33
#   expectancy 500/5 = 100 · win rate 3/5 = 60%
#   longest win streak 1 (they alternate W L W L W) · longest loss streak 1
TR = [
    # (day, hhmm_in, hhmm_out, sym, side, entry, exit, net, fee, R, shares, stop)
    ('2026-08-03', '10:00', '10:30', 'AAA', 'long',  50.0, 52.0,  200.0, 5.0,  2.0, 100, 49.0),
    ('2026-08-03', '11:00', '11:20', 'BBB', 'short', 30.0, 30.5, -100.0, 3.0, -1.0, 200, 30.5),
    ('2026-08-04', '10:00', '12:00', 'CCC', 'long',  20.0, 22.0,  400.0, 4.0,  4.0, 200, 19.5),
    ('2026-08-05', '10:00', '10:05', 'DDD', 'long',  10.0,  9.5, -100.0, 2.0, -1.0, 200,  9.5),
    ('2026-08-05', '14:00', '15:00', 'EEE', 'long',  40.0, 40.5,  100.0, 2.0,  0.5, 200, 39.0),
]
trades = []
for d, i, o, sym, side, e, x, net, fee, r, sh, stop in TR:
    trades.append({
        'date': d, 'symbol': sym, 'side': side,
        'entry_ts': ts(d, i), 'exit_ts': ts(d, o),
        'entry': e, 'exit': x, 'ret': (x / e - 1.0) * (1 if side == 'long' else -1),
        'reason': 'TP' if net > 0 else 'SL',
        'ctx': {'acct_shares': sh, 'acct_pnl_usd': net, 'acct_fees_usd': fee,
                'acct_r_multiple': r, 'acct_stop': stop,
                'acct_risk_usd': round(sh * abs(e - stop), 2),
                'acct_equity_before': 100000.0,
                'acct_notional_usd': round(sh * e, 2),
                'acct_open_notional_usd': round(sh * e, 2)},
    })

# the run covers SIX sessions; only three of them traded
SESSIONS = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
            '2026-08-07', '2026-08-10']
SUMMARY = {'dates': SESSIONS, 'open_trades': 0,
           'account': {'account_equity_start': 100000.0, 'risk_pct': 0.5,
                       'max_leverage': 1, 'equity_end': 100500.0,
                       'net_pnl_usd': 500.0, 'return_pct': 0.5,
                       'fees_usd': 16.0, 'trades_sized': 5,
                       'max_concurrent_positions': 1,
                       'fee_per_share': 0.005, 'fee_min_per_order': 0.75}}

print("=" * 64)
print("PART A — the statistics, against hand arithmetic")
print("=" * 64)
st = rpt.compute(trades, SUMMARY, {'cost_bps': 0})
ok('the basis is dollars when the run was sized', st['basis'] == 'usd')
ok('trade count', st['n_trades'] == 5, str(st['n_trades']))
ok('wins / losses split 3 / 2', (st['wins'], st['losses']) == (3, 2))
ok('win rate 60%', st['win_rate_pct'] == 60.0, str(st['win_rate_pct']))
ok('gross profit 700', st['gross_profit'] == 700.0, str(st['gross_profit']))
ok('gross loss -200', st['gross_loss'] == -200.0, str(st['gross_loss']))
ok('net 500', st['net_profit'] == 500.0, str(st['net_profit']))
ok('profit factor 700/200 = 3.5', st['profit_factor'] == 3.5, str(st['profit_factor']))
ok('expectancy 500/5 = 100', st['expectancy'] == 100.0, str(st['expectancy']))
ok('avg win 233.33', st['avg_win'] == 233.33, str(st['avg_win']))
ok('avg loss -100', st['avg_loss'] == -100.0, str(st['avg_loss']))
ok('payoff 233.33/100 = 2.33', st['payoff_ratio'] == 2.33, str(st['payoff_ratio']))
ok('largest win 400 / largest loss -100',
   (st['largest_win'], st['largest_loss']) == (400.0, -100.0))
ok('longest win streak is 1 (they alternate)', st['max_consec_wins'] == 1,
   str(st['max_consec_wins']))
ok('longest loss streak is 1', st['max_consec_losses'] == 1)
# equity path, marked at EXIT: 100000 → 100200 → 100100 → 100500 → 100400 → 100500
# peak 100500 after trade 3; trough 100400 after trade 4 → drawdown 100
ok('max drawdown is $100 (the dip after the +400 peak)',
   st['max_dd_abs'] == 100.0, str(st['max_dd_abs']))
ok('...which is 0.1% of the peak', st['max_dd_pct'] == 0.1, str(st['max_dd_pct']))
ok('recovery factor 500/100 = 5', st['recovery_factor'] == 5.0, str(st['recovery_factor']))
# R: 2 - 1 + 4 - 1 + 0.5 = 4.5 over 5 trades = 0.9 avg
ok('total R 4.5', st['r']['total'] == 4.5, str(st['r']['total']))
ok('average R 0.9', st['r']['avg'] == 0.9, str(st['r']['avg']))
ok('the R histogram counts every trade',
   sum(b['n'] for b in st['r']['buckets']) == 5)
ok('the two -1R losers land in the "≤ -1R" bucket',
   [b for b in st['r']['buckets'] if b['label'] == '≤ -1R'][0]['n'] == 2)
# holds: 30, 20, 120, 5, 60 min → avg 47.0; winners 30,120,60 → 70; losers 20,5 → 12.5
ok('average hold 47 min', st['hold']['avg_min'] == 47.0, str(st['hold']['avg_min']))
ok('winners are held longer than losers (70 vs 12.5)',
   (st['hold']['avg_win_min'], st['hold']['avg_loss_min']) == (70.0, 12.5))

print()
print("=" * 64)
print("PART B — flat sessions are real sessions")
print("=" * 64)
ok('all six sessions are counted, not just the three that traded',
   (st['sessions'], st['days_traded']) == (6, 3), f"{st['sessions']}/{st['days_traded']}")
# daily: +100, +400, 0, 0, 0, 0  (03: +200-100; 04: +400; 05: -100+100 = 0)
by_day = st['by_day']
ok('08-03 nets +100', by_day['2026-08-03']['net'] == 100.0, str(by_day['2026-08-03']))
ok('08-05 nets 0 — two trades that cancel', by_day['2026-08-05']['net'] == 0.0)
ok('winning days 2, losing days 0', (st['winning_days'], st['losing_days']) == (2, 0))
ok('best day +400', st['best_day'] == 400.0)
# Sharpe on SIX daily returns (three of them zero, one of them zero-by-cancel).
# Dropping the flat days would raise the mean and cut the count — the classic
# inflation. Assert the direction rather than a magic number.
_only_traded = rpt.compute(trades, {**SUMMARY, 'dates': ['2026-08-03', '2026-08-04',
                                                         '2026-08-05']}, {})
ok('a shorter, flat-day-free window reports a HIGHER Sharpe (why flats matter)',
   _only_traded['sharpe'] > st['sharpe'], f"{_only_traded['sharpe']} vs {st['sharpe']}")
# Sortino divides by DOWNSIDE deviation only. This fixture has no losing
# SESSION (08-05's two trades cancel to zero), so the denominator is zero and
# the honest answer is "undefined" — not a huge number, and not Sharpe's value.
ok('with no losing session, Sortino is undefined rather than invented',
   st['sortino'] is None, str(st['sortino']))
_with_red = rpt.compute(
    trades + [{'date': '2026-08-06', 'symbol': 'FFF', 'side': 'long',
               'entry_ts': ts('2026-08-06', '10:00'), 'exit_ts': ts('2026-08-06', '10:10'),
               'entry': 10.0, 'exit': 9.0, 'ret': -0.10, 'reason': 'SL',
               'ctx': {'acct_shares': 100, 'acct_pnl_usd': -300.0,
                       'acct_fees_usd': 1.0, 'acct_r_multiple': -1.0,
                       'acct_stop': 9.0, 'acct_risk_usd': 100.0,
                       'acct_equity_before': 100500.0,
                       'acct_notional_usd': 1000.0}}],
    SUMMARY, {})
ok('add one losing session and Sortino becomes computable',
   _with_red['sortino'] is not None, str(_with_red['sortino']))
# NOT "Sortino is higher" — that is only true when the downside deviation is
# smaller than the total. Here one large down session makes it LARGER, so
# Sortino lands below Sharpe. What must hold is that it is a genuinely
# different measurement, computed off the losing days alone.
ok('...as a distinct number, not a copy of Sharpe',
   _with_red['sortino'] != _with_red['sharpe'],
   f"{_with_red['sortino']} vs {_with_red['sharpe']}")
_dsd = _with_red['sortino']
ok('one big down day drags Sortino BELOW Sharpe (downside vol dominates)',
   _dsd < _with_red['sharpe'], f"{_dsd} vs {_with_red['sharpe']}")
ok('exposure = 235 position-min / (6 sessions x 390) = 10.04%',
   st['exposure_pct'] == 10.04, str(st.get('exposure_pct')))
ok('a small sample is flagged, not left to be assumed',
   any('below 30' in w for w in st['warnings']))
ok('the missing slippage model is flagged',
   any('slippage' in w for w in st['warnings']))

print()
print("=" * 64)
print("PART C — the journal")
print("=" * 64)
J = rpt.journal(trades, SUMMARY)
ok('one row per trade, in entry order', len(J) == 5 and J[0]['symbol'] == 'AAA')
j0 = J[0]
ok('entry and exit times are ET clock times',
   (j0['entry_time'], j0['exit_time']) == ('10:00', '10:30'),
   f"{j0['entry_time']}/{j0['exit_time']}")
ok('hold time in minutes', j0['hold_min'] == 30.0)
ok('the stop PRICE is carried', j0['stop_price'] == 49.0)
ok('per-share risk = entry - stop', j0['risk_per_share'] == 1.0)
ok('gross = net + fees (200 + 5)', j0['gross_usd'] == 205.0, str(j0['gross_usd']))
ok('equity after = equity before + net', j0['equity_after'] == 100200.0)
ok('the fee RULE travels with the journal',
   j0['_fee_rule'] == '$0.005/share, min $0.75/order', j0['_fee_rule'])
ok('every declared column exists on every row',
   all(k in r for k, _ in rpt.JOURNAL_COLUMNS for r in J))
# a run recorded BEFORE acct_stop existed must still show the stop
old = [{**trades[0], 'ctx': {k: v for k, v in trades[0]['ctx'].items()
                             if k != 'acct_stop'}}]
ok('a pre-stop-field run reconstructs the stop from shares and risk $',
   rpt.journal(old, SUMMARY)[0]['stop_price'] == 49.0,
   str(rpt.journal(old, SUMMARY)[0]['stop_price']))

print()
print("=" * 64)
print("PART D — the report page")
print("=" * 64)
import chart.server as srv
from chart import store

_saved = store.get_backtest
store.get_backtest = lambda bid, with_trades=True: {
    'id': 1, 'name': 'T', 'status': 'done', 'spec': {'start': '2026-08-03',
    'end': '2026-08-10', 'tf': '1m', 'feed': 'polygon', 'fill': 'next_open',
    'universe': {'kind': 'register', 'register': 'R1'}},
    'summary': SUMMARY, 'trades': trades}
try:
    page = srv.backtest_report(1).body.decode()
    ok('the report renders', len(page) > 3000)
    ok('the headline is the account P&L in dollars', '+$500.00' in page, page[:0])
    ok('profit factor is on the page', '3.5' in page)
    ok('the journal table is on the page', 'Trade journal' in page and 'AAA' in page)
    ok('every trade appears in the journal',
       all(sym in page for sym in ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']))
    ok('exports are linked', '/journal.csv' in page and '/stats.json' in page)
    ok('the sample-size warning is shown to the reader',
       'error bar wider than the numbers' in page)
    ok('definitions are given, not assumed',
       'gross profit ÷ gross loss' in page and 'downside volatility' in page)
    csv_txt = srv.backtest_journal_csv(1).body.decode()
    ok('the journal CSV has a header row and one row per trade',
       csv_txt.strip().count('\n') == 5, str(csv_txt.strip().count('\n')))
    ok('...with the human labels as headers', csv_txt.startswith('#,date,symbol,side,entry,'))
    sj = srv.backtest_stats(1)
    ok('stats JSON carries both the stats and the journal',
       sj['ok'] and sj['stats']['profit_factor'] == 3.5 and len(sj['journal']) == 5)
finally:
    store.get_backtest = _saved

print()
print("=" * 64)
print("PART E — the two counts that read as the wrong set")
print("=" * 64)
# (1) WHICH trade the prop-firm minimum cost, by name. "1 win below $0.10/share
# wasted" left the reader to find it; on a $1.93 stock a healthy +2.70% is five
# cents a share, which is exactly the case that bit run #231 (KPTI).
TTP_SUM = {**SUMMARY, 'ttp': {'shares': 100, 'min_profit_ps': 0.10,
                              'net_pnl_usd': 442.59, 'counted_pnl_usd': 439.63,
                              'fees_usd': 26.25}}
cheap = {'date': '2026-08-03', 'symbol': 'KPTI', 'side': 'long',
         'entry_ts': ts('2026-08-03', '09:35'), 'exit_ts': ts('2026-08-03', '10:00'),
         'entry': 1.93, 'exit': 1.982, 'ret': 0.027, 'reason': 'exit', 'ctx': {}}
pf = rpt.prop_firm_detail(trades + [cheap], TTP_SUM)
ok('the wasted win is named, not just counted',
   [w['symbol'] for w in pf['wasted']] == ['KPTI'], str(pf['wasted']))
ok('...with the per-share number that decided it (~$0.052)',
   abs(pf['wasted'][0]['per_share'] - 0.052) < 0.001, str(pf['wasted'][0]))
ok('the uncredited amount is stated', pf['wasted_credit_lost'] == 2.96,
   str(pf['wasted_credit_lost']))
ok('a $50 stock making the same PERCENT is not wasted (the rule is per share)',
   not any(w['symbol'] == 'AAA' for w in pf['wasted']))
ok('what the simulation does NOT model is stated, including hold time',
   any('holding time' in x for x in pf['not_modelled']))

# (2) drop counts. A one-minute window refuses the entry condition on almost
# every bar; printing that beside the actionable drops made a working time gate
# look like 1.36 million lost trades.
import chart.server as srv
_saved2 = store.get_backtest
store.get_backtest = lambda bid, with_trades=True: {
    'id': 2, 'name': 'T', 'status': 'done',
    'spec': {'start': '2026-08-03', 'end': '2026-08-10', 'tf': '1m',
             'feed': 'polygon', 'fill': 'next_open',
             'universe': {'kind': 'register', 'register': 'R1'}},
    'summary': {**SUMMARY, 'coverage': {'entry_drops': {
        'outside_window': 1361916, 'rth_session': 46720, 'eod_bar': 4254,
        'last_bar': 5, 'daily_cap': 3, 'cooldown': 1}}},
    'trades': trades}
try:
    pg = srv.backtest_report(2).body.decode()
    ok('clock refusals are separated from the drops that cost a trade',
       'signals INSIDE the window that still did not trade' in pg
       and 'daily_cap=3' in pg)
    ok('...and the million-scale number is explained as normal, not a loss',
       'the time window doing its job' in pg
       and 'a number in the millions is normal' in pg)
    ok('the two are not printed in one undifferentiated list',
       'outside_window=1361916,' not in pg)
finally:
    store.get_backtest = _saved2

print()
print("=" * 64)
print("PART F — the prop-firm minimum at the ACCOUNT's size, not a flat 100")
print("=" * 64)
# Run #231's KPTI: a long at $1.93 that made +2.70%. That is $0.052 a share, so
# it fails the $0.10 minimum at ANY size — the rule is per share. At the flat
# 100 shares the TTP block uses, the credit lost reads $2.96. The account
# actually held 9,162 shares of it. Reporting only the 100-share number
# understates what the rule costs by the size ratio.
import chart.backtest as bt
KPTI = {'date': '2026-08-03', 'symbol': 'KPTI', 'side': 'long',
        'entry_ts': ts('2026-08-03', '09:35'), 'exit_ts': ts('2026-08-03', '10:00'),
        'entry': 1.93, 'exit': 1.982, 'ret': 0.02694, 'stop': 1.8875,
        'reason': 'exit', 'ctx': {}}
FAT = {'date': '2026-08-04', 'symbol': 'ADEA', 'side': 'long',
       'entry_ts': ts('2026-08-04', '09:35'), 'exit_ts': ts('2026-08-04', '15:50'),
       'entry': 25.82, 'exit': 29.36, 'ret': 0.13710, 'stop': 25.0,
       'reason': 'eod', 'ctx': {}}
SPEC = {'account_equity': 100000, 'risk_pct': 0.5, 'max_leverage': 1,
        'fee_per_share': 0.005, 'fee_min': 0.75, 'min_profit_ps': 0.10}
a = bt._account_block([KPTI, FAT], SPEC)
ok('the min-profit rule is applied to the sized account',
   a.get('min_profit_ps') == 0.10, str(a.get('min_profit_ps')))
ok('the cheap-stock win is flagged as earning no credit',
   a['no_credit_wins'] == 1, str(a['no_credit_wins']))
ok('...and it is the $1.93 one, by per-share P&L under $0.10',
   0 < (KPTI['ctx'].get('acct_pnl_per_share') or 0) < 0.10,
   str(KPTI['ctx'].get('acct_pnl_per_share')))
ok('the $25.82 win keeps full credit', not FAT['ctx'].get('acct_no_credit'))
ok('counted + no-credit = net P&L (nothing is lost or double counted)',
   abs((a['counted_pnl_usd'] + a['no_credit_pnl_usd']) - a['net_pnl_usd']) < 0.02,
   f"{a['counted_pnl_usd']} + {a['no_credit_pnl_usd']} vs {a['net_pnl_usd']}")
# THE POINT: the withheld amount scales with size, the pass/fail does not.
ttp100 = bt._ttp_block([KPTI, FAT], [], {**SPEC, 'shares': 100})
lost100 = round(ttp100['net_pnl_usd'] - ttp100['counted_pnl_usd'], 2)
ok('at a flat 100 shares the same rule withholds only a few dollars',
   lost100 < 10, str(lost100))
ok('at the ACCOUNT size it withholds far more — the number that matters',
   abs(a['no_credit_pnl_usd']) > 10 * abs(lost100),
   f"account {a['no_credit_pnl_usd']} vs flat-100 {lost100}")
ok('net P&L itself is NOT reduced by the rule (the money is still yours)',
   abs(a['net_pnl_usd'] - (KPTI['ctx']['acct_pnl_usd'] + FAT['ctx']['acct_pnl_usd'])) < 0.02)
# with no rule set, the fields are absent rather than zero
a2 = bt._account_block([KPTI, FAT], {k: v for k, v in SPEC.items()
                                     if k != 'min_profit_ps'})
ok('with no min-profit rule the fields are None, not a misleading 0',
   a2['min_profit_ps'] is None and a2['counted_pnl_usd'] is None)

print()
print("=" * 64)
print(f"RESULT  PASS={PASS}  FAIL={FAIL}")
print("=" * 64)
sys.exit(1 if FAIL else 0)
