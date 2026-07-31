# Methodology

What each tool hunts for, why its filters are what they are, and how it is
measured. One file, kept next to the code it describes.

Seven tools run the same software against different screeners. Each has its own
database, its own model and its own training history — nothing is shared, so
one tool's results cannot contaminate another's.

---

## What applies to everything

### The tradability floor

Three conditions are added to **every screener on every tool**, existing and
future, at the moment a scan is sent. They are not in any screener's rule list
because they are not in any screener — the scanner appends them on the way out.

| Rule | Why |
|---|---|
| average volume ≥ 1M shares/day | Below this you cannot get out at a price you chose. |
| ATR ≥ $1 | Below this there is not enough movement to pay for the risk. |
| ATR ≥ 3% of price | The same question relative to the stock. A $200 name with a $2 ATR clears the dollar test easily and still has only 1% of range to work with. |

Editable in **Settings** — `minAvgVolume`, `minAtr`, `minAtrPct`. Setting one to
0 switches that leg off. Changing it changes every screener at once, which is
the point of it living in one place.

### How success is measured

There is **no stop, no target and no exit**. This is on purpose: the question
being asked is "does this screener find stocks that move", which is the only
thing a screener can be held responsible for. Whether a move is tradable is a
question about setups, and comes after you know which screeners are worth
keeping.

For every card, at the end of the day:

```
entry = the OPEN of the entry-minute bar
hh    = highest high from that bar to the close
ll    = lowest low  from that bar to the close

upR   = (hh − entry) / ATR14      how far it ran your way
downR = (entry − ll) / ATR14      how far it went against you first
```

Both are positive numbers. ATR14 is built from daily bars **strictly before
today**, so nothing looks ahead. Bars are regular session only — pre-market and
after-hours spikes cannot inflate a result.

A **good move** is `upR ≥ 1.3`. The same threshold the model calls a win, so the
scorecard and the model are not grading on different curves.

Worked example — entry $10, high $12.50, low $9.40, ATR $1:
**upR 2.5, downR 0.6.**

### The learning moment

Each tool takes **one photo a day** of every card on screen, then measures how
far each ran from two entry times shortly after. Photo plus result is one
training row — the only thing the score model ever learns from.

A stock found after the photo still shows on screen and can be traded, but it
teaches the model nothing. The photo time therefore follows each tool's own
session, and always lands one minute after one of that tool's discovery scans,
so it freezes a fresh registry rather than the previous scan's.

### Discovery vs refresh

A screener's run window gates **discovery only** — whether new candidates are
added. Cards already on screen keep re-quoting every five minutes from 04:00 to
16:00 regardless, because a card found at 09:40 is still being watched at 15:00
and its price, VWAP, distances and tags have to keep up with the tape.

### Mirrors

Most tools ship a screener and its **mirror** — the same structural setup facing
the other way — so a month of data can answer "is this edge directional, or does
this screener just find movers?".

Mirroring is not blind operator inversion:

- **Directional rules flip sign**: `change > 5` becomes `change < −5`.
- **High/low pairs swap to their counterpart**: `close ≥ 1-month high` becomes
  `close ≤ 1-month LOW`. Inverting only the operator would give "below the
  monthly high", true of nearly every stock, screening for nothing.
- **Bounded oscillators reflect**: `RSI > 70` becomes `RSI < 30`, not `RSI < 70`.
- **Quality guards survive untouched**: `price > $1`, `volume > 2M`. Inverting a
  guard selects illiquid junk, not the bearish counterpart of the setup.

---

## T1 — Screener · port 3000

**The control.** The original tool, and the only one with history: a month of
cards, the model trained on them, and the one edge measured out of them so far.

### Screeners — all three run all day

**Trend** — intraday trend continuation.

```
close ≥ 20                          established price, not a penny stock
close ≥ SMA5   and  close ≥ VWAP    above the short average and the day's average price
close|1W > VWAP|1W                  above the weekly VWAP
close|1M > VWAP|1M                  above the monthly VWAP
EMA50|1 > EMA120|1                  daily trend is up
close|1 ≥ EMA50|1                   holding the daily trend line
VWAP ≥ SMA75|5                      intraday VWAP above the 5-minute 75 average
relative_volume_intraday|5 > 3      volume arriving right now
relative_volume_10d_calc > 1.5      and elevated for the day
average_volume_90d_calc > 1M        liquid
```

