# Every field on a card, where it comes from, and when a blank is legitimate

The checklist for going through a live card one field at a time.

**A blank is not automatically a bug.** Some fields are blank because a job has
not run — those are fixable. Others are blank because the honest answer is "no
answer", and filling them would mean inventing a number. The third column says
which, so the two are never confused.

`SOURCE` is what has to be working for the field to have a value:

| tag | means |
|---|---|
| **TV** | the TradingView screener, on every scan |
| **BARS** | daily price bars, fetched per card |
| **EDGAR** | the SEC filings cache — `deploy/run_edgar.py` |
| **QP-M** | the market model — `data/oneil-market.json` |
| **QP-L** | the group ranks — `data/oneil-groups.json` |
| **QP-I** | 13F — `data/oneil-13f.json` |
| **NEWS** | the news feed |
| **DESK** | computed on the desk from fields above |

---

## Header

| # | Field | Source | Blank means |
|---|---|---|---|
| 1 | Ticker | TV | never blank |
| 2 | Price | TV | never blank |
| 3 | Change % | TV | never blank |
| 4 | Live badge | DESK | not in the live window |
| 5 | Sector · Industry | TV | **BUG** — TV always sends it |
| 6 | Score | DESK | **BUG** |
| 7 | Bucket (B4/B5 main) | DESK | **BUG** |
| 8 | First seen · mins before open | DESK | **BUG** |
| 9 | Trigger badges (Big Move, Pre-Mkt) | DESK | no trigger fired — normal |
| 10 | HOT | DESK | not hot — normal |
| 11 | Catalyst badges | NEWS | no catalyst in the window — normal |
| 12 | MA flags ▲▼ (5, 9, 13, 20, 50, VWAP, PDC, OPEN, PMH, PML) | TV | a flag missing = that MA has no value (see EMAs) |
| 13 | Stack (9<13<20<50) | DESK | an EMA is missing |
| 14 | Quarter range (Q1–Q4) | TV | no month range |
| 15 | PM/ADR band | DESK | no pre-market range |

## Volume & Float

| # | Field | Source | Blank means |
|---|---|---|---|
| 16 | RVOL | TV | **BUG** |
| 17 | Market Cap | TV | **BUG** |
| 18 | Float | TV | TV has no float for this ticker — happens on new listings |
| 19 | Short % | Yahoo → FINRA | no short interest reported; TV never serves this field |
| 20 | Days to cover | DESK | needs short interest **and** average volume |

## Range

| # | Field | Source | Blank means |
|---|---|---|---|
| 21 | W position % | TV | **BUG** |
| 22 | M position % | TV | **BUG** |
| 23 | Q position % | TV | under a quarter of history |
| 24 | Y position % | TV | under a year of history |

## News

| # | Field | Source | Blank means |
|---|---|---|---|
| 25 | Catalyst label | NEWS | nothing classified — normal |
| 26 | Story count | NEWS | "nothing in three weeks" is a real answer |
| 27 | Top headline | NEWS | as above |

## CANSLIM — the one-line summary

Each letter is the summary of its full table below. A letter missing from the
summary appears in the "Not shown:" line with its reason.

| # | Field | Source | Blank means |
|---|---|---|---|
| 28 | C — EPS %chg · sales %chg · quarter | EDGAR | not walked yet, or no filings |
| 29 | C — accelerating · beat +25% | EDGAR | no quarter had a comparable base |
| 30 | A — 3yr · wobble · ROE | EDGAR | see A table |
| 31 | N — weeks · depth · handle | BARS | under 7 weekly bars |
| 32 | N — pivot · % away · checks | BARS | as above |
| 33 | S — U/D · A/D | BARS | under 3 / 10 sessions |
| 34 | L — group · rank · RS in group | QP-L | see L table |
| 35 | I — funds · change · direction | QP-I | 13F not built, or CUSIP unmatched |
| 36 | M — status · DD live | QP-M | market model not built |
| 37 | M — on the DD days | QP-M + BARS | no distribution days yet |

## Relative strength

| # | Field | Source | Blank means |
|---|---|---|---|
| 38 | RS line — % off its own high | BARS | under 30 sessions |
| 39 | Divergence | BARS + index | needs 60 sessions and an index low |

---

# FULL TABLES

## C — current quarterly earnings

One row per quarter, eight quarters.

| # | Column | Source | Blank means |
|---|---|---|---|
| 40 | Qtr | EDGAR | never blank if the row exists |
| 41 | EPS $ | EDGAR | the filer tagged sales but not EPS that quarter |
| 42 | **Yr ago (EPS)** | EDGAR | no quarter within 45 days of one year back |
| 43 | %Chg (EPS) | DESK | `n/a (loss a year ago)` — **correct**, a % from a negative base has no meaning. `n/a` alone = no year-ago quarter |
| 44 | Sales | EDGAR | filer tagged no revenue |
| 45 | **Yr ago (Sales)** | EDGAR | as 42 |
| 46 | %Chg (Sales) | DESK | `n/a (no sales a year ago)` — correct for a pre-revenue company |
| 47 | Margin | DESK | needs net income and revenue. Capped at ±999% |
| 48 | Accelerating: yes/no (last N quarters) | DESK | N=0 means no quarter had a % — normal for a loss-maker |
| 49 | Beat +25%: X of Y | DESK | Y=0, as above |

