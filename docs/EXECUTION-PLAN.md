# How a real order should be placed — and how the live path measures up

Written in four parts, in this order deliberately:

1. **What the three strategies actually are**, read out of qp's engine rather
   than remembered.
2. **What SignalStack can and cannot do** — the constraint every design has to
   survive.
3. **The plan**: how execution should work, derived from 1 and 2 and *nothing
   else*. The current implementation is not consulted here.
4. **The judgement**: the live path against that plan.

Everything in parts 1 and 2 is cited to the file it came from, because the
whole exercise is worthless if the reference is remembered rather than read.

---

# Part 1 — What the three strategies are

The reference is not the seed JSON. It is `chart/strategy.py`'s simulation
loop, because **that is what produced every number anyone believes**. A live
order matches the backtest when it reproduces what that loop did, not when it
matches the fields in the seed.

## 1.1 The trade lifecycle qp simulates

From `chart/strategy.py`, the in-position block (≈ lines 1040–1210):

**Entry.** A signal is evaluated on bar *j*'s close. The fill model is a
parameter:

| `fill` | entry price | used by |
|---|---|---|
| `close` | bar *j*'s close | **the live decision** (`src/setups/qpClient.js` defaults `fill: 'close'`) |
| `next_open` | bar *j+1*'s open | described in the docstring as "the honest live assumption" |

The live path uses `close`. qp's own docstring calls that *"the chart-preview
assumption; optimistic by ~one spread."*

**Stop.** Armed at entry as `sl_at_entry`, and then one of two things:

- `freeze: true` → collapsed to a **fixed scalar** for the life of the trade.
- otherwise → re-read from a per-bar array, and **ratcheted**:

  ```python
  sl_eff = max(sl_eff, slv) if side == 'long' else min(sl_eff, slv)
  ```

  A protective stop **never loosens**. A long's stop can trail up with a rising
  anchor; it can never move down. When the anchor is NaN on a bar, the last
  level is held.

Fill: at the level on a within-bar touch, **at the open when the bar gaps
through it** — the slippage is charged, deliberately.

**Targets.** Each leg is a resting limit on its own share lot. Priority on a
single bar, quoted from the source comment:

> 1. scale-out target legs are resting LIMIT orders, each on its own share lot.
>    A bar whose range trades THROUGH a leg fills it — that lot is booked
>    regardless of what else the bar does. So bank every reached leg FIRST, then
>    the stop applies only to what's LEFT.
> 2. EXCEPTION — a bar that GAPS through the stop at the open … no partial banks.
> 3. stop on the remaining lot. 4) a SINGLE TP … 5) exit rule. 6) eod.

Plus `stop_first` (opt-in): when one bar touches both, assume the stop.

A target at or beyond the entry on the wrong side is skipped, not filled.

**Exit rule.** When the rule is true, `_close(j, close[j], 'exit')` — this
closes **the entire remaining position**, the runner included.

**End of day.** `eod_close` marks each day's last bar before the 15:50 cutoff;
anything still held is closed at that bar's close.

**Caps.** `max_entries_per_day` is enforced inside the loop. `min_target_usd`
and `max_stop_pct` drop a signal *before* it opens.

Because the live decision runs through the *same* `strat.evaluate()`
(`chart/decide.py:76`), every one of those gates applies live too. That is a
genuine strength and worth stating plainly: **there is one engine, not two.**

## 1.2 The three strategies, exactly

### `OR + VWAP 09:35` — long and short

| | |
|---|---|
| decided | once, on the 09:35 bar (`window_start = window_end = 935`) |
| entries/day | 1 |
| stop | opening-range midpoint, `freeze: true` → **fixed** |
| legs | 50% at 2R |
| runner | 50%, `manage: eod` |
| exit rule | `close crosses below VWAP` (mirrored for the short) |
| `min_target_usd` | 0.10 |

Opening range is `[09:30, 09:35)` — half-open. The 09:35 bar is the trigger and
is not part of the range it breaks.

**The exit rule is the whole runner's exit.** In the backtest the VWAP cross
closes the remaining 50%. Without it the runner is a different instrument.

### `T2 10:00 VWAP Extension` — long and short