Alignment across every timeframe at once — day, week, month, and the last few
minutes.

**Pre-Mkt** — pre-market participation.

```
premarket_volume > 1.5M      real pre-market trade, not an indication
relative_volume_10d_calc > 3
average_volume_10d_calc > 2M
close ≥ 1
```

**Big Move** — the crude one, and it works.

```
relative_volume_10d_calc > 10     ten times normal volume
close ≥ 2
average_volume_10d_calc > 2M
```

### Why T1 has no run windows

Pre-Mkt is built on `premarket_volume`, which stops moving at the bell — its
filters plainly say "pre-market only". It is still left running all day, on
purpose.

The one edge measured so far is the **overlap between Big Move and Pre-Mkt**:
54% of those cards made a good move against 13% for everything else
(Fisher p = 0.0015, spread over 11 days, survives dropping the two biggest
winners). That overlap is read off the cards frozen at 09:36. Giving Pre-Mkt the
window its filters suggest would stop it running in the 09:30–09:36 scans and
strip the Pre-Mkt tag off every frozen row — deleting the measurement rather
than improving it.

T1 stays exactly as it was, so the other six have something to be compared
against.

**Capture:** photo 09:36, entries 09:37 / 09:40.

---

## T2 — Momentum · port 3010

**Looking for:** a stock in a clean daily uptrend breaking to a new monthly high.

```
SMA5|1 > EMA9|1 > EMA13|1 > EMA20|1     daily averages stacked fast-over-slow
close ≥ High.1M                          breaking the 1-month high
close ≥ 1
average_volume_10d_calc > 500K
```

**Why these filters.** The stack is a statement about the daily trend: each
faster average above the slower one means every recent period has been stronger
than the one before it. On its own that only says the stock has been rising —
the monthly-high break is what makes it an event rather than a description.

The stack barely moves intraday, so what the screener is really timing is the
break.

**Mirror:** stack inverted, `close ≤ Low.1M`. Breakdown from a downtrend.

**Window 09:30–15:00.** A break on pre-market liquidity is not a break, and one
in the last hour leaves no session to work with.

**Capture:** photo 09:46, entries 09:47 / 09:51 — fifteen minutes past the open,
so a break that was one opening spike has already failed and is not in the
photo.

---

## T3 — Gappers · port 3020

**Looking for:** a small-float stock gapping up on real pre-market volume.

```
premarket_change > 5                      gapping up at least 5%
premarket_volume > 500K                   people actually traded it
relative_volume_10d_calc > 2
close ≥ 1
float_shares_outstanding < 50M            small float
```

**Why these filters.** A gap with no pre-market volume is a quote, not a move —
it can vanish at the bell. The float cap is the deliberate part: a small float
is what lets a gap keep extending after the open, because there is not much
stock available to sell into the buying.

**Mirror:** `premarket_change < −5`, everything else identical. Gap down.

**Window 04:00–10:30.** `premarket_change` and `premarket_volume` freeze at the
bell — after that they are yesterday's numbers. Left running all day this
screener would re-report the same names until the close and none of it would be
new. It gets the pre-market plus the first hour, where a gap either continues or
fails.

**Capture:** photo 09:36, entries 09:37 / 09:40 — a gap is an opening trade.

---

## T4 — VWAP Reclaim · port 3030

**Looking for:** a stock that sold off, then pushed back up through VWAP with
volume behind it. **The reversal tool.**

```
close crosses_above VWAP                  the reclaim itself
relative_volume_10d_calc > 2              volume behind it, not drift
close ≥ 1
average_volume_10d_calc > 1M
```

**Why these filters.** VWAP is where the average buyer of the day is even.
Crossing back above it flips that group from losing to winning, which is why
reclaims tend to run. Without the volume condition the cross is drift, and drift
across VWAP reverses as easily as it holds.

**Mirror:** `crosses_below`. The loss of VWAP.

**Window 09:45–15:30.** This is the tool that deliberately stays awake into the
afternoon, because reversals come late — the "move first, then reverse" case. It
starts at 09:45 rather than the bell because VWAP computed off the first few
prints is not yet a level anything is reclaiming, and stops at 15:30 because a
reclaim in the last half hour has no session left to resolve in.

**Capture:** photo 10:01, entries 10:02 / 10:06.

