"""The account's share of the standard size, in the backtest as well as live.

2026-09-15, OR + VWAP 09:35, alpaca1 with `ratio: 0.9`:

    SHORT FTAI 384 sh @ 175.30 stop 176.60 · alpaca1: 345 accepted
    SHORT BLSH 2040 sh @ 36.03  stop 36.275 · alpaca1: 1096 accepted

384 is the risk size: $500 / $1.30 a share. 345 is floor(384 x 0.9) — the
account's ratio, applied by src/setups/risk.js:279 as

    shares = Math.floor(standard.shares * ratio)

The backtest of that same morning had never heard of the setting and reports
384. Ten percent under, on every position, on every comparison — and the reason
appears nowhere in either run. The trader found it by arithmetic, from a share
count, which is the one way nobody should have to find it.

IT IS NOT A SMALLER ACCOUNT, and this is the part worth being careful about.
`account_equity` 90,000 scales the capital caps and leaves the share count at
384, because a flat risk_usd does not read equity at all. The ratio scales the
SHARES. Substituting one for the other gives a number that is arithmetically
fine about the wrong question — and it is the substitution anyone would reach
for first, because both of them sound like "make the account smaller".

ORDER MATTERS. Live scales in risk.js and THEN lets the broker fit what is left
of the buying power, so the ratio goes before both caps here. Reversed, a
position capped to the account's limit would be scaled a second time and come
out at 0.9 of a cap that was already the maximum.

AND IT IS REPORTED WHEN IT IS 1.0 TOO. A run that says nothing about its ratio
is indistinguishable from a run at full size, which is exactly the state this
whole entry came from.
"""
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from chart.backtest import _account_block                          # noqa: E402

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


def trade(symbol, entry, stop, pnl_per_share, side='short'):
    """One closed trade, shaped as the sizer reads it."""
    return {'symbol': symbol, 'side': side, 'entry': entry, 'stop': stop,
            'pnl_per_share': pnl_per_share,
            'entry_ts': 1_757_000_000, 'exit_ts': 1_757_003_600}


def run(trades, **spec):
    """_account_block returns the SUMMARY and stamps the sized count onto each
    trade's ctx as `acct_shares`, in place. Both are read where they land —
    `shares` is not a key on the trade, and a test reading one would report
    None for every size and pass nothing.
    """
    base = {'account_equity': 100_000, 'risk_usd': 500, 'max_leverage': 1}
    base.update(spec)
    rows = [dict(t) for t in trades]
    summary = _account_block(rows, base)
    return {'summary': summary, 'all': rows}


def shares_of(res, i=0):
    """The count this trade was actually sized at, or None if it was skipped."""
    return ((res['all'][i].get('ctx') or {}).get('acct_shares'))


# The real morning: $500 a trade, $1.30 of stop, 384 shares at the standard.
FTAI = trade('FTAI', 175.30, 176.60, 0.40)
BLSH = trade('BLSH', 36.03, 36.275, 0.05)

print('\n── the number the desk actually sent ──────────────────────────────')

full = run([FTAI])
ok('at full size the risk sizer gives 384 shares',
   shares_of(full) == 384, str(shares_of(full)))

nine = run([FTAI], size_ratio=0.9)
ok('at ratio 0.9 it gives 345 — the count alpaca1 was sent',
   shares_of(nine) == 345, str(shares_of(nine)))
ok('and that is floor, not round: 384 x 0.9 = 345.6',
   math.floor(384 * 0.9) == 345)

print('\n── a smaller ACCOUNT is not the same knob ─────────────────────────')

# THE SUBSTITUTION THAT LOOKS RIGHT AND IS NOT. risk_usd is flat dollars; it
# does not read equity, so the share count does not move at all.
smaller = run([FTAI], account_equity=90_000)
ok('90k equity leaves the share count at 384, not 345',
   shares_of(smaller) == 384, str(shares_of(smaller)))
ok('so equity and ratio are genuinely different settings',
   shares_of(smaller) != shares_of(nine))

print('\n── the ratio goes BEFORE the caps, as it does live ────────────────')

# A per-position cap of 25% of 100k = $25,000 / 175.30 = 142 shares. The ratio
# is applied first, to 384, and 345 is still above the cap — so the cap binds
# and 142 comes out. If the ratio were applied AFTER, the answer would be
# floor(142 x 0.9) = 127: a position scaled twice.
capped = run([FTAI], size_ratio=0.9, max_position_pct=25)
ok('a capped position is capped once, not scaled twice',
   shares_of(capped) == math.floor(25_000 / 175.30),
   str(shares_of(capped)))
ok('and that is not the double-scaled number',
   shares_of(capped) != math.floor(math.floor(25_000 / 175.30) * 0.9))

print('\n── the portfolio cap still binds after it ─────────────────────────')

# BOTH NAMES, IN RANK ORDER, on one $100k cash balance — the real 09-15 shape.
# FTAI takes 345 x 175.30 = $60,478; BLSH asks floor(2040 x 0.9) = 1836, which
# is $66,151, and only $39,521 is left.
both = run([FTAI, BLSH], size_ratio=0.9)
sh = {t['symbol']: (t.get('ctx') or {}).get('acct_shares') for t in both['all']}
ok('FTAI keeps its scaled size', sh.get('FTAI') == 345, str(sh))
ok('BLSH is cut to what the balance leaves, not to 1836',
   sh.get('BLSH') == math.floor((100_000 - 345 * 175.30) / 36.03), str(sh))
ok('and the run says a size was cut by leverage',
   both['summary']['size_capped_by_leverage'] >= 1)

print('\n── what the run says about itself ─────────────────────────────────')

ok('the ratio is reported', nine['summary']['size_ratio'] == 0.9)
# EVEN AT FULL SIZE. "This run did not scale" has to be a statement, not a
# missing field — a reader comparing two runs needs both to say so.
ok('and it is reported at full size too, rather than being absent',
   full['summary'].get('size_ratio') == 1.0, str(full['summary'].get('size_ratio')))
ok('the count of positions it shrank is reported',
   nine['summary']['size_scaled_by_ratio'] == 1,
   str(nine['summary'].get('size_scaled_by_ratio')))
ok('and nothing is counted as scaled when the ratio is 1',
   full['summary']['size_scaled_by_ratio'] == 0)

print('\n── under one whole share is an ANSWER, not a missing stop ─────────')

# Nine shares at the standard, x 0.05, is 0.45 of a share. The account is too
# small a piece of the standard to take this name — which risk.js says in these
# same words. Filing it under "no stop" would send you to the wrong setting.
tiny = trade('TINY', 50.0, 105.0, 1.0)         # $55 of stop -> 9 shares
t9 = run([tiny], size_ratio=0.05)
ok('a position scaled under one share is not taken',
   t9['summary']['trades_sized'] == 0, str(t9['summary'].get('trades_sized')))
ok('and it is counted as a ratio problem, not as a missing stop',
   t9['summary']['unsized_under_one_share_after_ratio'] == 1
   and t9['summary']['unsized_no_stop'] == 0,
   str(t9['summary']))

print('\n── a run with no ratio set behaves exactly as before ──────────────')

ok('an absent ratio is full size', shares_of(run([FTAI])) == 384)
ok('a ratio of 0 is refused rather than sizing everything to nothing',
   shares_of(run([FTAI], size_ratio=0)) == 384)
ok('and so is a ratio that is not a number',
   shares_of(run([FTAI], size_ratio='')) == 384)

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
