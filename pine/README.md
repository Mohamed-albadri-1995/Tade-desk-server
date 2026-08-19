# The three ready strategies, in Pine

TradingView versions of `Test`, `OR + VWAP 09:35` and `T2 10:00 VWAP
Extension`. Paste one into Pine Editor, add it to a chart, open the Strategy
Tester.

**Put them on 1-minute bars.** All three are defined on minute data — a
09:30–09:35 opening range, a 09:35 trigger, a 09:41 split. On 5-minute bars the
range and the trigger become the same bar, which is a different strategy that
still produces a plausible-looking equity curve.

| file | strategy | side | orders per signal |
|---|---|---|---|
| `or_vwap_0935.pine` | OR + VWAP 09:35 | long + short | 2 |
| `t2_vwap_extension_1000.pine` | T2 10:00 VWAP Extension | long + short | 1 |
| `test_sma_vwap.pine` | Test | long only | 3 |

## What is NOT in here

**The ranking.** The desk runs a screener, ranks the survivors by VWAP
extension and takes the top two. Pine only ever sees one chart, so these fire
on whatever symbol you put them on.

That is the whole difference, and it is a big one. A green equity curve here
means *"this name would have qualified on these days"*, not *"the desk would
have traded it"* — on most of those days the desk was holding two other names
that ranked above it. Read these to check the **entry, the exits and the
timing**, not to size the edge.

Everything else is ported: the conditions, the thresholds, the opening ranges,
the stop, the scale-out fractions, one entry per day, the share floor, and the
15:50 flatten.

## Two things that are ported rather than approximated

**Session VWAP is computed by hand, not with `ta.vwap()`.** qp accumulates
`HLC3 × volume` over **RTH bars only** and resets at 09:30. Pine's built-in
accumulates every bar it is handed — so on a chart with extended hours switched
on it is a different line, and everything downstream of it is a different
strategy. Computing it directly makes the script correct regardless of how the
chart is configured.

**The VWAP band under `Test`'s stop is the volume-weighted one** — running
`E[p²] − E[p]²` around the VWAP, accumulated the same way the VWAP is. That is
not `ta.stdev` of close. They are different lines and the stop sits on this one.

**The intraday windows are half-open, `[start, end)`.** The 09:35 bar is the
*trigger* and is not part of the opening range it breaks out of.

## The one real disagreement — `Test`

`Test`'s stop is `hold: true` in qp: the backtest re-reads the VWAP band on
every bar and the stop follows it up. **A broker cannot do that.** It is handed
one price and that price stays there.

So the live trade and the backtested trade are not the same trade, and the
backtest is the more flattering of the two.

`test_sma_vwap.pine` has a **"Freeze stop at entry"** switch:

| | |
|---|---|
| **off** (default) | band re-read every bar — what qp backtests |
| **on** | band at the entry bar, frozen — what the broker gets |

Run it both ways on the same symbol. The gap between the two results is the
size of the exception, in your own numbers. Ticking **"fix at entry"** in the
strategy builder is what makes them agree.

The other two strategies have `freeze: true` and no toggle, because there is
nothing to toggle — their stops are already fixed.

## Sizing, and why `Test` needs ten shares

Each script sizes from **Risk per trade ($)** ÷ the distance to the stop, then
floors to whole shares — the same arithmetic the order layer uses.

It then refuses anything under **Do not trade under this many shares**:

- `OR + VWAP` and `T2 10:00` → **3**, the desk-wide floor
- `Test` → **10**

Ten, because `Test`'s smallest leg is 10% of the position. Under ten shares
that leg floors to zero and vanishes, and the account quietly runs a *two*-leg
strategy that looks exactly like this one. A grey ✕ on the chart marks a bar
that qualified on every condition and was refused only on size — the difference
between "no setup" and "a setup this account cannot hold".

The remainder always goes to the **runner**, so every share sized is a share
ordered. Ten shares becomes 1 / 8 / 1, not 1 / 8 / 0.

## Costs

Commission is set to **$0.75 per order** — the per-order fee, which is what
this desk actually pays. It matters more than it looks: a three-leg scale-out
is three orders, so `Test` pays it three times going in.

Slippage is **not** modelled. Signals are evaluated on the close of the
decision bar and filled at the next bar's open, which is the honest version —
that gap is the slippage, and it is already in the results.

## Keeping them honest

`tests/pine.parity.test.js` reads every threshold out of these files and checks
it against the seed JSON it came from. Edit a strategy in qp without following
it here and the suite fails, naming both.

It does **not** check that the Pine compiles — only TradingView can do that.
These tests prevent drift, not bugs.