**A missing Q4** is deliberate when EPS and net income disagree on the sign —
the share count moved and the subtraction would be fiction.

## A — annual earnings

| # | Column | Source | Blank means |
|---|---|---|---|
| 50 | FY | EDGAR | never blank if the row exists |
| 51 | EPS $ | EDGAR | no annual EPS tagged |
| 52 | %Chg | DESK | `n/a (no prior year filed)` = a gap in the filings. `n/a (loss a year ago)` = correct |
| 53 | ROE | DESK | `n/a` = **equity is zero or negative** — correct, not a return |
| 54 | 3-yr growth | DESK | needs 4 unbroken years **and a positive base year** |
| 55 | Stability | DESK | needs 4 annual rows. LOW IS GOOD |
| 56 | ROE vs the 17% floor ✓/✗ | DESK | no ROE to compare |

## N — the base (weekly)

| # | Field | Source | Blank means |
|---|---|---|---|
| 57 | Summary (weeks, depth, waves, accumulation, handle) | BARS | under 7 weekly bars |
| 58 | Lip price and week | BARS | as above |
| 59 | Low price and week | BARS | as above |
| 60 | Depth % over N weeks | BARS | as above |
| 61 | Waves down | BARS | as above |
| 62 | Accumulation weeks | BARS | 0 is a real answer, not a blank |
| 63 | Handle | BARS | "none yet" is a real answer |
| 64 | Pivot · % away · X of 6 checks | BARS | as above |

## S — supply

| # | Field | Source | Blank means |
|---|---|---|---|
| 65 | Shares outstanding | EDGAR | no share-count tag in the filing |
| 66 | Basis (cover / balance sheet / issued / weighted avg) | EDGAR | shown only when it is **not** the cover figure |
| 67 | As of | EDGAR | as 65 |
| 68 | Float | TV | TV has none for this ticker |
| 69 | Float as % of shares outstanding | DESK | needs both 65 and 68 |
| 70 | Short interest % + basis + as-of | Yahoo → FINRA | not reported |
| 71 | Days to cover | DESK | needs 70 |
| 72 | U/D volume over N sessions | BARS | under 3 sessions, or no down-day volume |
| 73 | A/D grade + raw over N sessions | BARS | under 10 sessions |

**"N sessions, short of 50/65"** is the correct label on a young stock, not a bug.

## L — leader or laggard

| # | Field | Source | Blank means |
|---|---|---|---|
| 74 | Group name | QP-L | see below |
| 75 | Rolled up marker | QP-L | absent = a real named industry, which is the normal case |
| 76 | Rank X of Y | QP-L | — |
| 77 | Percentile + letter | QP-L | — |
| 78 | RS X of N in its group | QP-L | — |
| 79 | Rotation ▲ into / ▼ out of | QP-L | under a quarter of cached sessions |

Three reasons L can be absent, and only the first is fixable by waiting:
1. `group ranks not built yet` → run the nightly job
2. `in <industry>, but no RS rating` → the stock is under a year old. **Correct**
3. `not in the industry map` → an ETF, or EDGAR has no SIC code

## I — institutional sponsorship

| # | Field | Source | Blank means |
|---|---|---|---|
| 80 | Holders | QP-I | not built, or the CUSIP did not resolve |
| 81 | Change | QP-I | only one quarter on file |
| 82 | Direction | QP-I | as 81 |
| 83 | Quarter history | QP-I | as 80 |

## M — market direction

| # | Field | Source | Blank means |
|---|---|---|---|
| 84 | Status | QP-M | not built |
| 85 | Distribution days live | QP-M | 0 is a real answer |
| 86 | This stock on those days: X of Y | QP-M + BARS | no distribution days to check |
| 87 | Verdict (HOLDING UP / GIVING WAY) | DESK | as 86 |
| 88 | Sources line — EDGAR, groups, market, 13F dates | all | each says "pending" when its file is missing |

---

## Market Context, Price, EMAs, ATR, Pre-market

| # | Field | Source | Blank means |
|---|---|---|---|
| 89 | Regime · long · short | DESK | **BUG** |
| 90 | Price, Prev Close, VWAP, Open, Gap % | TV | **BUG** |
| 91 | 5-day MA | TV | under 5 sessions |
| 92 | EMA 9 / 13 / 20 / 50 | TV | under that many sessions — a new listing legitimately has no EMA 50 |
| 93 | ADR $ / ADR % | TV | **BUG** |
| 94 | Move (× ATR) | DESK | needs ADR |
| 95 | Day High / Low | TV | **BUG** |
| 96 | PM High / Low / Range | TV | no pre-market trading — normal on a thin stock |
| 97 | PM / ADR | DESK | needs 96 and ADR |

---

## How to check without reading a card

```
cd ~/Tade-desk-server/quant-platform
set -a; . ./.env; set +a; python3 -u deploy/run_fields.py RDAC FRVO BIAF
```

Prints every CANSLIM field per stock with the reason beside each blank.
`deploy/run_status.py` answers the other question — whether each job has run
at all.