| | |
|---|---|
| decided | once, on the 10:00 bar |
| entries/day | 1 |
| stop | session VWAP at entry, `freeze: true` → **fixed** |
| legs | 100% at 2R |
| runner | none |
| exit rule | none |
| `stop_first` | **true** — when a bar touches both, the stop wins |

The simplest of the three, and the only one with no runner and no rule. One
order, one bracket.

### `Test` — long only

| | |
|---|---|
| decided | every bar from 09:30 to 11:30 (a watch setup) |
| entries/day | 1 |
| stop | lower VWAP stdev band, mult 0.2, `hold: true`, **not frozen** |
| legs | 10% at 3R, 80% at 6R |
| runner | 10%, `manage: eod` |
| exit rule | none |

**Its stop moves, and it ratchets.** In the backtest the stop follows the band
up and never down. This is not "a stop that drifts" — it is a trailing stop
with a floor, and the difference between it and a fixed stop is most of the
strategy's character.

The band itself is a **volume-weighted** stdev around the session VWAP —
`E[p²] − E[p]²` accumulated the same way the VWAP is (`qp/primitives/vwap.py`,
`stdev_bands`). Not a rolling stdev of close.

---

# Part 2 — What SignalStack can and cannot do

The constraint surface, from `src/broker/signalstack.js` and the live traffic
observed on 2026-08-17/18.

**The request is a flat JSON body.** The fields actually used:

```json
{"symbol":"EYPT","action":"buy","quantity":175,"quantity_type":"fixed",
 "stop_loss_price":5.03,"take_profit_price":6.10,
 "class":"stock","duration":"day"}
```

`class` and `duration` are the Alpaca dialect's additions; Trade The Pool takes
the bare body.

**One bracket per order.** There is one `take_profit_price` and one
`stop_loss_price`. A strategy with two targets and a runner is therefore
**three separate orders**, and that is not a workaround — it is the only shape
available.

**`action: 'close'`** closes a whole symbol, taking no quantity.

**Three verbs are in use: `buy`, `sell`, `close`.** No modify and no cancel
appear anywhere in the integration. Whether SignalStack offers them is
*unverified* — but nothing here uses them, so every design below assumes an
order, once placed, cannot be amended.

**The reply is not a fill.** SignalStack accepts the POST and the broker refuses
afterwards — by email, hours later. Both live rejections seen so far arrived
that way:

- `From Alpaca: asset "CAPR" cannot be sold short`
- `From TraderEvolution: Trading disabled by risk rules. Weekly loss limit was reached.`

**There is a callback.** SignalStack can POST when an order is *processed* —
the half the reply cannot give.

**SignalStack has no position query.** Nothing can be asked "what do I hold"
*through the bridge*.

> **CORRECTED after this was written.** That was stated as a limit on the desk,
> and it is only a limit on SignalStack. The account behind the bridge is an
> **Alpaca** account, and Alpaca answers all three — `GET /v2/positions`,
> `/v2/orders`, `/v2/account/activities/FILL` — with the credentials the borrow
> check already holds. Nothing new had to be granted; the question had simply
> never been asked. See `src/alpaca/account.js` and `src/broker/reconcile.js`.
>
> It remains true for **TTP5k**, a Trade The Pool account behind
> TraderEvolution with no position feed. So the desk is half-verified, and
> every answer names which half.

---

# Part 3 — The plan

Derived from Parts 1 and 2. One requirement, and everything follows from it:

> **The live position must behave the way the backtested one did — and where it
> cannot, the difference must be a number somebody chose, not a surprise.**

Sort every element of a qp trade by who can hold it:

| element | broker can hold it? |
|---|---|
| entry | yes — a market order |
| fixed stop | yes |
| target on a lot | yes |
| **moving / ratcheting stop** | **no** |
| **exit rule** (a VWAP cross) | **no** |
| **end-of-day flat** | **no** |

Three groups, so three parts to the design.

## Stage 1 — The intent, written before anything is sent

The decision produces one immutable record, with an id, persisted *before* the
first POST:

```
intent {
  id, date, setupId, symbol, side
  referencePrice      the bar close the decision was made on
  stopAtEntry         the armed stop
  R                   |reference − stop|
  legs[]              { fraction, rMultiple, targetPrice }
  runnerFraction
  stopBehaviour       fixed | ratcheting(anchor)
  exitRule            null | descriptor
  deadline            15:50
  accounts[]          { id, shares, legShares[] }
}
```