**Known limitation:** a cross is a moment, and discovery runs every 15 minutes
after 10:00. Some crosses will be missed between scans.

---

## T5 — 52-Week Break · port 3040

**Looking for:** an established company clearing its 52-week high.

```
close ≥ price_52_week_high        at or through the yearly high
market_cap_basic > $1B            established, not a small cap
relative_volume_10d_calc > 1.5
average_volume_10d_calc > 1M
```

**Why these filters.** The billion-dollar floor is the deliberate part, and it
is there for a reason beyond the strategy: every other tool samples cheap small
caps, which is what let share price dominate the factor model. This tool gives
that finding something to be tested against.

At a 52-week high there is nobody holding the stock at a loss waiting to sell
into strength — no overhead supply.

**Mirror:** `close ≤ price_52_week_low`. The yearly low.

**Window 09:30–16:00.** These break on institutional flow, which arrives at any
hour and often late in the day. Pre-market is excluded: a 52-week high printed
on a handful of thin shares is not a break.

**Capture:** photo 09:46, entries 09:47 / 09:51.

---

## T6 — Overextended · port 3050

**Looking for:** a stock stretched far enough to be worth watching for a snap
back. **The fade tool.**

```
RSI > 70                          overbought
close ≥ EMA20                     extended above its own recent average
relative_volume_10d_calc > 3      the extension is being driven, not drifting
close ≥ 1
average_volume_10d_calc > 1M
```

**Why these filters.** RSI alone finds stocks that have been strong for weeks
without going anywhere today. Pairing it with the volume condition restricts it
to extension being made right now.

This tool exists to answer a question rather than to state a view: **does an
extreme continue, or does it revert?** The mirror is what makes that answerable.

**Mirror:** `RSI < 30`, `close ≤ EMA20`. Genuinely oversold.

**Window 10:00–16:00.** At the open RSI still describes yesterday's close;
extension is something the session builds. Then it runs to the close, because a
stock can be stretched at any hour and the fade is the trade.

**Capture:** photo 10:16, entries 10:17 / 10:21.

---

## T7 — Liquid Movers · port 3060

**Looking for:** heavy real volume and real range, split by session. The only
tool that refuses thin stocks outright rather than as a side effect.

Its two screeners are **not** a mirror pair. Each is a complete setup for its own
session, and the sessions do not overlap, so a stock lands in one or the other.

**Pre-Market Gap** — 04:00–09:30

```
gap not between −3% and +3%           moving either way, at least 3%
ATR ≥ $1
average_volume_90d_calc ≥ 2M
```

Direction-agnostic on purpose. TradingView has no absolute-value operator, so
"gap up or down 3%" is written as "outside −3%..+3%", which is the same set.

**After Open Volume** — 09:30–16:00

```
relative_volume_10d_calc > 3
volume > 10M shares                   actually traded today, not an average
close > 1
```

**Why these filters.** `volume` rather than average volume is the distinctive
choice: it asks what has traded *today*, so the screener only fires once real
participation has shown up.

**Capture:** photo 09:36, entries 09:37 / 09:40. The pre-market screener is what
feeds training here — its candidates are all in by the bell. The after-open
screener finds tradable stocks all day, but they arrive after the photo and do
not train the model.

---

## Reading the scorecard

**Analysis → Screener scorecard**, per screener, over every captured day:

| Column | Meaning |
|---|---|
| Cards / Days | sample size — under 20 cards or 5 days is left unjudged |
| Median R | half its cards did better than this |
| Avg R | average move in your favour |
| Avg −R | average move against you first (stored positive) |
| ≥1.3R | share of cards that made a good move |
| ≥2R | share that made a big one |
| **Days hit** | share of days that produced at least one good move |
| Verdict | keep / watch / drop |

**Days hit is the column that decides.** A screener whose good moves all landed
on two wild days has a flattering average and is not something anyone can plan
around, so a *keep* needs both a rate and a spread of days.

Each screener is compared against **its own tool's** pooled baseline. Comparing
across tools compares universes — one samples two-dollar small caps, another
samples billion-dollar companies — not screeners.

---

## Order of work

1. **Collect.** Run the tools for about a month. Nothing to decide yet.
2. **Cut.** Read the scorecard. Delete the screeners that do not find movers.
3. **Then setups.** Only for the screeners that survived, work out which entry,
   stop and target suit what they find. That is the question the current
   measurement deliberately does not answer.
