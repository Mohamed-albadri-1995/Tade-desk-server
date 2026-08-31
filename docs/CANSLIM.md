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

### 2.3 The count → the state

| Live distribution days | State |
|---|---|
| 0–2 | Confirmed uptrend |
| 3–4 | Confirmed uptrend, worth showing the count |
| **5** | **Uptrend under pressure** |
| **6+** | Typically precedes / accompanies **market in correction** |

The count is not the only route into a correction: a decisive break of the
rally low also ends the uptrend regardless of the count.

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

### 3.1 Free sources, named

| Need | Source | Free? | Notes |
|---|---|---|---|
| Quarterly & annual EPS, revenue, equity | **SEC EDGAR XBRL** `data.sec.gov/api/xbrl/companyfacts/CIK{...}.json` | Yes, official, **no key** | Requires a descriptive `User-Agent`; ~10 req/s. Covers every US filer. This is the authoritative source — it is what the paid vendors resell |
| CIK ↔ ticker map | `www.sec.gov/files/company_tickers.json` | Yes, no key | One file, refresh monthly |
| Index OHLCV for the market model | **Already have** — Yahoo / Polygon | Yes | Nasdaq Composite `^IXIC`, S&P 500 `^GSPC` |
| Whole-market percentiles (RS, group rank) | **Already have** — Polygon grouped daily | Yes tier | One call per session |
| Shares outstanding / float | EDGAR `dei:EntityCommonStockSharesOutstanding` | Yes | Float is harder; shares outstanding is exact and free |

**Nothing here needs a paid vendor.** EDGAR is the primary source for every
fundamental in CAN SLIM.

---

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