Why first, and why immutable: everything after this can fail, and a failure
that leaves no record of what was *intended* cannot be repaired. It is also the
only object against which "did we place what we meant to" can be asked.

## Stage 2 — Sizing

Per account, in this order:

1. `shares = floor(riskBudget / R)`
2. split by fraction, **remainder to the runner**, so every share sized is a
   share ordered
3. **reject the whole trade for that account** if any leg floors to zero, or the
   total is under the account's minimum

Point 3 is not a nicety. A 10%/80%/10% strategy at 9 shares silently becomes a
two-leg strategy, and nothing downstream can tell.

**Size from the price you will get, not the one you ranked at.** The decision is
made on the 09:35 close and the order fills at market around 09:36. If that gap
is not measured it is not zero, it is unknown — and R, every target and the
share count are all derived from a price that was never traded.

The honest options are: send a limit at the reference price and accept
non-fills, or send market and **record intended-vs-actual** so the drift is
visible. Either is defensible. Silence is not.

## Stage 3 — Placement

One order per leg. The runner carries a stop and **no** `take_profit_price`.

**Placement must be all-or-nothing in effect.** If leg 1 fills and leg 2 is
refused, the position that exists is not the tested strategy — it is 50% of it
with the wrong exits. Two acceptable resolutions:

- unwind what went in (`close`) and report the trade as not taken, or
- report a **loud, specific** alarm naming the shape actually held

What is not acceptable is a line saying `partial` on a page nobody is reading
at 09:36.

## Stage 4 — Confirmation

The POST reply means *accepted for delivery*. The order exists when the callback
says it does, or when it can be seen at the broker.

So: an order is `sent` until a callback confirms it, and a `sent` order with no
callback after a threshold is **an open question**, not a position.

## Stage 5 — The management loop

The part no broker performs, and the part that decides whether the live trade is
the tested one.

Once a minute, for every open intent:

**a. Ratcheting stops (`Test`).** Recompute the anchor. Apply the ratchet —
never loosen. If the level moved *and* SignalStack cannot amend an order, there
are exactly two faithful implementations:

- **synthetic stop** — the box holds the level and sends `close` when price
  breaches it. Faithful in level, divergent in fill: the backtest fills at the
  level intrabar, this fills at the next observation, and on a gap it fills far
  worse.
- **freeze it** — send one fixed stop and accept that the strategy being traded
  is not the strategy that was tested.

**There is no third option, and this must be an explicit choice recorded on the
strategy.** A strategy whose stop moves, executed through a channel that cannot
move stops, is misdescribed by definition.

**b. Exit rules (`OR + VWAP 09:35`).** Evaluate the rule on each closed bar. When
true, `close` the whole remaining position. This is not optional garnish — the
09:35 runner has *no other exit* in the backtest except the stop and the bell,
and the rule is what the tested win rate was measured with.

**c. Breakeven moves**, where a strategy declares one. Same constraint as (a).

## Stage 6 — The deadline

At 15:50, close everything opened today. Two properties:

- **idempotent** — closing a flat symbol is a no-op, so over-closing is safe and
  under-closing is an overnight position. Over-close.
- **independent of belief** — it must not require knowing whether the position is
  still open, because that cannot be known (Part 2).

Scope it to **what this desk opened**, so a position taken by hand is not swept
up by it.

## Stage 7 — Reconciliation

A ledger that only records what was sent drifts from reality the first time a
stop fills. Where the broker can be asked, ask it; where it cannot, say so.

The end-of-day answer is assembled from intents, orders, callbacks and the
broker's own statement, and anything they disagree about is a finding rather
than a rounding error. Four disagreements matter, and they do not cost the same:

| | cost of getting it wrong |
|---|---|
| we think open, the broker is flat | a wasted close, and an "exit" for a trade that ended an hour ago |
| **the broker holds it and we do not know** | **nothing here will flatten it — it goes overnight** |
| the quantity disagrees | a leg did not fill; the position is not the tested shape |
| sent, and the broker has no record | the alert said the trade was on |

The second is the dangerous one, because the 15:50 flatten closes what the
LEDGER says was opened.

