"""The cost schedule must be the one the orders are actually going to.

Backtest #354 was run on the Trade The Pool preset — $0.005 a share, $0.75
minimum per order, and a min-profit-per-share rule of $0.10. Every order in it
went to an Alpaca paper account, which charges none of those things.

On the 2026-09-08 PL short that is $27.77 of commission charged against a trade
that cost nothing to place, and a prop-firm panel reporting a fixed 100-share
P&L and a "does this win count" rule belonging to a different firm.

So there is an Alpaca preset, and it is ZEROS rather than small numbers. US
equities are commission-free there; there is no per-order minimum; and the
min-profit rule is a prop firm's rule, not a broker's. With all three blank the
account block charges nothing AND `_ttp_block` returns None — so an Alpaca run
does not grow a panel describing rules it is not trading under.

WHAT IS DELIBERATELY NOT MODELLED. On a LIVE Alpaca account the SEC fee and
FINRA TAF are passed through on SELLS only (TAF $0.000166/share capped at
$8.30; SEC about $27.80 per $1M sold). This fee model is per-share and
symmetric, so entering them here would charge them on the buy side too — double,
and on the wrong side. On the paper account these orders go to, they are zero.

And slippage stays where it belongs. Cost bps is its own field; a commission
schedule that quietly absorbed execution cost would hide the one number this
desk is trying to measure.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from chart.backtest import _account_block, _ttp_block                # noqa: E402

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


def trades():
    """The real 2026-09-08 PL short out of backtest #354, legs included."""
    return [{'date': '2026-09-08', 'symbol': 'PL', 'side': 'short',
             'entry': 17.76, 'exit': 17.51, 'stop': 17.94, 'ret': 0.0171,
             'reason': 'exit', 'entry_ts': 1, 'exit_ts': 2,
             'legs': [{'fraction': 0.5, 'price': 17.40, 'reason': 'T1'}],
             'ctx': {}}]


BASE = {'shares': 100, 'account_equity': 100000, 'risk_pct': 0.5}
TTP = dict(BASE, fee_per_share=0.005, fee_min=0.75, min_profit_ps=0.1)
# What the Alpaca preset puts in the fields: nothing.
ALPACA = dict(BASE, fee_per_share='', fee_min='', min_profit_ps=None)

# ── the money ────────────────────────────────────────────────────────────────
ttp_fees = _account_block(trades(), TTP)['fees_usd']
alp_fees = _account_block(trades(), ALPACA)['fees_usd']

# THE NUMBER IS THE ONE FROM THE REAL RUN. #354's PL row reports fees_usd 27.77;
# if this fixture ever stops reproducing it, it has stopped being about that
# trade and the comparison below means nothing.
ok('the TTP schedule charges what backtest #354 charged on PL',
   abs(ttp_fees - 27.77) < 0.01, f'{ttp_fees} vs 27.77')
ok('the Alpaca schedule charges nothing', alp_fees == 0.0, str(alp_fees))
ok('...and that is a real difference, not a rounding one',
   ttp_fees - alp_fees > 25, f'{ttp_fees} - {alp_fees}')

# ── the prop-firm panel ──────────────────────────────────────────────────────
ok('Trade The Pool still gets its block', _ttp_block(trades(), [], TTP) is not None)
#
# NOT AN EMPTY BLOCK — NO BLOCK. A panel reporting "0 wins wasted under the
# $0.10 minimum" would read as an account passing a rule it is not subject to.
ok('an Alpaca run grows no prop-firm block at all',
   _ttp_block(trades(), [], ALPACA) is None)

# ── a zero rule is no rule, not a rule of zero ───────────────────────────────
#
# min_profit_ps of 0 must mean "there is no minimum", not "every win clears a
# minimum of nothing" — the second is the same sentence and a different fact the
# day somebody types 0 instead of clearing the field.
# A THIN WINNER: +0.03 a share, under Trade The Pool's $0.10 minimum and above
# nothing at all. It is the trade the two schedules disagree about.
def thin():
    return [{'date': '2026-09-08', 'symbol': 'AAA', 'side': 'long',
             'entry': 10.00, 'exit': 10.03, 'stop': 9.95, 'ret': 0.003,
             'reason': 'exit', 'entry_ts': 1, 'exit_ts': 2, 'ctx': {}}]


t_ttp = thin()
_account_block(t_ttp, TTP)
ok('under Trade The Pool a 3-cent win earns no credit',
   t_ttp[0]['ctx'].get('acct_no_credit') is True,
   str(t_ttp[0]['ctx'].get('acct_no_credit')))

t_alp = thin()
b_alp = _account_block(t_alp, ALPACA)
ok('under Alpaca the same win simply counts',
   not t_alp[0]['ctx'].get('acct_no_credit'),
   str(t_alp[0]['ctx'].get('acct_no_credit')))
ok('...because Alpaca reports no minimum at all',
   b_alp['min_profit_ps'] is None, str(b_alp['min_profit_ps']))

t_zero = thin()
b_zero = _account_block(t_zero, dict(BASE, fee_per_share='', fee_min='',
                                     min_profit_ps=0))
ok('min_profit_ps = 0 is NO rule, not a rule of zero',
   b_zero['min_profit_ps'] is None and not t_zero[0]['ctx'].get('acct_no_credit'),
   str(b_zero['min_profit_ps']))

# ── the preset the page actually offers ──────────────────────────────────────
page = (pathlib.Path(__file__).resolve().parents[1] / 'static' / 'index.html').read_text()
ok('the page offers an Alpaca preset', 'value="alpaca"' in page)
ok('...and still offers Trade The Pool', 'value="ttp"' in page)
ok('the presets are a table, so the next broker is one line',
   'BT_PRESETS = {' in page)
ok('the Alpaca entry is blanks, not small numbers',
   "alpaca: { fee:'',      feeMin:'',     minPs:''," in page)
#
# AND IT DOES NOT FORCE A FIXED SIZE. TTP sets 100 shares because its
# min-profit rule is read at a fixed size; Alpaca has no such rule, and forcing
# the field would put a prop-firm frame around an account that has none.
ok('the Alpaca entry sets no fixed share count',
   "alpaca: { fee:'',      feeMin:'',     minPs:'',     rules:true }" in page)
#
# A PRESET STILL TOUCHES ONLY THE FIELDS UNDER IT. It used to reach up and set
# the fill model two sections away, so picking a fee schedule silently changed
# an execution assumption.
ok('no preset touches the fill model', 'btFill' not in page.split('BT_PRESETS')[1][:900])
ok('and slippage is left alone — cost bps is its own control',
   'btCost' not in page.split('BT_PRESETS')[1][:900])

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
