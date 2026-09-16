"""R and the dollars must be the same money.

Backtest #363, 2026-09-15, $100k account, $500 risk a trade, cost_bps 33:

    net_profit   $507.46
    r.total       3.12

On $500 of risk a trade, 3.12R reads as $1,560. Three times the money, in the
headline, beside the correct figure, on the same screen.

R was computed from `gross` — before fees and before slippage. While the cost
model did nothing to the dollars (logic_audit72) the two agreed by accident, so
nothing showed. The moment cost started being charged, the accidental agreement
ended and the run began reporting two different P&Ls at once.

A NUMBER THAT IS ARITHMETICALLY CORRECT ABOUT THE WRONG THING. gross/risk is a
perfectly good R. It is just not the R of the account underneath it, which is
the only account the trader has.

R NOW READS FROM NET, and the gross R is kept beside it rather than thrown
away: net R answers "what did this account make", gross R answers "was the rule
any good". A strategy that loses to the fill and a strategy that is wrong look
identical if only one of the two survives.

THE DENOMINATOR STAYS GROSS. The stop is a price; the dollars it protects are
the dollars actually committed. Netting the cost out of the risk as well would
charge it twice.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from chart.backtest import _account_block                           # noqa: E402
from chart.report import JOURNAL_COLUMNS, compute, journal          # noqa: E402

PASS = 0
FAIL = 0


def ok(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'  ok   {label}')
    else:
        FAIL += 1
        print(f'  FAIL {label} {detail}')


class Ctx(dict):
    """The trade's ctx, answering None for fields this change introduces.

    READ SOFTLY so the BEHAVIOUR is what fails on a file without them, not the
    lookup. A KeyError proves a name is absent; the point here is that R and
    the dollars must describe the same result.
    """

    def __missing__(self, key):
        return None


def trade(symbol, side, entry, exit_, stop, pps, legs=None):
    t = {'symbol': symbol, 'side': side, 'entry': entry, 'exit': exit_,
         'stop': stop, 'pnl_per_share': pps, 'date': '2026-09-15',
         'entry_ts': 1_757_000_000, 'exit_ts': 1_757_003_600}
    if legs:
        t['legs'] = legs
    return t


# The 09-15 morning, as the run recorded it.
FTAI = trade('FTAI', 'short', 175.30, 173.39, 176.60, 2.255,
             [{'fraction': 0.5, 'price': 172.70}])
BLSH = trade('BLSH', 'short', 36.02, 35.70, 36.275, 0.32)
LOSER = trade('MMED', 'short', 21.96, 22.15, 22.225, -0.19)


def run(bps, trades=None, **spec):
    base = {'account_equity': 100_000, 'risk_usd': 500, 'max_leverage': 1,
            'size_ratio': 0.9, 'cost_bps': bps}
    base.update(spec)
    rows = [dict(t) for t in (trades or [FTAI])]
    summary = _account_block(rows, base)
    return summary, rows, base


def ctx(rows, i=0):
    return Ctx(rows[i].get('ctx') or {})


def slack(risk):
    """What half a cent of R is worth in dollars, plus a hair.

    R is reported to two decimals because that is how a trader reads it, so
    `R x risk` can only ever reproduce the dollars to within half a tick of R.
    On $450 of risk that is $2.25. Asserting tighter would be asserting about
    the rounding, not about the basis.
    """
    return 0.005 * float(risk) + 0.02


print('\n── R times the risk IS the dollars ────────────────────────────────')

s, rows, _ = run(33)
c = ctx(rows)
r = c['acct_r_multiple']
# THE ASSERTION THE OLD FILE FAILED. It reported gross/risk here, so this
# product came out to the gross P&L while acct_pnl_usd was the net one.
ok('R reconstructs the net dollars of the trade',
   r is not None
   and abs(r * c['acct_risk_usd'] - c['acct_pnl_usd']) < slack(c['acct_risk_usd']),
   f"{r}R x ${c['acct_risk_usd']} vs net ${c['acct_pnl_usd']}")
ok('and it does NOT reconstruct the gross ones',
   r is not None
   and abs(r * c['acct_risk_usd']
           - (c['acct_pnl_usd'] + c['acct_slip_usd'] + c['acct_fees_usd'])) > 5.0,
   f'{r}R')

print('\n── the rule\'s own R is kept, not replaced ─────────────────────────')

g = c['acct_r_multiple_gross']
ok('the gross R is still reported', g is not None, str(g))
ok('and it is the one that reconstructs gross',
   g is not None
   and abs(g * c['acct_risk_usd']
           - (c['acct_pnl_usd'] + c['acct_slip_usd'] + c['acct_fees_usd']))
   < slack(c['acct_risk_usd']),
   f'{g}R')
ok('a cost makes net R smaller than gross R', r is not None and g is not None and r < g,
   f'{r} vs {g}')

print('\n── with nothing charged, the two are the same number ──────────────')

_, free_rows, _ = run(0)
fc = ctx(free_rows)
ok('a free run has net R equal to gross R',
   fc['acct_r_multiple'] == fc['acct_r_multiple_gross'],
   f"{fc['acct_r_multiple']} vs {fc['acct_r_multiple_gross']}")
# AND THAT IS WHY THIS WENT UNSEEN. Every run before cost_bps was charged was
# this run, so the wrong basis produced the right number for years.
ok('so the fault was invisible until the cost model started charging',
   fc['acct_r_multiple'] == fc['acct_r_multiple_gross']
   and c['acct_r_multiple'] != c['acct_r_multiple_gross'])

print('\n── a loss is negative, and still the same money ───────────────────')

_, lrows, _ = run(33, [LOSER])
lc = ctx(lrows)
ok('a losing trade reports a negative R', (lc['acct_r_multiple'] or 0) < 0,
   str(lc['acct_r_multiple']))
ok('and it too reconstructs the net dollars',
   abs(lc['acct_r_multiple'] * lc['acct_risk_usd'] - lc['acct_pnl_usd'])
   < slack(lc['acct_risk_usd']),
   f"{lc['acct_r_multiple']}R vs ${lc['acct_pnl_usd']}")
# THE COST MAKES A LOSS WORSE, NOT BETTER. Sign errors on the short side are
# how the slippage model was got wrong the first time.
ok('the cost makes the loss larger in R, not smaller',
   lc['acct_r_multiple_gross'] is not None
   and lc['acct_r_multiple'] < lc['acct_r_multiple_gross'],
   f"{lc['acct_r_multiple']} vs {lc['acct_r_multiple_gross']}")

print('\n── the run total is the run\'s own P&L ─────────────────────────────')

s3, rows3, spec3 = run(33, [FTAI, BLSH, LOSER])
st = compute(rows3, {'account': s3}, spec3)
rblock = st.get('r') or {}
# Only the trades the account could actually afford carry an R. With leverage
# capped at 1x the third name is skipped for capital, and a skipped trade has
# no risk, no dollars and no R — it must not be counted as a scratch.
sized = [Ctx(t.get('ctx') or {}) for t in rows3
         if (t.get('ctx') or {}).get('acct_risk_usd') is not None]
ok('the run sized more than one trade', len(sized) >= 2, str(len(sized)))
# THE HEADLINE PAIR THE TRADER READS: #363 printed 3.12R beside $507.46.
from_r = sum(cc['acct_r_multiple'] * cc['acct_risk_usd'] for cc in sized)
tol = sum(slack(cc['acct_risk_usd']) for cc in sized)
ok("each trade's R, times its own risk, adds up to the run's net profit",
   abs(from_r - (s3.get('net_pnl_usd') or 0)) < tol,
   f"${round(from_r, 2)} vs net ${s3.get('net_pnl_usd')}")
ok('and r.total is the sum of those same R values',
   abs((rblock.get('total') or 0)
       - sum(cc['acct_r_multiple'] for cc in sized)) < 0.001,
   str(rblock.get('total')))
ok('the block says which basis it is on', rblock.get('basis') == 'net',
   str(rblock.get('basis')))
ok('and carries the gross total beside it',
   rblock.get('total_gross') is not None
   and rblock['total_gross'] > rblock['total'],
   str(rblock.get('total_gross')))
ok('every sized trade is counted in it', rblock.get('n') == len(sized),
   f"{rblock.get('n')} vs {len(sized)}")

print('\n── the journal shows both, per trade ──────────────────────────────')

rowsj = journal(rows3, {'account': s3})
cols = [k for k, _ in JOURNAL_COLUMNS]
ok('the journal has an R column', 'r_multiple' in cols)
ok('and a gross R column beside it', 'r_multiple_gross' in cols, str(cols[:0] or ''))
ok('gross R sits next to R, not at the far end',
   'r_multiple_gross' in cols
   and abs(cols.index('r_multiple_gross') - cols.index('r_multiple')) == 1)
j0 = rowsj[0]
ok('the row carries the net R', j0.get('r_multiple') is not None)
ok('and the gross R', j0.get('r_multiple_gross') is not None)
ok('and the row is internally consistent',
   j0.get('r_multiple') is not None
   and abs(j0['r_multiple'] * (j0.get('risk_usd') or 1) - (j0.get('net_usd') or 0))
   < slack(j0.get('risk_usd') or 0),
   f"{j0.get('r_multiple')}R x {j0.get('risk_usd')} vs {j0.get('net_usd')}")

print('\n── nothing at risk is not zero R ──────────────────────────────────')

# AN ERROR IS NEVER A ZERO. A stop at the entry means the R is undefined, and
# saying 0.00R would put a trade that cannot be measured into the average as a
# scratch.
flatstop = trade('NOPE', 'short', 50.00, 49.00, 50.00, 1.00)
_, frows, _ = run(33, [flatstop])
fc2 = ctx(frows)
ok('a stop at the entry reports no R rather than 0',
   fc2['acct_r_multiple'] is None, str(fc2['acct_r_multiple']))
ok('and no gross R either', fc2['acct_r_multiple_gross'] is None)

print('\n── fees count too, not only slippage ──────────────────────────────')

# Both come off the same net. A commission-only account must see its R move.
_, fee_rows, _ = run(0, [FTAI], fee_per_share=0.01)
fr = ctx(fee_rows)
ok('a commission-only run still has R below gross R',
   fr['acct_fees_usd'] > 0 and fr['acct_r_multiple_gross'] is not None
   and fr['acct_r_multiple'] < fr['acct_r_multiple_gross'],
   f"fees ${fr['acct_fees_usd']}, {fr['acct_r_multiple']} vs "
   f"{fr['acct_r_multiple_gross']}")
ok('and it still reconstructs its own net dollars',
   abs(fr['acct_r_multiple'] * fr['acct_risk_usd'] - fr['acct_pnl_usd'])
   < slack(fr['acct_risk_usd']))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