One distinction carries all of this: **"the broker says you hold nothing" and
"the broker did not answer" are opposite instructions.** Anything that cannot
tell them apart will eventually act on the wrong one, so an unreachable broker
returns `null`, never an empty set.

## Stage 8 — What must never be silent

Ranked by cost:

1. an order placed twice for one signal
2. a leg missing from a scale-out
3. a protective check that did not run
4. a fill materially away from the reference price
5. a position still open after the deadline

Each needs to be visible **on the alert**, in the same sentence as the trade —
not in a log, and not on a page.

---

# Part 4 — The live path, judged against that plan

## What is right

| stage | verdict |
|---|---|
| **Sizing** | Correct. Risk ÷ R, floored, remainder to the runner, per account, with a 3-share floor. Proven live: `legs[175@6.1 176→runner]` on EYPT. |
| **Placement shape** | Correct. One order per leg; the runner carries a stop and no target. Proven live. |
| **Pre-send validation** | Strong. Whole shares, sub-penny prices, stop on the correct side, minimum target distance, shortability (now that credentials resolve). |
| **Duplicate protection** | Correct, and held on the ledger where a crash cannot jump it. |
| **Daily caps** | Correct — counted in positions, so accounts and legs do not distort them. |
| **The deadline** | Correct, including the deliberate over-closing. Verified live on 2026-08-17. |
| **One engine** | The live decision runs through `strat.evaluate()` — the same simulator as the backtest. This is the single best property the system has. |

## What is missing

### 1. There is no management loop at all — Stage 5 does not exist

This is the finding. Everything else is secondary to it.

Once the orders are placed, **nothing observes the position again until 15:50.**
Two direct consequences:

**`OR + VWAP 09:35`'s exit rule is never executed.** The backtest closes the
entire remaining position when close crosses back through VWAP. Live, the runner
rides its stop to the bell. The 50% runner is therefore being traded with an
exit the backtest never used.

Worse, **nothing flags it.** `exit_protocol.validate()` raises `order_errors`
only when a leg's `tp_kind` is `'rule'` — which happens only when the strategy
has *no targets at all*. 09:35 has a target on leg 1, so `order_ok` is `true`
and the rule is dropped in silence.

*This is the one defect that would change reported results without ever looking
like a bug.*

**`Test`'s stop never ratchets.** The backtest trails it up the band and never
down. Live it is sent once, as a level, and stays. The two are different
strategies, and the backtested one is the more flattering.

This one *is* flagged — `stop_anchored` puts a note on the alert — which is why
it has been a known exception rather than a discovery. That is the difference
the flag makes, and it is exactly what the exit rule lacks.

### 2. Intent is never recorded separately from the order — Stage 1

There is a ledger row per order, which is not the same thing. There is no record
of *what the trade was meant to be*, so "did we place what we meant to" can only
be answered by re-deriving it, and a failure between decision and placement
leaves nothing behind.

### 3. Intended fill versus actual fill is not measured — Stage 2

Everything is computed from the decision bar's close and sent to market roughly
60–90 seconds later. qp's own docstring calls `fill: 'close'` optimistic. The
difference is never recorded, so its size is unknown — and it enters R, both
targets and the share count.

The callback carries `fillPrice`, and `reconciled()` already surfaces it as
`finalPrice` beside the `price` the decision used. The subtraction is never
done. One line away from being a measured number instead of an unknown one.

### 4. A partial placement is reported, not resolved — Stage 3

```js
if (!r.ok) break;
```

Leg 1 goes in, leg 2 is refused, and the desk holds half a position with the
wrong exits. The result is marked `partial` and the alert says so — but nothing
unwinds it and nothing escalates. Under the plan this is the second most
expensive failure there is.

### 5. Acceptance and existence are joined, but nothing acts on the difference — Stage 4

Better than it first appears. `reconciled(date)` already joins callbacks back to
their orders and exposes exactly the right three fields:

```js
finalStatus,  finalPrice,  confirmed: !!last
```

The data is there and the comment names the point — *"accepted, never heard from
again is information"*. What is missing is anything that **reads** it:

- `confirmed: false` is never escalated. It is rendered on the alerts page
  (`src/alerts/server.js:216`) and nowhere else — so an order accepted by
  SignalStack and silently dropped by the broker looks exactly like a filled one
  unless somebody opens that page and notices.
