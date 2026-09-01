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

**The uptrend condition matters and is widely dropped.** During a correction or
a rally attempt there is no established uptrend to distribute *from*, so a heavy
down day is not added to the count. A count that ignores this runs up during
every correction and then reads as "extremely dangerous" on the day the bottom
forms — precisely inverted.

Two removal rules, and a day leaves the count when **either** fires:

1. **Age** — it passes out of the trailing **25 sessions**.
2. **Price recovery** — the index closes **≥5% above** that day's close.

*(IBD has published both 5% and 6% for rule 2 in different years. See §5.)*

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

```
Day 1 of a rally attempt = the first UP close after a correction low
                            (the low itself is day 0)

Follow-through day       = on day 4 or later of that rally attempt:
                             index gains ≥ THRESHOLD
                             AND volume > prior session's volume
```

- A follow-through **before day 4** is explicitly *not* one. Bounces in the
  first three days are the norm inside downtrends; the wait is the filter.
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

| Rule | Value | Provenance |
|---|---|---|
| Follow-through gain | **1.0%** | O'Neil's original, early editions of *How to Make Money in Stocks* |
| | **1.7%** | IBD raised it in the 2000s to cut false signals |
| | **1.2%** | Widely cited as IBD's more recent working figure |
| Distribution day recovery removal | **5%** or **6%** | Both published |
| Earliest follow-through day | **Day 4** | Consistent across sources |
| Distribution window | **25 sessions** | Consistent |
| Distribution day trigger | **−0.2%** on higher volume | Consistent |

**Recommendation:** default the follow-through threshold to **1.2%** and the
recovery removal to **5%**, expose both as configuration, and **print the
threshold in use next to any signal that fires**. A follow-through day is a
claim about the market; a claim whose definition is invisible cannot be
checked against a chart afterwards.

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
| New **product** | No | This lives in the news, and the card already carries a catalyst field |
| New **industry conditions** | Partly | The group's rank *rising* is the measurable trace |

Proposal: show **% off 52-week high** and **New CEO date** now; leave "new
product" to the existing catalyst; treat "out of a base" as phase 2.

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
  Rules in use  DD -0.2% on higher volume - 25 sessions - 5% recovery removal
                FTD +1.2% on day 4+ of a rally attempt

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
