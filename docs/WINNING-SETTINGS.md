# The winning backtest — settings of record

**This file is the specification.** The desk is set FROM these. Nothing here is
derived, inferred or converted: it is what was on the screen of the run that won,
field by field, in the order the form shows them.

When a later run beats it, replace this file and re-adopt. Do not edit the desk
by hand — `parity-check --adopt` is what writes it, so the two cannot drift.

---

## OR + VWAP 09:35 — backtest #349

**Result:** `+$3,346.50` · `+6.69%` · $50,000.00 → **$53,346.50** · after $294.00 fees
**30** trades sized · **53.3%** won after fees

### Strategy
| field | value |
|---|---|
| Strategy | OR + VWAP 09:35 (Long) |
| Second book | OR + VWAP 09:35 (Short) |

### What to test
| field | value |
|---|---|
| Universe | Register R1 |
| Fill model | **next open** |
| Symbols | *(empty)* |
| Timeframe | **1m** |
| Feed | **polygon** |
| From | 08/11/2026 |
| To | 08/31/2026 |

### Money
| field | value |
|---|---|
| Account $ | **50000** |
| Risk % / trade | **0.5** |
| Risk $ / trade | *(empty)* |
| Max position % | *(empty — NO cap)* |
| Cost bps / side | *(empty)* |

### Ranking
| field | value |
|---|---|
| Rank by | **VWAP extension (T2)** |
| Top N / day | **3** |
| Min RVOL | *(empty)* |

### Funded-account rule
| field | value |
|---|---|
| Target % | *(empty)* |
| Max DD % | *(empty)* |
| Measured | from start |

### Prop-firm costs & caps
| field | value |
|---|---|
| Preset | Trade The Pool |
| Fixed shares | 100 |
| $ / share | 0.005 |
| Min $ / order | 0.75 |
| Min $ / sh | 0.10 |
| Max entries / day | *(blank — the strategy's own cap)* |
| RTH-only entries + forced 15:50 EOD close | ☑ **on** |
| Only trade after the scanner found the stock | ☑ **on** |

---

## The three that are NOT what the desk was running

Everything else already matched. These are the ones adoption changes:

| | desk was | this run |
|---|---|---|
| risk rule | $500 flat | **0.5% of the account** |
| max position | 16.66% | **no cap** |
| feed | yahoo | **polygon** |

## Two notes that belong with the numbers

**"Empty" is a value.** An empty Max position % means NO cap, not "leave the old
one". Adopting this run has to CLEAR the 16.66 that is set, not step over it.

**The percentage compounds and the desk does not.** This run sized each trade on
the equity that existed when it was entered; the desk sizes on the configured
account size. They agree on trade one — 0.5% of 50,000 = $250 — and drift as the
run banks P&L. Closing that gap means sizing off live broker equity, which has
not been built.

## The three levels, and which one decides

The desk holds settings at three levels. They must resolve to exactly one
answer per setting, or the desk sizes by a rule nobody chose.

| level | file | holds |
|---|---|---|
| **tool** | `tools.config.json` | which tool runs a setup, its card register. **No money settings at all.** |
| **account** | `data/risk.json` | account size, risk (flat $ **or** %), max position % — shared by every setup |
| **setup** | `data/setup-prefs.json` | the same three for ONE strategy, plus rank, tf, feed, view, fill, max entries/day |

**The rule: setup beats account. The risk rule is taken WHOLE.**

If the setup names *either* risk rule, the account's is ignored entirely — half
a percentage and half a flat dollar is neither. `risk.resolve()` is the only
place this is decided; the runner, the parity check and the reports all read it.

### Adoption writes at the SETUP level

`--adopt` writes this run's risk rule and position cap onto **the setup**, and
only the account **balance** onto the account.

That is the whole reason the levels exist. The account is shared by every setup
on the desk, so a risk rule written there is not this strategy's setting — it is
the desk's. Adopt a winner for `Test` next week at $300 flat and it would
silently resize 09:35's trades, and nothing would report it.

The balance is different: there is **one** balance, and every setup is sized
against the same money. It is the only line adoption marks ACCOUNT-WIDE.

Exactly one risk rule is written and the other is deleted, so a setup can never
name both. A cap the run did not have is written as `100` (= no cap) rather than
cleared — clearing it would fall through to whatever the account happens to say.

### What counts as a conflict

A setup **overriding** the account is the design, not a fault. Every adopted
setup does it, and `parity-check` reports it as information, never as a
difference — flagging it would leave a correctly configured desk permanently red.

The one real conflict is **one level naming two risk rules at once**. No
precedence can settle that, so it gets its own row and fails the check.

## Applying it

```
node scripts/parity-check.js --backtest 349 --adopt        # show the changes
node scripts/parity-check.js --backtest 349 --adopt --yes  # write them
node scripts/parity-check.js --backtest 349                # confirm it is clean
```