- `finalPrice` is never compared to `price`. See below.

This is a small gap, not a structural one. The join is the hard part and it is
done.

### 6. Reconciliation is one-sided — Stage 7

`openSymbols()` is *what we sent minus what we closed*. It cannot see a stop that
filled, so it over-reports — which is right for the flatten and wrong for
everything else. There is no third source to check against.

### 7. Smaller, real

- **`stop_first` is a backtest-only convention.** T2 10:00 sets it; live has no
  analogue. The backtest is conservative in a way the live trade is not, so live
  results should come in slightly *better* than tested on that strategy. Worth
  knowing, not worth fixing.
- **The flatten closes a whole symbol**, so a hand-taken position in the same
  name is swept up with the desk's.
- **A three-leg placement has never been verified at a broker.** Only the
  two-leg 09:35 has gone in live. Multiple simultaneous brackets on one symbol
  can be refused for insufficient quantity depending on the broker; unproven
  either way.

## The verdict, in one paragraph

The **order-placement** half is sound and now proven live: the shapes are right,
the sizing is right, the gates are real, and the same engine decides live as
backtests. The **position-management** half does not exist. Two of the three
strategies depend on it — 09:35 for its runner's exit, `Test` for its ratcheting
stop — and only one of those two is currently disclosed. Until Stage 5 exists,
`T2 10:00` is the only one of the three whose live trade is the trade that was
tested, and it is the only one currently switched off.

## What to do, in order

1. **Make `order_ok` false when an exit rule exists and is not executable**, so
   09:35 declares itself the way `Test` already does. This is a small change and
   it converts a silent divergence into a stated one.
2. **Build Stage 5** — a once-a-minute loop over open intents that evaluates exit
   rules and ratchets stops through `close`. This makes 09:35 faithful and gives
   `Test` its choice.
3. **Subtract `finalPrice` from `price`** and put it on the alert — the join
   already exists, only the arithmetic is missing — and **escalate
   `confirmed: false`** after a threshold instead of leaving it on a page.
4. **Record intent** as its own object, before the first POST.
5. **Resolve partial placements** rather than reporting them.
6. **Verify a three-leg placement** at the broker before `Test` is armed again.

Steps 1 and 3 are small — a validation branch and a subtraction. Step 2 is the
real work, and nothing in two of the three strategies is faithful without it.

---

## Where each of those stands

**1 — declared, not blocked.** `has_exit_rule` is a warning rather than
`order_ok: false`. Switching 09:35 off was the wrong fix once the loop below
existed: the divergence it warned about is the thing the loop closes.

**2 — built.** `src/setups/manager.js` in the alerts process, once a minute,
every judgement made by `quant-platform/chart/manage.py` out of the same
functions the simulation uses. It scans every bar since entry, because a cross
is an EDGE and reading only the newest bar would lose an exit permanently if the
pass were one minute late. The stop ratchets from the anchor at the entry bar.
Every pass is now written to `data/history/session-YYYY-MM.jsonl` — see
`src/setups/sessionLog.js` — so "why did it not close at 10:47" has an answer
for the first time.

**3 — done.** `slipOf()` signs the difference against the position and it is on
the alert, on the day report and on the journal card.

**4 — done.** An intent row goes down before the first POST and the outcome
after the last, under one `intentId`. It closed a window in which an order could
exist at the broker with nothing on this side recording that it was ever
attempted — which was not only a lost record: the repeat guard reads the ledger,
so a crash mid-send re-armed the setup for a name it may already hold.
`orphanIntents()` finds an intent with no outcome; the manager announces each
one once, at error level, and the day report leads with them.

**5 — escalated, deliberately not unwound.** A half-placed scale-out now raises
its own error-level alert naming the legs that went in and the ones that did
not. It is **not** closed automatically: every leg goes out as its own bracket,
so what got in carries its own stop and target — it is the wrong SIZE, not an
open risk — and a certain round trip to undo an uncertain problem is a decision
about money. The alert says exactly that, so the choice is made knowingly rather
than by default.

**6 — still open, and it needs a market.** A three-leg placement has never been
watched arrive at a broker. `scripts/order-test.js` will send one on the paper
account; until it has been run and the broker's own order list checked, `Test`
should stay off.
