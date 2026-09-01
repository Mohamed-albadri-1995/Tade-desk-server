# CANSLIM, as O'Neil means it

Research and build spec for the market tab and the screener cards.

This document exists because most of these concepts have a plain-English name
that means something *else* in common usage. Implementing the common reading
produces numbers that look right, sit on a card, and are about a different
thing. Every section below therefore leads with **what it is not**.

Sources are IBD's and William O'Neil + Co's own published descriptions, plus
*How to Make Money in Stocks*. Where IBD's published number has **changed over
the years**, both are given and the choice is made explicit rather than hidden
in a constant — see [Thresholds that moved](#thresholds-that-moved).

---

## 1. The traps

| Concept | What it actually is | What it is commonly mistaken for |
|---|---|---|
| **Relative Strength (RS Rating)** | A **percentile, 1–99**, of this stock's 12-month price performance against *every other stock* | **RSI** — a bounded oscillator comparing a stock to **its own** recent range. Says nothing about any other stock. Two names can both print RSI 70 while one leads the market and the other is a laggard bouncing in a downtrend |
| **C** in CAN SLIM | **Current quarter** EPS vs **the same quarter one year ago** | The latest quarter vs the *previous* quarter (sequential). Wrong: it reintroduces the seasonality the year-ago comparison exists to remove |
| **A** in CAN SLIM | **Annual** EPS growth, each year, over 3–5 years, plus ROE | A longer version of C. It is a different question: C is *acceleration now*, A is *durability*. A company can pass C and fail A (one good quarter) or pass A and fail C (a decelerating compounder) |
| **Distribution day** | *One session*: index closes **down ≥0.2%** on **volume higher than the prior session** | Any down day. Volume is the whole point — it is the footprint of institutions selling, not of the index drifting |
| **Distribution day count** | How many are **currently live** in a rolling **25-session** window, with expiry rules | A running total. A count that never expires only rises and is meaningless by March |
| **Accumulation/Distribution Rating** | IBD's **A–E letter** from 13 weeks of daily price/volume | The **Accumulation/Distribution *Index***(Chaikin) — a completely different, unbounded cumulative line. Same words, different object |
| **Follow-through day** | A **confirmation**, on day **4+** of a rally attempt, with a **big gain on higher volume** | Any strong up day. The day count is what separates a real bottom from a dead-cat bounce |
| **N — New high** | Price emerging from a **base** into new high ground, on volume | Any 52-week high. A stock grinding to a high with no base and no volume is the opposite of the setup |
| **Group rank** | Rank of the stock's **industry group** (IBD uses **197**) by 6-month price performance | The GICS **sector** (11 of them). A sector is far too coarse — O'Neil's point is that leadership is a *group* phenomenon |
| **M — Market direction** | A **rule-based state machine** over the indexes | A sentiment read or a moving-average cross. O'Neil's whole claim is that it is mechanical |
| **RS *Line*** | The plotted ratio **stock ÷ index**, over time. Its *shape* is the signal — "RS line at a new high **before** price" is the MarketSmith tell | The **RS Rating**. Different objects: the Rating is today's percentile (a number 1–99), the Line is a curve. A stock can hold RS Rating 95 while its RS line rolls over — the Rating is backward-looking over 12 months, the Line turns first |
| **Up/Down Volume Ratio** | Up-day volume ÷ down-day volume over the last **50 days**. One number, ~1.0 neutral | The Acc/Dis Rating. Both measure institutional demand; U/D is a plain volume ratio over 50 days, Acc/Dis is a graded read of price *and* volume over 13 weeks. They disagree often and that disagreement is informative |
| **Base stage** | Which base this is **counted from the market bottom** — 1st, 2nd, late | Any consolidation. The count is the point: late-stage bases (3rd, 4th) fail far more often because the move is obvious by then |
| **Group rank vs Group RS Rating** | **One fact, two directions.** Rank 63 of 197 *is* the 68th percentile *is* the letter B+ | Three separate measurements. They cannot disagree; building them as three fields invites a card that shows them doing so — see [§9.2](#92-the-precision-point-three-prints-one-fact) |
| **Stock rank *within* its group** | "**RS 1 of 13**" — the stock's RS Rating ranked against **only its own group's members** | The RS Rating itself. A stock can be RS 95 market-wide and 8 of 13 inside its group, i.e. the twelfth-best way to own the same theme. Nothing on our cards shows this today |
| **N — the "new" thing** | **Three** things: new product/service, new management, **or better industry conditions** — >95% of winners had one, *before* the advance | Two things (product + management), and a **news feed**. The third is always dropped, and it is the one we can compute without any news at all — see [§10](#10-n--the-news-algorithm-not-a-news-tab) |

---

## 2. M — the market model

This is the largest gap in the current system. `src/sideD/regime.js` today
scores same-day and 1-week index moves into BULLISH/NEUTRAL/BEARISH. That is a
short-term momentum blend. **It is not O'Neil's market model** and should not
be presented as one. Both can exist; they must be named differently.

O'Neil's model is a **state machine over two indexes** (Nasdaq Composite and
S&P 500), driven by two events.

### 2.1 The three states

IBD publishes these as *The Market Pulse*, with exactly three labels:

| State | Meaning | Exposure implication O'Neil draws |
|---|---|---|
| **Confirmed uptrend** | A follow-through day has confirmed a rally and distribution has not yet accumulated | Buy breakouts |
| **Uptrend under pressure** | Still in an uptrend, but distribution days are stacking up | Stop initiating; tighten |
| **Market in correction** | The uptrend has broken | No new buying |

Between a correction low and a follow-through day, the market is in a **rally
attempt** — a fourth *internal* state, not one of the three published labels.

### 2.2 Distribution day — the exact rule

A session counts as a distribution day when, **on the same index**:

```
close ≤ prior_close × (1 − 0.002)        down 0.2% or more
AND volume > prior_volume                 on higher volume
AND the market is in a confirmed uptrend  (see below)
```

**TWO FORMS, AND THEY DO NOT CONFLICT.** The workshop states this plainly —
*"closes LOWER in price than the prior session while trading volume
increases"* — with no percentage at all. IBD's **0.2%** is the operational
floor on that same rule, and it is there because without it roughly a quarter
of all sessions qualify and the 5–6 cluster fires constantly. The floor is a
named constant: **set it to 0 for O'Neil's plain form.**

**THE WINDOW, likewise.** The workshop gives the cluster as **5–6 days within
5–6 weeks**, which is 25–30 sessions. **25** is the tight end of his own range
and IBD's published figure, so it is the default.

**ONE INDEX IS ENOUGH.** The workshop: *"You only need one major market index
to hit this distribution threshold to shift the market status to a
downtrend."* That is exactly why the published status here is the **worse** of
the S&P 500 and the Nasdaq rather than a blend of the two.

**The uptrend condition matters and is widely dropped.** During a correction or
a rally attempt there is no established uptrend to distribute *from*, so a heavy
down day is not added to the count. A count that ignores this runs up during
every correction and then reads as "extremely dangerous" on the day the bottom
forms — precisely inverted.

Two removal rules, and a day leaves the count when **either** fires:

1. **Age** — it passes out of the trailing **25 sessions**.
2. **Price recovery** — the index **trades ≥5% above** that day's close.

**SETTLED — 5%, and INTRADAY, not on a closing basis.** The rule is that the
index *trades* 5% above the distribution day's closing price, so it fires on
the high, not the close. The first draft here said "closes ≥5% above", which
is a stricter rule than IBD's and would hold days in the count that IBD had
already dropped — the count would read more dangerous than the real one, on
exactly the days a new uptrend is starting.

### 2.2b Stalling days — the form of distribution that is not a down day

**This was missing from the first draft of this document and it is not a
detail.** IBD's distribution count includes a second shape:

```
STALLING (also called churning)
    volume is heavy — above the 25-day average, or above the prior day
    AND the index makes almost no upward progress (gain under ~0.2%)
    AND it closes in the lower half of the day's range
```

The logic is the same as a down day: institutions are selling into strength.
The price does not fall because the selling is being absorbed — which is
exactly what heavy volume with no progress *means*. A count that only looks
for −0.2% closes misses this entirely, and it is the shape that shows up at
tops, where the index grinds sideways on huge volume for a fortnight before
it breaks.

A stalling day is a **distribution day** for counting purposes. It is flagged
separately in the list so the two can be told apart, because they read
differently on a chart.

### 2.3 The count → the state

| Live distribution days | State |
|---|---|
| 0–2 | Confirmed uptrend |
| 3–4 | Confirmed uptrend, worth showing the count |
| **5** | **Uptrend under pressure** |
| **6+** | Typically precedes / accompanies **market in correction** |

The count is not the only route into a correction: a decisive break of the
rally low also ends the uptrend regardless of the count.

**COUNTED PER INDEX, NOT POOLED.** IBD tracks the Nasdaq Composite and the
S&P 500 separately and publishes both counts. They diverge often — that
divergence is information, because it says which half of the market is being
sold. The status is driven by the **worse** of the two. Pooling them into one
number would both double-count a day the two indexes shared and hide the
divergence.

### 2.4 Rally attempt and follow-through day

**CORRECTED FROM THE WORKSHOP (O'Neil, January 2010).** The first version of
this section anchored the count on "the first UP close after the low". That is
a different anchor and therefore a different day number on every signal.

```
The ABSOLUTE MARKET BOTTOM = the LOWEST CLOSING PRICE of this correction
                             cycle. It never means zero — an index cannot
                             reach zero — it means the lowest local close
                             before the recovery begins.

Day 1 = the trading session IMMEDIATELY FOLLOWING that lowest close,
        whether that session is up or down.

Days 1, 2 and normally 3 are ignored ENTIRELY: early bounces off a bottom
fail often enough that the wait is the whole filter.

Follow-through day       = on day 4 or later of that rally attempt:
                             index gains ≥ 1.7%
                             AND volume > prior session's volume
```

**SETTLED — 1.7%, which is O'Neil's own number**, not a figure chosen here.
He published 1% in the early editions, raised it to 1.5% in *How to Make Money
in Stocks*, and to **1.7%** in *The Successful Investor* after program trading
made 1% days ordinary. 1.7% is the last value he set, so it is the default.

**The day window has a far end too**, and the first draft here missed it: the
follow-through is expected on **days 4–7**, occasionally as late as 10–11.
Days 8–11 are flagged **late**, past 11 **very late**.

**Flagged, not refused.** An earlier version of this section said a rally
attempt past day 11 "is not confirmed by it". Enforcing that creates a state
the market cannot leave — an attempt that could never be confirmed sits in
"correction" through an entire advance. The late ones are shown with their day
number and their flag, and the reader decides.

**The volume test is ONE comparison: above the prior session.** An earlier
draft here required volume above the index's own 50-day average as well. That
was this document inventing a rule — it is a stricter variant some people
apply, not the published one, which is *"in higher volume than the previous
session"*.

**It was caught by the first live run, and the cost is worth recording.** With
the extra test in place the model blocked the Nasdaq's August 2026
follow-through, the rally attempt ran to **day 23** unconfirmed, and the model
published **"market in correction"** through a rally the S&P 500 had already
confirmed with a clean day-4 follow-through. A rule stricter than the published
one does not fail safe: it fails to the wrong answer, quietly, and in the
direction of telling you not to buy.

The 50-day comparison is still measured and **reported** beside every
follow-through, so the page can say how heavy the day was. It does not decide
one.

- A follow-through **before day 4** is explicitly *not* one. Bounces in the
  first three days are the norm inside downtrends; the wait is the filter.
**THE RESET IS THE SAME FACT, NOT A SECOND RULE.** A new lower **close** *is* a
new bottom, so the anchor moves there and the count starts again at day 1.

And the anchor is a **close**, not an intraday low. A wick below the previous
low that *closes above it* does not move the bottom and does not restart the
count — the first version reset on the intraday low, which is a different bar
and fired on days the market never actually closed through.

- A follow-through **fails** if the index subsequently undercuts the rally
  low. O'Neil is clear that not every FTD works — roughly a quarter fail —
  but that no major bottom has occurred *without* one. It is a **necessary,
  not sufficient** condition, and the tab should say so.
- The rally attempt **resets** if the low is undercut before an FTD appears.

---

### 2.5 RS — verified against the published formula

The implementation in `chart/relstrength.py` was checked against IBD's
published description and **is correct**:

```
RS = 0.4·(P0/P63) + 0.2·(P0/P126) + 0.2·(P0/P189) + 0.2·(P0/P252)
```

equivalently `2·(P0/P63) + (P0/P126) + (P0/P189) + (P0/P252)`, all over 5 —
63/126/189/252 trading days being 3/6/9/12 months, with the most recent
quarter carrying double weight. Percentile-ranked to 1–99.

Two things decide whether a reconstruction matches IBD's number, and both are
choices this system has already made correctly:

- **The universe.** IBD ranks against all listed US stocks. Ranking against
  the Nasdaq only, or against the S&P 500, produces a different rating for
  the same stock. Ours uses Polygon's grouped-daily endpoint — every US
  ticker for the session — which is the right universe.
- **Adjusted prices.** A 2-for-1 split halves the raw close, and a 12-month
  performance measure on raw prices scores that stock at −50% and rates it 1.
  The strongest names in a bull market are exactly the ones that split.

---

## 3. The card side — what to add

Current cards carry: score, price, change, gap %, rvol, ATR, regime, sector
bias, sector, bias, catalyst, method. All are day-trading fields. Nothing on a
card speaks to CAN SLIM except the membership tag.

Proposed additions, in the order a CAN SLIM reader looks at them:

| Field | O'Neil's letter | Source | Note |
|---|---|---|---|
| `rs` | **L** | **Already built** — `chart/relstrength.py` | Percentile 1–99. Reconstruction, not IBD's number, and named so |
| `epsQtr` | **C** | SEC EDGAR XBRL | % change, current quarter vs **same quarter last year** |
| `epsQtrAccel` | **C** | EDGAR | Is this quarter's growth **faster** than last quarter's? O'Neil weights acceleration heavily |
| `epsAnnual` | **A** | EDGAR | 3-year annual EPS CAGR |
| `roe` | **A** | EDGAR | Net income ÷ shareholders' equity |
| `salesGrowth` | **S**/SMR | EDGAR | Latest quarter revenue vs year-ago quarter |
| `offHigh` | **N** | Price data (have) | % below the 52-week high — a Composite input in its own right |
| `groupRank` | **L**/**I** | Computed from our own universe | Rank of the stock's industry group by 6-month performance. **Not** the 11-sector bias already on the card |
| `accDis` | **I** | Price/volume (have) | A–E from 13 weeks of price/volume. Must not be confused with the Chaikin index |
| `supply` | **S** | Free float × price | Small float = thinner supply = sharper moves |

### 3.1 Free sources, named — and what each one cannot give

| Need | Source | Free | Honest limit |
|---|---|---|---|
| Quarterly & annual EPS, revenue, net income, equity | **SEC EDGAR XBRL** `data.sec.gov/api/xbrl/companyfacts/CIK{...}.json` | Yes, official, **no key** | Needs a descriptive `User-Agent`. Filings land weeks after quarter-end, so a card in May may show a February filing — the as-of date must be on screen |
| CIK ↔ ticker | `www.sec.gov/files/company_tickers.json` | Yes | Refresh monthly |
| **Number of funds owning, by quarter** | **SEC Form 13F quarterly datasets** | Yes, official | Only managers over $100M file, and 45 days after quarter-end. So the count is real but lags a quarter — same lag MarketSmith has |
| Fund / bank / management ownership % | 13F + Forms 3/4/5 | Yes | Management % needs insider forms; more work than the fund count |
| Short interest | **FINRA** short interest files | Yes | Twice monthly, not daily |
| New CEO date | **SEC Form 8-K, Item 5.02** | Yes | Item extraction is text work, not a field lookup |
| Shares outstanding | EDGAR `dei:EntityCommonStockSharesOutstanding` | Yes | Exact |
| **Float** | — | **Partly** | No free feed publishes float directly. It is approximable as shares outstanding minus insider and 5%-holder positions from Forms 4 and SC 13D/G. **This is the one number that will be an estimate, and it will be labelled as one** |
| Index OHLCV for the market model | Already have — Yahoo / Polygon | Yes | Nasdaq Composite, S&P 500 |
| Whole-market percentiles (RS, group rank) | Already have — Polygon grouped daily | Yes | One call per session |

**No paid vendor is required for anything above.** EDGAR is the authoritative
source that the paid vendors resell, and 13F is how "number of funds" is
knowable at all.

## 4. What goes where

### Market tab
1. **The status**, as one of the three published labels, with the count that
   produced it and the rule that fired — never a bare word.
2. **Distribution day list** — the actual dates, per index, each with its
   % move and volume ratio, and when it expires. A count with no rows behind
   it cannot be checked.
3. **Rally attempt / follow-through** — which day of the attempt we are on,
   and, if an FTD fired, its date, gain and volume ratio.
4. **A stated caveat** that ~1 in 4 follow-throughs fail. The tab should not
   read as a signal to size up.
5. Keep the existing short-term momentum read, renamed so it is not mistaken
   for the O'Neil state.

### Cards
A compact CAN SLIM strip: `RS 94 · C +38% · A +27% · Acc B · Grp 12/197 · −4% off high`,
with anything unavailable shown as **unknown, never as zero**. A missing EPS is
not a bad EPS, and a card that prints `C 0%` for a company that has not filed
is worse than one that says nothing.

---

## 5. Thresholds that moved

These are the numbers where honest sources disagree, because **IBD changed
them**. Each is a named constant with both values recorded:

**SETTLED: use O'Neil's own numbers. Nothing here is chosen by us.**

| Rule | **Value in use** | Provenance |
|---|---|---|
| **Follow-through gain** | **1.7%** | O'Neil's last published figure, *The Successful Investor*. He set 1% in the early editions, 1.5% in *How to Make Money in Stocks*, then 1.7% once program trading made 1% days ordinary. The last value he set is the one we use |
| **Follow-through day window** | **Days 4–7**, late to 10–11 | O'Neil. Day 1 is the first up close off the low |
| **Follow-through volume** | **> prior session** — that is the whole test | IBD: *"in higher volume than the previous session"*. An earlier draft also demanded > the 50-day average; that was invented here, and the first live run showed what it cost — see §2.4 |
| **Follow-through day window** | days 4–7, **flagged** late to 11 and beyond | Flagged, never refused: a rally attempt that can never be confirmed is a state the market cannot leave |
| **Distribution recovery removal** | **5%, intraday** | IBD: the index *trades* 5% above that day's close. On the high, not the close |
| Distribution window | **25 sessions** | Consistent everywhere |
| Distribution day trigger | **−0.2%** on higher volume | Consistent everywhere |
| Stalling day | heavy volume, gain <0.2%, close in lower half | IBD, §2.2b |
| RS weighting | 40/20/20/20 over 3/6/9/12 months | O'Neil's published formula, §2.5 |
| CANSLIM membership hold | **90 days** | Ours — this one is a system decision, not O'Neil's, and is marked as such |

The earlier draft of this section recommended 1.2% and a *closing* 5%. Both
were this document choosing between sources rather than following O'Neil, and
both are replaced above.

Each is still a **named constant, printed next to any signal that fires**. A
follow-through day is a claim about the market; a claim whose definition is
invisible cannot be checked against a chart afterwards. Configurable, but the
default is O'Neil's and changing it is a decision somebody has to make on
purpose.

---

## 6. What this deliberately does not do

- **It does not reproduce IBD's ratings.** EPS Rating, Composite and
  Accumulation/Distribution are commercial products with unpublished
  universes and weights. What is built here is a *reconstruction from the
  published description*, and it is named so — `rs`, not "IBD RS". A number
  that looked like IBD's and was not would be worse than no number.
- **It does not gate any screener.** Like the existing CANSLIM membership
  tag, these are labels. No tool's candidate list changes because of them.
- **It does not replace the day-trading fields.** CAN SLIM is a
  position-trading framework; the desk trades intraday setups. These fields
  are context, not entries.


---

## 7. The card — exact spec (v2, from the MarketSmith panels)

**Replaces the one-line version.** The first draft compressed CAN SLIM into a
single strip. That was wrong: C and A are *series*, and a single percentage
throws away the shape — which is the part O'Neil reads. These are tables.

Two levels: a **row** in the list, and a **panel** on tap.

### 7.1 The row — what MarketSmith puts in its screen results

```
BGFV  Big 5 Sporting Corp                              Comp 96
      EPS 76 · RS 99 · Grp B+ · SMR B · A/D B+
      vol 1,737k  vs 50-day 1,044k  (+66%)
```

Six ratings, the same six MarketSmith's list view carries, plus volume against
its own 50-day average — which is what MarketSmith means by `Volume +9%` and
is the same quantity as the `rvol` already on our cards.

### 7.2 The panel — C, as a table

Eight quarters. `%Chg` is always against **the same quarter one year earlier**.

| Qtr | EPS $ | %Chg | Sales $M | %Chg | Margin |
|---|---|---|---|---|---|
| Jun-19 | −0.03 | n/a | 241.0 | 0% | |
| Sep-19 | 0.30 | +100% | 266.2 | 0% | |
| Dec-19 | 0.05 | +121% | 244.1 | −1% | |
| Mar-20 | −0.22 | n/a | 217.7 | −11% | −2.1% |
| Jun-20 | 0.39 | +999% | 227.9 | −5% | +3.7% |
| Sep-20 | 1.31 | +337% | 305.0 | +15% | +9.3% |
| Dec-20 | 0.83 | +999% | 290.6 | +19% | +6.3% |

Conventions taken from MarketSmith and kept:

- **`n/a`, not a number, when the year-ago quarter was a loss.** A percentage
  change from a negative base is arithmetic without meaning. MarketSmith
  prints `N/A`; so do we.
- **Capped at +999%.** Beyond that the number is noise; the point has been
  made.
- **Sales beside EPS, always.** O'Neil's warning is earnings growth without
  sales growth — margin games, buybacks, one-offs. The pair is the check.
- **After-tax margin**, because rising margin *and* rising sales is the
  combination he wants.

Derived and shown beside the table:
- **Accelerating?** Is each of the last 2–3 quarters' `%Chg` larger than the
  one before? O'Neil weights acceleration heavily and it is invisible in any
  single number.
- **How many of the last 8 quarters beat +25%.**

### 7.3 The panel — A, as a table

| FY | EPS $ | %Chg | Price high | Price low |
|---|---|---|---|---|
| 2015 | 0.77 | | 20 | 9 |
| 2016 | 0.78 | +1% | 15 | 8 |
| … | | | | |
| 2021 | 1.74 est. | −25% | | |

Plus the three numbers MarketSmith puts beside it:
- **3-year EPS growth rate** (its `EPS Growth Rate`)
- **Earnings Stability** — a 0-99 measure of how much the earnings series
  *wobbles* around its trend. Low is good. O'Neil wants a straight line, not
  an average that happens to be high
- **Return on Equity** — his 17% floor

The price high/low column is there for a reason: it puts the earnings series
next to what the stock did, which is the whole CAN SLIM claim.

### 7.4 The panel — I, with the history you asked for

MarketSmith's *Fund Ownership Summary* is a count of funds, by quarter:

| Quarter | No. of funds |
|---|---|
| Mar-19 | 311 |
| Jun-19 | 301 |
| Sep-19 | 302 |
| Dec-19 | 302 |
| Mar-20 | 313 |
| Jun-20 | 333 |
| Sep-20 | 417 |
| Dec-20 | 425 |

**The trend is the signal, not the level.** 311→425 over four quarters is
institutions accumulating; a flat or falling count is the opposite, and the
level alone tells you neither.

**This is obtainable, free and official: SEC Form 13F.** Every institutional
manager over $100M files a 13F each quarter listing its US equity holdings,
and the SEC publishes them as structured quarterly datasets. Counting the
distinct filers holding a ticker in each quarter *is* this table. It is the
same source the paid vendors use.

Beside it, from the same filings: **Funds %**, **Banks %**, **Management %**.

### 7.5 The panel — L, the group

From MarketSmith's Industry & Sector panel:

```
Industry group      Retail-Leisure Products      rank 63 of 197
Stocks in group     13
New highs / lows    4 / 0
This stock ranks    RS 1 of 13 · EPS 7 of 13 · A/D 4 of 13 · Comp 5 of 13
Top RS in group     BGFV 99 · HIBB 97 · HZO 96 · ONEW 96 · SPWH 82
```

Two separate facts, and both matter: **is the group strong**, and **is this
stock the leader within it**. O'Neil buys the #1 or #2 name in a top group,
not the cheapest name in it. The rank-within-group line is what makes that
checkable, and nothing on our cards says it today.

### 7.6 The panel — S, supply

```
Shares outstanding  21.9 Mil
Float               21.3 Mil
Short interest      1.2 days, −21%
```

### 7.7 N — how, since you asked

**N is four different things under one letter**, and only some are computable:

| N | Computable? | How |
|---|---|---|
| New **price high** | Yes | At/near a 52-week high — but the O'Neil meaning is *emerging from a base*, which needs base detection (phase 2) |
| New **management** | Yes, roughly | MarketSmith shows `New CEO 02/2021`. Source: SEC **Form 8-K Item 5.02**, which is filed for exactly this |
| New **product** | ~~No~~ **Yes** | Superseded — openFDA, 8-K Items 8.01/7.01/1.01 and USASpending are all free and dated. See [§10](#10-n--the-news-algorithm-not-a-news-tab) |
| New **industry conditions** | Partly | The group's rank *rising* is the measurable trace |

~~Proposal: show % off 52-week high and New CEO date now; leave "new product"
to the existing catalyst.~~ **Superseded by [§10](#10-n--the-news-algorithm-not-a-news-tab)**, which
makes all four computable through one scored pipeline. The "no" above was
wrong: it assumed news had to come from a news feed. It comes from EDGAR.

---

## 8. The market tab

**The existing tab is kept.** Its short-term index/sector read is useful and is
not being replaced — it is renamed so it cannot be mistaken for the O'Neil
state, and the O'Neil model is **added beside it** as its own block:

```
O'NEIL MARKET MODEL
  Status        Uptrend under pressure
  Because       5 distribution days live (>=5 is the threshold)
  Nasdaq        4 live      S&P 500   5 live
  Rally         n/a - in a confirmed uptrend since the FTD of 2026-07-18
  Rules in use  DD -0.2% on higher volume - 25 sessions - 5% intraday recovery
                FTD +1.7% on day 4-7, volume over the prior session

  DISTRIBUTION DAYS
  2026-08-27  S&P 500  -0.7%  vol x1.14   expires 2026-10-01
  2026-08-21  Nasdaq   -1.1%  vol x1.31   expires 2026-09-25
  ...
```

Every number carries the rule that produced it, and the distribution days are
listed with their dates so the count can be checked against a chart. A status
word with no rows behind it is not checkable, and this is a claim about when to
stop buying.

**A stated caveat sits under the follow-through line**: roughly one in four
follow-through days fails. It is a necessary condition for a bottom, not a
sufficient one, and the tab must not read as permission to size up.

---

## 9. Strength — market, sector, group, stock

You asked to check strength across the levels. There are **four**, not three,
and each is computed by a *different* method. Treating them as one thing —
"relative strength" — is the mistake this section exists to prevent.

O'Neil's own numbers for why the middle two matter, from *How to Make Money in
Stocks*: **37%** of a stock's price move is attributed to its **industry
group**, another **12%** to its **sector**. Roughly half the move is not about
the company. That is the whole reason the group level exists on the card.

### 9.1 The four levels, and how each is computed

| Level | The number | How it is computed | What it answers |
|---|---|---|---|
| **Market** | The O'Neil state (§2) + the index **RS line** | State machine over distribution days / rally attempt / FTD. The RS line is `index ÷ S&P 500` plotted | Should I be buying at all |
| **Sector** | Rank **1–33** | IBD's 33 sectors, ranked by aggregate price performance | Is the money in this half of the market — a coarse read |
| **Group** | Rank **1–197** | Least-squares curve fit on **summed member prices**, separate weightings per time period, ~**6-month** frame, cap-weighted | Is *this* the leading group. This is O'Neil's real level |
| **Stock in group** | "**RS 1 of 13**" | The stock's RS Rating ranked against only the members of its own group | Am I buying the leader or the laggard |

The last row is the one nothing in our system shows today, and it is the one
O'Neil is strictest about: buy the **#1 or #2** name in a top group, never the
cheap laggard in it. A stock can carry RS Rating 95 — top 5% of the whole
market — and still be **8 of 13** inside its own group, which means twelve
better expressions of the same theme are on the screen next to it.

### 9.2 The precision point: three prints, one fact

From the MarketSmith panels, the same group appears as:

```
Industry 197 Rank    63          (rank, 1 = best, out of 197)
Group RS Rating      68          (percentile, 99 = best)
Group RS             B+          (letter band of that percentile)
```

These are **not three measurements**. `1 − 63/197 = 68%` — rank 63 of 197 *is*
the 68th percentile, and B+ is that percentile in letter form. Building three
separate fields would imply three independent reads and invite the card to
show them disagreeing when they cannot.

**Decision:** compute the rank, derive the other two. Store one number.

### 9.3 Direction of the rank matters, and the two are opposite

- **Rank**: 1 is best, 197 is worst. Lower is stronger.
- **Rating / percentile**: 99 is best, 1 is worst. Higher is stronger.

Every place a group number is printed must carry its scale, because a bare
"68" is excellent as a rating and mediocre as a rank. The cards will print
`63 of 197` — never a bare rank — for exactly this reason.

### 9.4 The divisor is not permanent

IBD **restructured the group list from 197 to 145**. Any code that hardcodes
197, and any stored history that does not record which scheme it was computed
under, silently rewrites its own past when the divisor changes. So:

- the divisor is **stored with the value**, not assumed;
- the card prints `63 of 197`, never `rank 63`;
- historical group ranks keep the divisor they were computed with, and a
  chart that spans the change says so rather than splicing two scales.

### 9.5 What we can actually build from free data

IBD's exact group definitions are proprietary — the 197-way split, and the
"certain stocks within that industry" the curve fit runs on, are not
published. What is reproducible:

| Piece | Free? | How |
|---|---|---|
| Sector membership | Yes | Already in our data (`sector` on every card) |
| Group membership | **Approximated** | SIC code (EDGAR, free, on every filer) or the finer industry field from the data provider. Finer than sector, coarser than IBD's 197 |
| Group strength rank | Yes | Rank our own groups by 6-month cap-weighted member performance — the same *method*, our own membership |
| Stock rank within group | Yes | Rank each member's RS Rating inside its group. **This is exact** — it needs only membership and our existing RS |
| Index RS line | Yes | `index ÷ S&P 500`, both already fetched |

**The honest limit, stated on the card:** our group rank is *our* group rank,
not IBD's, because the membership differs. The rank **within** the group and
the number of members are exact given whatever membership we use, and those
are the two facts O'Neil actually trades on. A card that showed "Group rank
63 of 197" while using a different group definition would be claiming IBD's
number; it will print the divisor we actually used.

### 9.6 The index RS line

On a MarketSmith index chart the blue line on the Nasdaq Composite is the
**Nasdaq's RS versus the S&P 500**, with the S&P 500 itself drawn behind it in
black. Same construction as a stock's RS line, one level up: it says which
index is leading, which is the earliest read on whether growth or defensives
are being bought. It belongs on the **market tab**, not the cards.

---

## 10. N — the news algorithm (not a news tab)

You are right that N ends up being news, and right that a normal news tab is
the wrong shape for it. This section is the algorithm.

### 10.1 What N actually is — and it is three things, not two

O'Neil studied the greatest winners 1953–1993 and found **more than 95%** had,
before their big advance, one of:

1. a major **new product or service**
2. **new management**
3. an important **change for the better in the conditions of their industry**

The third is the one everybody drops, and we already compute it — a group
climbing the rank in §9 *is* the measurable trace of changed industry
conditions. It needs no news feed at all.

The fourth sense of "N", **new high**, is price and is already on the chart. It
is the *confirmation*, not the cause.

### 10.2 Why the check period must be long — the core point

A news tab looks back **hours**. N must look back **24 months**.

The reason is O'Neil's own sequence: **the new thing comes first, the price
move comes after.** A CEO who arrived nine months ago can still be the entire
reason the stock is breaking out today. A tab that shows the last 24 hours can
never see that, and will instead show an analyst note from this morning that
means nothing.

So: **lookback 24 months, with decay, not a cutoff.**

| Age of the event | Weight | Why |
|---|---|---|
| 0–3 months | 1.0 | Fresh, and the move may be starting |
| 3–6 months | 0.9 | O'Neil's sweet spot — old enough to be proven, young enough to still be running |
| 6–12 months | 0.7 | Still the reason, but the obvious money is made |
| 12–24 months | 0.4 | Fading into "the old story" |
| >24 months | 0 | Dropped |

Note the shape: 3–6 months is **not** penalised versus today. A same-day
headline has no price reaction yet, so it cannot be confirmed — it enters the
card marked **unconfirmed**, not scored.

### 10.3 The pipeline

```
HARVEST  ->  CLASSIFY  ->  REACT  ->  PERSIST  ->  SCORE  ->  one line
(24 mo)      (3 buckets)   (price)   (RS line)    (0-100)    on the card
```

**The step that makes this not a news tab is REACT.** An event with no
price-and-volume response *at the time it happened* is discarded. That is
O'Neil's discipline applied to news: the story is only real if institutions
acted on it. A new CEO announced into silence is not N.

### 10.4 HARVEST — the sources, all free

| Bucket | Source | Free | What it gives |
|---|---|---|---|
| New management | **EDGAR 8-K Item 5.02** | Yes | *Structured.* The item code IS the classifier — mandatory, dated, no NLP needed. Highest precision source in the whole spec |
| New product | **openFDA** (drug approvals, device 510(k)/PMA) | Yes | A literal dated new product, for pharma/device names |
| New product | **EDGAR 8-K Item 8.01 / 7.01** | Yes | "Other events" / Reg FD — where product launches are announced |
| New contract | **EDGAR 8-K Item 1.01** | Yes | Material definitive agreement — a large new contract is a new revenue source |
| New contract | **USASpending.gov** | Yes | Government contract awards, dated, with the dollar amount |
| New industry conditions | **our own group rank** (§9) | Yes | Computed. Rank rising 3 months = the trace |
| Corroboration only | Finnhub / press-release RSS | Yes | Never the trigger — used to confirm and to supply the headline text |

EDGAR is the spine because it is **structured, dated, mandatory and free**.
News APIs are the corroboration layer, never the source of truth: a filing
happened, a headline was written.

### 10.5 CLASSIFY — and what must be thrown away

Everything not in the three buckets is discarded. Named explicitly, because
these are exactly the items that make a news tab feel busy and mean nothing:

| Rejected | Why |
|---|---|
| Analyst upgrades / downgrades / price targets | Nothing is new **at the company**. This is opinion about the same facts |
| Index inclusion / rebalancing | Mechanical flow, not a business change |
| Earnings releases | That is **C and A**. Counting it in N double-counts the same fact |
| Splits, buybacks, dividends | Financial engineering, not a new product |
| Lawsuits, short-seller reports | News, but not the O'Neil sense of new |
| **Secondary offerings / dilution** | This is real and it belongs in **S** — supply going *up*. Routed there, not to N |

### 10.6 REACT and PERSIST — the two price tests

**REACT**, measured on the event date + 2 sessions:

```
gap/move  in multiples of the stock's own 20-day ATR
volume    vs its own 50-day average
```

`R` is 0 when the move is inside one ATR on normal volume — and an event with
`R = 0` is **dropped**, not shown small. This alone removes most of what a news
tab would print.

**PERSIST**, measured today against the event date:

```
RS line higher than on the event day    P = 1.0
flat                                     P = 0.5
lower                                    P = 0.2
```

A catalyst the market has since given back is not the reason to buy today.

### 10.7 SCORE

```
N_event = W(class) x R(reaction) x D(age) x P(persistence)
N       = max over events, scaled 0-100
```

Class weights, in O'Neil's own order of importance:

| Class | W |
|---|---|
| New product / service | 1.00 |
| New management (CEO / President) | 0.90 |
| New material contract | 0.80 |
| New industry conditions (group rank rising) | 0.70 |
| New high with no other N | 0.40 |

**Dedupe** by `(class, date +/- 3 sessions)` — one event reaches us as an 8-K
and as five headlines, and counting it six times would make the noisiest story
the highest score.

### 10.8 How it presents on the card

One line, and a panel behind it:

```
N  86   New CEO - 2026-03-12 (5.8 mo) - +11.4% on 4.2x vol - RS line held
```

```
N - WHAT IS NEW                                        score 86
  2026-03-12  New management   8-K 5.02  +11.4%  4.2x vol  held    86
  2026-06-01  New product      FDA 510(k) +6.2%  2.1x vol  held    61
  2026-05..08 Industry cond.   group 141 -> 28   -         -       44
  ---
  unconfirmed (too new to score)
  2026-08-31  Contract         8-K 1.01  filed yesterday
  ---
  discarded: 34 items (no price reaction), 11 (wrong class)
```

The discarded count is printed on purpose. It is the evidence that the number
is a filter and not a feed.

### 10.9 The difference, stated

| A normal news tab | The N algorithm |
|---|---|
| Sorted by **time** | Sorted by **score** |
| Recent = important | A 9-month-old event can outrank this morning's |
| Every headline | Three buckets; everything else named and dropped |
| No link to price | No price-and-volume reaction, no entry |
| Window: hours | Window: **24 months** |
| You read it | It emits **one number and one dated line** |
| Duplicates across outlets | Deduped to the underlying event |

---

## 11. Fitting it on the existing tools

Everything above is what to compute. This is where each piece lands in the
system that already exists, and — as important — what it must not touch.

### 11.1 The rule that governs all of it

`src/sideA/canslim.js` already states the contract this system runs on, and it
is the right one:

> It is a **LABEL, never a filter.** No tool's results change because of it.
> Reading it cannot alter which stocks a screener returns.

**Everything in this document obeys that.** Not one number here enters a
score, a filter, or a rank. The reason is not tidiness: T1–T9 are nine
independent experiments whose backtests are compared against each other. The
moment an O'Neil number changes what a screener returns, every card captured
before that change is measuring a different thing, and the comparison — the
entire point of running nine tools — is gone.

So: **added to the card, never to the query.**

### 11.2 Compute once, read nine times

The market model is one fact about the market. Group ranks are one ranking of
one universe. Computing either inside each of nine tools is nine chances to
disagree, on nine different Polygon page loads.

The pattern already exists and works — `data/canslim-members.json`, written by
T8, read by everyone, one-way, and a reader that cannot parse it carries on
with no tags rather than failing a scan. Three more files, same rules:

| File | Written by | Contains | Refresh |
|---|---|---|---|
| `data/oneil-market.json` | **qp** | status, live distribution days per index with dates, rally-attempt state, last FTD, thresholds used | after each close, and intraday on demand |
| `data/oneil-groups.json` | **qp** | every group: rank, divisor, member count, member RS ranks | after each close |
| `data/oneil/<TICKER>.json` | nightly job | C table, A table, I history, S, N events | per field, see 11.5 |

**Why qp is the writer.** It already has what this needs and the nine tools do
not: Polygon grouped-daily for the whole US universe, the parquet bar cache,
and `chart/relstrength.py` — which §2.5 verified is already computing O'Neil's
RS formula correctly, on the right universe, on adjusted prices. Rebuilding
that in Node would be a second implementation of a formula we have already
checked once.

**Failure is silence.** Every reader falls back to "no O'Neil data" and
renders the card exactly as it renders today. The market model being stale
must never be able to stop a scan.

### 11.3 The card — the row, and the panel behind it

**Correction to this section's first draft.** It reduced §7 to a badge reading
`C92 A88 N86` and put "the tables" behind the existing Details fold. That
contradicts §7, which exists *because* a single percentage throws away the
shape O'Neil actually reads. A screener card column is 300–400px wide; an
eight-quarter table with EPS, %Chg, Sales, %Chg and Margin does not fit in it
and never will. Squeezing it in there is how the tables would have quietly
become one number again.

So the split is the one §7 already stated — **a row, and a panel** — and the
panel is a real full-width surface, not a fold inside a card.

#### On the card, always visible — the §7.1 row

Two lines, under the ticker line, above Volume & Float:

```
Comp 96    EPS 76 · RS 99 · Grp B+ · SMR B · A/D B+
           vol 1,737k vs 50-day 1,044k (+66%)  ·  grp 63/197 · RS 1 of 13
```

The same six ratings MarketSmith's list view carries, plus volume against its
own 50-day average, plus the two group facts from §9. Tapping it opens the
panel. This is what most mornings need and it is a block, not a badge.

#### The News section leads with N

```
News · N 86
▸ New CEO · 2026-03-12 (5.8 mo) · +11.4% on 4.2x vol · RS line held
---- recent headlines (3 weeks), unchanged ----
```

The existing headline list stays exactly as it is, three-week window and all.
The scored 24-month answer sits **above** it. Two different objects in one
place, which is where they belong: what is new about this company, and what
was said about it this week. The full N table (§10.8) is in the panel.

#### The CANSLIM panel — where the tables actually live

Opened from the row. Full width, its own scroll, seven blocks in O'Neil's own
letter order so the panel reads as the method rather than as a data dump. The
mechanism already exists on this page — `openChart()`, `toggleScoreBreakdown()`
and `openTableInspector()` all open full surfaces from a card.

```
┌─ BGFV · Big 5 Sporting Corp ─────────────────── Comp 96 ─┐
│  EPS 76 · RS 99 · Grp B+ · SMR B · A/D B+                │
├──────────────────────────────────────────────────────────┤
│  C — CURRENT QUARTERLY EARNINGS            §7.2          │
│  8 quarters. Qtr | EPS $ | %Chg | Sales $M | %Chg | Marg │
│  %Chg always vs the SAME quarter a year earlier.         │
│  n/a on a loss base. Capped +999%.                       │
│  Accelerating: yes (3 of 3)   ·   Beat +25%: 5 of 8      │
├──────────────────────────────────────────────────────────┤
│  A — ANNUAL EARNINGS                       §7.3          │
│  FY | EPS $ | %Chg | Price high | Price low   (3-5 yrs)  │
│  3-yr EPS growth 34%  ·  Stability 12  ·  ROE 21%        │
│  ROE floor 17%: PASS                                     │
├──────────────────────────────────────────────────────────┤
│  N — WHAT IS NEW                           §10.8         │
│  date | class | source | reaction | persisted | score    │
│  unconfirmed (too new to score) listed separately        │
│  discarded: 34 no reaction, 11 wrong class               │
├──────────────────────────────────────────────────────────┤
│  S — SUPPLY                                §7.6          │
│  Shares out 21.9M · Float 21.3M · Short 1.2 days, -21%   │
│  U/D volume ratio 1.41 (50d)                             │
├──────────────────────────────────────────────────────────┤
│  L — LEADER OR LAGGARD                     §7.5, §9      │
│  Group Retail-Leisure Products     rank 63 of 197        │
│  Stocks in group 13   ·   New highs/lows 4 / 0           │
│  THIS STOCK   RS 1 of 13 · EPS 7 of 13 · A/D 4 of 13     │
│  Top RS in group  BGFV 99 · HIBB 97 · HZO 96 · ONEW 96   │
│  RS line: new high 2026-08-14, BEFORE price              │
├──────────────────────────────────────────────────────────┤
│  I — INSTITUTIONAL SPONSORSHIP             §7.4          │
│  Quarter | No. of funds     (8 quarters, from 13F)       │
│  311 → 425 over 4 quarters — the TREND is the signal     │
│  Funds 42% · Banks 9% · Management 14%                   │
├──────────────────────────────────────────────────────────┤
│  M — MARKET DIRECTION                      §2, §8        │
│  Uptrend under pressure · 5 distribution days live       │
│  (the one shared fact — same object the market tab shows)│
├──────────────────────────────────────────────────────────┤
│  Sources & dates: EDGAR 2026-08-30 · 13F Q2-26 ·         │
│  FINRA 2026-08-15 · groups 2026-08-31 close              │
└──────────────────────────────────────────────────────────┘
```

**Why letter order and not importance order.** The panel is the method, and
the method is the mnemonic. Somebody checking a name works down the letters;
a panel sorted by our idea of importance makes them hunt for A.

**Every block carries its own as-of date**, because they refresh on completely
different clocks — 13F is quarterly and 45 days late by law, FINRA is twice a
month, groups are daily. A panel with one timestamp at the top would be
claiming a freshness five of the seven blocks do not have.

**Market Context gains one line**: the O'Neil status, beside the existing
Regime/Long/Mid/Short rows, labelled so it cannot be read as the same claim.

Nothing is removed. Nothing that is on the card today moves.

### 11.4 The market tab — added beside, not over

`#tab-market` today is `#idx-grid` → `#market-analysis` (short/mid/long) →
`#regime-card` (Final Regime) → the sector heatmap. Per your instruction, none
of that is touched. Two additions:

- **`#oneil-model`, inserted above `#market-analysis`.** The block from §8:
  status, why, live counts per index, the rules in use, and the dated
  distribution-day table. It goes first because it is the one that decides
  whether to buy at all; the existing short/mid/long read is the finer texture
  underneath it.
- **A group table under the sector heatmap.** The heatmap is 15 sector ETFs —
  the coarse level. §9 is that leadership is a *group* phenomenon, so the top
  20 and bottom 10 groups by our own rank go below it, each with its divisor
  and its member count. Same table styling, one level finer.

The existing "Final Regime" card keeps its logic and gets its title qualified
so it cannot be mistaken for the O'Neil state — two market reads on one page
that use the same words would be worse than only having one.

### 11.5 The nightly job, and why it cannot be in the request path

EDGAR is an HTTP fetch per company, rate-limited, and it must send a real
User-Agent. openFDA and USASpending are the same shape. None of it can happen
while a card is rendering.

So a **nightly job** walks the union of every tool's registry plus the CANSLIM
list, and fills `data/oneil/<TICKER>.json`. Refresh rates follow how often the
underlying fact can actually change:

| Field | Source | Refresh |
|---|---|---|
| C, A | EDGAR XBRL company facts | weekly, and on a new 10-Q/10-K |
| I — fund count history | Form 13F | quarterly, after the 45-day filing deadline |
| S — float, shares out | EDGAR cover page | monthly |
| S — short interest | FINRA | twice monthly, on FINRA's own settlement calendar |
| N — events | 8-K, openFDA, USASpending | nightly, 24-month window |
| RS, group rank, RS-in-group | qp / Polygon | after each close |

A card that finds no file says **"not fetched yet"**, with the date it was
last tried. It never blocks, and it never renders a blank that could be read
as a zero.

### 11.6 The order to build it

1. **M — the market model in qp.** Distribution days including stalling,
   rally attempt, follow-through on O'Neil's settled numbers, three statuses,
   written to `data/oneil-market.json`. It is self-contained, it needs only
   index bars we already have, and it is the piece that changes behaviour on
   the most mornings.
2. **The market tab block.** Renders (1). Nothing else depends on it, and it
   is where the work becomes visible to you soonest.
3. **Groups and RS-in-group.** Built on `relstrength.py`, which already
   works. Gives the card its `grp 12/197` and `RS 1 of 13`, and the market tab
   its group table.
4. **The card badge line.** Renders (3) plus the RS already computed.
5. **EDGAR — C and A tables.** The largest piece, and the one whose tables you
   specified in §7.2 and §7.3.
6. **13F — the I history.**
7. **The N pipeline.** Last, because it is the only one that depends on
   several sources at once and on the price-reaction test.

### 11.7 The five things that must not happen

1. **No O'Neil number enters a score, filter or rank.** §11.1. This is the one
   that would quietly destroy the comparison between the nine tools.
2. **No network call in a card render.** Everything on a card comes from a
   file that a scheduled job wrote.
3. **Group ranks are not recomputed per tool.** One universe, one ranking,
   one writer.
4. **The existing three-week news window does not change.** The N pipeline is
   a separate object with a 24-month window. Widening the headline list to two
   years would turn the card's News section into an archive.
5. **The market tab's existing blocks are not rewritten.** Added beside, and
   the O'Neil state is labelled so the page never shows two market reads that
   use the same words for different claims.

---

## 12. The manifest — everything promised, and where each piece lands

You asked me to check everything I said, because §11 first shrank §7 into a
badge. This section is the audit: **every element promised anywhere in this
document**, its home, its source, and its build phase. If something is
described above and is not in this table, it was dropped and that is a bug in
the document.

Legend for **Home**: `ROW` = always visible on the screener card · `PANEL` =
the CANSLIM panel (§11.3) · `NEWS` = the card's existing News section ·
`CTX` = the card's Market Context rows · `MKT` = the market tab.

### 12.1 M — market direction

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| M1 | Distribution day: close −0.2%+ on higher volume, **only in a confirmed uptrend** | MKT | Index bars | §2.2 | 1 |
| M2 | **Stalling day** — heavy volume, gain <0.2%, close in lower half | MKT | Index bars | §2.2b | 1 |
| M3 | Live count per index, 25-session window | MKT | derived | §2.3 | 1 |
| M4 | Removal by age (25 sessions) **and by 5% intraday recovery** | MKT | derived | §2.2 | 1 |
| M5 | The three statuses: confirmed uptrend / under pressure / correction | MKT + CTX | derived | §2.1, §2.3 | 1 |
| M6 | Rally attempt — the internal 4th state, day 1 = first up close off the low | MKT | derived | §2.4 | 1 |
| M7 | **Follow-through day** — +1.7%, day 4+, volume **> the prior session** (the whole test). Days 8–11 flagged late, beyond that very late — flagged, never refused | MKT | derived | §2.4, §5 | 1 |
| M6b | **The anchor** — the lowest **CLOSE** of the correction; day 1 is the session after it; a new lower close moves it and restarts the count | MKT | derived | §15.1 | 1 |
| M8 | FTD failure caveat — ~1 in 4 fail; necessary, not sufficient | MKT | text | §2.4 | 1 |
| M9 | **Dated distribution-day table** — every live day with date, index, %, vol ratio, expiry | MKT | derived | §8 | 1 |
| M10 | **Rules-in-use line** printed beside any signal that fires | MKT | constants | §5, §8 | 1 |
| M11 | Index **RS line** — index ÷ S&P 500 | MKT | Index bars | §9.6 | 2 |
| M12 | Existing Final Regime kept, title qualified so two market reads never share words | MKT | existing | §11.4 | 2 |

### 12.2 The row — §7.1, always visible on the card

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| R1 | **Composite** rating | ROW | derived | §7.1, §6 | 4 |
| R2 | **EPS** rating | ROW | EDGAR | §7.1 | 5 |
| R3 | **RS** rating 1–99 | ROW | `relstrength.py` | §2.5 | 3 |
| R4 | **Grp** RS — letter form of the group percentile | ROW | groups file | §9.2 | 3 |
| R5 | **SMR** — sales/margin/ROE | ROW | EDGAR | §7.1 | 5 |
| R6 | **A/D** rating A–E, 13 weeks price+volume | ROW | bars | §1, §7.1 | 4 |
| R7 | Volume vs its own 50-day average | ROW | bars | §7.1 | 3 |
| R8 | `grp 63 of 197` — **always with the divisor** | ROW | groups file | §9.3, §9.4 | 3 |
| R9 | `RS 1 of 13` — rank inside its own group | ROW | groups file | §9.1 | 3 |
| R10 | Existing `★ CANSLIM 47d` membership badge — unchanged | ROW | existing | — | — |

### 12.3 C — current quarterly earnings, §7.2

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| C1 | **8-quarter table**: Qtr, EPS $, %Chg, Sales $M, %Chg, Margin | PANEL | EDGAR XBRL | §7.2 | 5 |
| C2 | %Chg always against the **same quarter one year earlier** | PANEL | derived | §1, §7.2 | 5 |
| C3 | `n/a` when the year-ago quarter was a **loss** — never a percentage off a negative base | PANEL | derived | §7.2 | 5 |
| C4 | Capped at **+999%** | PANEL | derived | §7.2 | 5 |
| C5 | **Sales beside EPS, always** — earnings growth without sales growth is the warning | PANEL | EDGAR | §7.2 | 5 |
| C6 | After-tax **margin** column | PANEL | EDGAR | §7.2 | 5 |
| C7 | **Accelerating?** — each of the last 2–3 quarters' %Chg larger than the one before | PANEL | derived | §7.2 | 5 |
| C8 | How many of the last 8 quarters beat **+25%** | PANEL | derived | §7.2 | 5 |

### 12.4 A — annual earnings, §7.3

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| A1 | **FY table**: FY, EPS $, %Chg, Price high, Price low — 3–5 years | PANEL | EDGAR + bars | §7.3 | 5 |
| A2 | Price high/low column, so the earnings series sits next to what the stock did | PANEL | bars | §7.3 | 5 |
| A3 | **3-year EPS growth rate** | PANEL | derived | §7.3 | 5 |
| A4 | **Earnings Stability** 0–99 — the wobble around trend, low is good | PANEL | derived | §7.3 | 5 |
| A5 | **ROE**, against O'Neil's **17% floor**, pass/fail shown | PANEL | EDGAR | §7.3 | 5 |
| A6 | Estimates marked `est.` and never mixed with reported | PANEL | EDGAR | §7.3 | 5 |

### 12.5 N — what is new, §10

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| N1 | **Scored N line** at the top of the News section | NEWS | pipeline | §10.8 | 7 |
| N2 | **Event table**: date, class, source, reaction, persisted, score | PANEL | pipeline | §10.8 | 7 |
| N3 | **24-month** lookback with decay 1.0 / 0.9 / 0.7 / 0.4 | PANEL | — | §10.2 | 7 |
| N4 | **Unconfirmed** list — too new to have a price reaction | PANEL | pipeline | §10.2 | 7 |
| N5 | **Discarded counts** printed — the proof it is a filter, not a feed | PANEL | pipeline | §10.8 | 7 |
| N6 | New management — **8-K Item 5.02** | PANEL | EDGAR | §10.4 | 7 |
| N7 | New product — **openFDA** approvals, 510(k)/PMA | PANEL | openFDA | §10.4 | 7 |
| N8 | New product — 8-K Items **8.01 / 7.01** | PANEL | EDGAR | §10.4 | 7 |
| N9 | New contract — 8-K **1.01**, USASpending awards | PANEL | EDGAR, USASpending | §10.4 | 7 |
| N10 | New industry conditions — **our group rank rising** | PANEL | groups file | §10.1, §9 | 3 |
| N11 | **REACT** test — no move beyond 1 ATR on normal volume ⇒ dropped | PANEL | bars | §10.6 | 7 |
| N12 | **PERSIST** test — RS line vs the event day | PANEL | bars | §10.6 | 7 |
| N13 | Dedupe by (class, date ±3 sessions) | — | pipeline | §10.7 | 7 |
| N14 | Rejects named: analyst notes, index inclusion, earnings, splits/buybacks, suits | — | pipeline | §10.5 | 7 |
| N15 | **Secondary offerings routed to S**, not N — supply going up | PANEL(S) | EDGAR | §10.5 | 7 |
| N16 | **% off 52-week high** | ROW | bars | §7.7 | 3 |
| N17 | Existing three-week headline list — **unchanged, kept below N1** | NEWS | existing | §11.7 | — |

### 12.6 S — supply, §7.6

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| S1 | Shares outstanding | PANEL | EDGAR `dei:` | §3.1 | 5 |
| S2 | **Float — an estimate, and labelled as one** (no free feed publishes it) | PANEL | EDGAR 4 / 13D/G | §3.1 | 6 |
| S3 | Short interest — days to cover and % change | PANEL | FINRA | §3.1 | 6 |
| S4 | **U/D volume ratio** over 50 days — a different object from A/D | PANEL | bars | §1 | 4 |
| S5 | Existing Volume & Float block on the card — unchanged | ROW | existing | — | — |

### 12.7 L — leader or laggard, §7.5 + §9

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| L1 | Group name and **rank of divisor** | PANEL + ROW | groups file | §7.5, §9.3 | 3 |
| L2 | Divisor **stored with the value**, because 197 → 145 happened | — | groups file | §9.4 | 3 |
| L3 | Stocks in group | PANEL | groups file | §7.5 | 3 |
| L4 | New highs / lows within the group | PANEL | bars | §7.5 | 4 |
| L5 | **This stock ranks**: RS, EPS, A/D, Comp — each `n of N` | PANEL | groups file | §7.5 | 3–5 |
| L6 | **Top RS names in the group**, listed | PANEL | groups file | §7.5 | 3 |
| L7 | **Sector rank 1 of 33** — the coarse level, kept distinct from group | PANEL | derived | §9.1 | 4 |
| L8 | **RS line at a new high before price** — the MarketSmith tell | PANEL | bars | §1, §7.5 | 4 |
| L9 | **Group table on the market tab** — top 20 / bottom 10 with divisors | MKT | groups file | §11.4 | 3 |
| L10 | Honest note: our membership is ours, not IBD's | PANEL | text | §9.5 | 3 |

### 12.8 I — institutional sponsorship, §7.4

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| I1 | **Fund count by quarter, 8 quarters** | PANEL | SEC **13F** | §7.4 | 6 |
| I2 | The **trend** called out, not just the level | PANEL | derived | §7.4 | 6 |
| I3 | Funds % / Banks % / Management % | PANEL | 13F + Forms 3/4/5 | §3.1 | 6 |
| I4 | The 45-day statutory lag stated on screen | PANEL | text | §3.1 | 6 |

### 12.9 Cross-cutting

| # | Element | Rule |
|---|---|---|
| X1 | **Every block carries its own as-of date** — they refresh on different clocks | §11.3 |
| X2 | Panel is in **letter order** (C A N S L I M), because the panel is the method | §11.3 |
| X3 | Reconstructions are named as reconstructions — `rs`, never "IBD RS" | §6 |
| X4 | **Nothing enters a score, filter or rank.** Label, never filter | §11.1, §6 |
| X5 | **No network call in a card render** — every field comes from a written file | §11.7 |
| X6 | Computed once by qp, read by nine tools; failure = no data, never a failed scan | §11.2 |
| X7 | A missing file reads **"not fetched yet"** with the last attempt date — never a blank that looks like zero | §11.5 |
| X8 | Thresholds are **O'Neil's**, named constants, printed next to any signal | §5 |

### 12.9b The market tab reflected per card — §14

| # | Element | Home | Source | Rule | Phase |
|---|---|---|---|---|---|
| P1 | The state, one compact line | CTX | `oneil-market.json` | §14.2 | 2 |
| P2 | **What this stock did on the live distribution days** — `up on 4 of 5, avg +0.9% vs index −0.8%` | CTX | market file + bars | §14.3 | 2 |
| P3 | The five dates behind a tap, so it is checkable against a chart | CTX | market file | §14.5 | 2 |
| P4 | Verdict: HOLDING UP / IN LINE / GIVING WAY | CTX | derived | §14.2 | 2 |
| P5 | **Sessions since the follow-through day**, banded early/established/late | CTX | market file | §14.3 | 2 |
| P6 | **Group rotation** — rank now vs 3 months ago, ▲into / ▼out of | CTX | groups file | §14.3 | 3 |
| P7 | The exposure implication in O'Neil's words | CTX | text | §14.3 | 2 |
| P8 | Says so explicitly when there are **no** live distribution days | CTX | derived | §14.5 | 2 |

### 12.9c Everything explains itself — §13

| # | Element | Rule |
|---|---|---|
| E1 | Every label carries a tappable `ⓘ` — **tap, not hover**, because `title` does not exist on a touch screen | §13.1 |
| E2 | The definition card has **four parts, always**: what it means · how it is calculated · **what it is NOT** · source and as-of | §13.2 |
| E3 | `WHAT IT IS NOT` comes from the §1 trap table and is **mandatory** | §13.2 |
| E4 | A **Method page** in the tool: the trap table, every formula, the thresholds with provenance, the honest limits | §13.2 |
| E5 | No bare number — ranks print divisors, ratios print windows, percentiles print scales | §13.3 |
| E6 | No blank that reads as zero: `not fetched yet · last tried DATE` | §13.3, X7 |
| E7 | Every threshold that fires prints itself and whose number it is | §13.3, X8 |
| E8 | Existing `title` tooltips kept, but never the only copy of an explanation | §13.1 |

### 12.10 Phases — what each one delivers

| Phase | Delivers | Depends on |
|---|---|---|
| **1** ✅ | M1–M10 — the whole market model, written to `oneil-market.json` | index bars only |
| **2** ✅ | The market tab O'Neil block (M5–M12) **and its per-card reflection P1–P5, P7, P8** | phase 1 |
| **3** | Groups: R3–R4, R7–R9, L1–L3, L5(RS), L6, L9, L10, N10, N16, **P6** | `relstrength.py` |
| **4** | Ratings that need bars: R1, R6, S4, L4, L7, L8 | phase 3 |
| **5** | EDGAR: C1–C8, A1–A6, R2, R5, S1, L5(EPS) | EDGAR fetcher |
| **6** | 13F & FINRA: I1–I4, S2, S3 | phase 5 |
| **7** | The N pipeline: N1–N9, N11–N15 | phases 3 and 5 |

**E1–E8 are not a phase.** Every phase ships its own definition cards with it;
a field that arrives without its explanation is not finished. The Method page
(E4) grows with each phase rather than being written once at the end.

Phases 1–4 need **no new data source at all** — index bars, Polygon grouped
daily and `relstrength.py` are already in the system. That is where the market
model, the whole group hierarchy and most of the row live, and it is why the
build order in §11.6 starts there.

---

## 13. LOCKED — the card, and the rule that everything explains itself

**The card spec (§7, §11.3, §12) is confirmed and locked.** Changes to it from
here are amendments with a reason recorded, not redesigns.

One requirement is added, and it applies to **every field in this document**:

> **Nothing is hidden, and every number explains its own meaning and its own
> calculation, inside the tool.**

Not in this file. This file is for building; the person using the tool at
07:40 is not going to open a repository.

### 13.1 The problem with how the card explains itself today

The card already carries good explanations — 14 of them in the card renderer
alone, written as `title="..."` attributes:

```html
title="volume against a normal day — 1.5× notable, 5× extreme"
title="shares actually available — under 20M is notable, under 10M is extreme"
```

**A `title` attribute does not appear on a touch screen.** There is no hover on
Android Chrome, which is where this desk is actually read. So every one of
those sentences is, in practice, invisible on the device it matters on — the
work of explaining was already done and it is not reaching you.

That is not a CANSLIM problem, but CANSLIM triples the number of fields that
need explaining, so it is fixed here rather than made worse.

### 13.2 The three levels of explanation

Every field gets all three. They are different jobs.

**Level 1 — the label, tappable.** Every label carries a small `ⓘ`. Tapping
opens a definition card. Tapping, not hovering, so it works on the phone. The
existing `title` text stays where it is — it costs nothing and it works on a
desktop — but it is never the only copy of an explanation.

**Level 2 — the definition card.** Four parts, always the same four, because a
definition with only the first part is what created every trap in §1:

```
┌ RS Rating ────────────────────────────────┐
│                                            │
│ WHAT IT MEANS                              │
│ Where this stock's 12-month price          │
│ performance ranks against every other US   │
│ stock. 99 = top 1%. 50 = middle.           │
│                                            │
│ HOW IT IS CALCULATED                       │
│   RS = 0.4·(P0/P63) + 0.2·(P0/P126)        │
│       + 0.2·(P0/P189) + 0.2·(P0/P252)      │
│ 63/126/189/252 trading days = 3/6/9/12     │
│ months. The most recent quarter counts     │
│ double. Then ranked into a percentile      │
│ 1-99 against every US ticker.              │
│ Split-adjusted prices.                     │
│                                            │
│ WHAT IT IS NOT                             │
│ Not RSI. RSI compares a stock to its own   │
│ recent range and says nothing about any    │
│ other stock. Two stocks can both print     │
│ RSI 70 while one leads the market and the  │
│ other is a laggard bouncing in a downtrend.│
│                                            │
│ SOURCE · AS OF                             │
│ Polygon grouped daily · 2026-08-31 close   │
└────────────────────────────────────────────┘
```

**`WHAT IT IS NOT` is mandatory and comes straight from §1.** That table exists
because these concepts have plain-English names that mean something else. The
trap column was written for the person reading the card, not for me.

**Level 3 — the Method page.** One page in the tool, reachable from the panel
and from the market tab, holding every definition in one scrollable document:
the §1 trap table, the formulas, the thresholds with O'Neil's provenance from
§5, and the honest limits from §3.1 and §9.5. It is this document's content,
rendered where it can actually be read.

### 13.3 "Everything visible" — what that rules out

- **No bare number anywhere.** A rank prints its divisor (`63 of 197`), a
  percentile prints its scale, a ratio prints its window (`U/D 1.41 · 50d`).
- **No blank that could be read as a zero.** Missing is `not fetched yet ·
  last tried 2026-08-30`; not-applicable is `n/a` with the reason on tap.
- **No number without its as-of date** — per block, because they refresh on
  different clocks (§11.3, X1).
- **No reconstruction presented as the original.** `rs`, never "IBD RS", and
  the definition card says so (§6, X3).
- **Every threshold that fired prints itself**, with whose number it is:
  `FTD +1.7% — O'Neil, The Successful Investor` (§5, X8).

---

## 14. The market tab, reflected in every card

This is the part that makes M worth having, and it is the one thing that
cannot be solved by printing the market status on the card.

**Why it matters, in O'Neil's own terms:** he found **three out of four stocks
follow the general market direction**, and called M the most important letter
— the one most investors ignore. His words: *"You can be right on every one of
the factors in the last six chapters, but if you're wrong about the direction
of the general market, and that direction is down, three out of four of your
stocks will plummet along with the market averages."*

### 14.1 The trap: the same sentence on 150 cards is not information

The obvious build is to stamp `Market: uptrend under pressure` on every card.
On a register day that is **150 identical lines**. A field with the same value
on every row carries no information about any row — it is a page header that
has been copied into the body 150 times, and after two mornings the eye stops
seeing it.

So the market state appears on a card in **two parts**, and only the first is
shared:

| Part | Varies per card? | What it is |
|---|---|---|
| **The state** | No | One line, compact, the same everywhere. It is the header fact |
| **This stock against it** | **Yes** | What this specific stock did during the market events the tab is counting |

The second is the point. It is computed from the market tab's own output —
the dated distribution days and the follow-through date — crossed with this
stock's bars.

### 14.2 The block, on every card

```
M — MARKET, AND THIS STOCK IN IT

  Market        Uptrend under pressure · 5 distribution days live
  Since FTD     32 sessions (follow-through 2026-07-18)

  ON THOSE 5 DISTRIBUTION DAYS
    This stock  up on 4 of 5   ·   avg +0.9%   vs index avg −0.8%
    Verdict     HOLDING UP — being accumulated while the index is
                being distributed

  GROUP ROTATION
    Retail-Leisure Products   rank 141 → 28 over 3 months   ▲ into

  WHAT O'NEIL DOES HERE
    Stop initiating new positions; tighten stops on open ones.
    A name holding up through distribution is a leader candidate
    for the next follow-through day.
```

### 14.3 The four per-card readings, and how each is computed

**1. Behaviour on the distribution days — the strongest one.**

The market tab already knows the exact dates of the live distribution days.
For each, ask what *this* stock did on that same session:

```
held_up = count of live distribution days where
              stock's close-to-close return  >  index's return
avg_rel  = mean(stock return − index return) over those days
```

This is O'Neil's "leaders hold up during market pullbacks", made checkable.
It is a **different number on every card**, computed from a market-level fact,
and it is the single most useful thing the market model can tell you about one
stock. Nothing in the system does this today.

**2. Sessions since the follow-through day — the clock on the uptrend.**

O'Neil buys early in a new uptrend. A breakout 5 sessions after an FTD and the
same breakout 200 sessions after it are different propositions, and this is
also the input to base-stage counting (§1) — bases are counted **from the
market bottom**, so the FTD date is where that count starts.

```
sessions_since_ftd = trading days from the confirmed FTD to today
```

Banded on the card: `early (<25)` · `established (25–150)` · `late (>150)`.

**3. Group rotation — the market's money, at this stock's level.**

The market state is about the index; the group rank change is about where the
money inside it is going. From §9's group file:

```
rank now  vs  rank 3 months ago      ▲ into / ▼ out of / flat
```

This is also N10 in the manifest — "new industry conditions" — and it is the
same computation serving both letters. Computed once.

**4. The exposure implication, in O'Neil's words, not a number.**

Each of the three states carries the action O'Neil draws from it (§2.1). It is
printed as text because it is a rule, not a measurement, and printed on the
card because that is where the decision is being made.

### 14.4 Where each piece lives

| Reading | Market tab | Card |
|---|---|---|
| The state and why | **Full** — status, per-index counts, dated distribution table, rules in use | One compact line |
| Distribution days | **The list**, with dates | **What this stock did on those dates** |
| Follow-through day | **The date, the day-count, the caveat** | Sessions since, banded |
| Groups | **Top 20 / bottom 10 table** | **This stock's group, and its rotation** |
| Exposure implication | Once, at the top | Once, per card |

The tab holds the evidence; the card holds this stock's relationship to it.
Neither repeats the other, and the card's version is a different number for
every stock on the page.

### 14.5 The rules this must not break

- **Still a label, never a filter** (X4). "Held up on 4 of 5 distribution
  days" does not change the stock's score or whether it appears. It is the
  most tempting thing in this document to feed into a score, and feeding it in
  would make every card captured before today incomparable with every card
  captured after.
- **Computed from the shared file** (X6). The card does not recompute the
  market state; it reads `oneil-market.json` for the dates and does one
  comparison against bars it already has.
- **The dates are shown**, not just the count. "Up on 4 of 5" with the five
  dates behind a tap, so it can be checked against a chart.
- **It says when there are none.** In a confirmed uptrend with zero
  distribution days there is nothing to hold up through, and the block says
  exactly that rather than printing `0 of 0` or a blank.


---

## 15. From the workshop (O'Neil, January 2010) — what it changed

Three corrections to this document, all in the counting, plus one section that
is still to build.

### 15.1 The anchor was wrong

| | Was | Is |
|---|---|---|
| The bottom | the correction low | the **lowest CLOSE** of the cycle |
| Day 1 | the first **up** close after it | the session **immediately after** the lowest close, up or down |
| The reset | the **intraday low** undercut | a **new lower close** — which *is* a new bottom |

The reset is the part worth being careful about, because the two versions fire
on different bars. A wick below the previous low that closes above it does not
move the bottom; the old rule restarted a count the market had never broken.
And the two are not separate rules at all: the anchor is "the lowest close so
far", so a lower close moves it and the count naturally starts again.

### 15.2 Two forms of the same rule, both recorded

Neither is a conflict, and both are now in the model with their provenance:

- **Distribution day** — the workshop says plainly *"closes lower on higher
  volume"*. IBD's **−0.2%** is the operational floor on that. Configurable;
  zero gives the plain form.
- **The window** — the workshop says **5–6 weeks**; IBD says **25 sessions**.
  25 is the tight end of his own range.

### 15.3 Still to build, from the workshop

The base pattern, which is what N and the buy point actually rest on:

| Phase | What to detect |
|---|---|
| **1 — Decline** | the correction, typically in **three waves** down |
| **2 — Base support** | heavy volume with **no further price progress** — weeks where volume spikes or stays high while the price closes flat or tight. Institutional accumulation |
| **3 — Handle** | a minor controlled drift down, or tight sideways action, near the **upper** part of the base, before the pivot |

And the divergence test, which is the sharpest version of what §14 already
computes per card:

> While the index breaks to new lows, the stock **fails to make a new low** and
> reverses up. Its **RS line makes higher highs and enters new high ground
> BEFORE the price does.**

§14's "held up on 4 of 5 distribution days" is the same idea measured on
distribution days. The full version — RS line at a new high before price — is
`L8` in the manifest and belongs with base detection.
