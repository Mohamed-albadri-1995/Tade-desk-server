# Plan: Journal Analytics + Setup Factor Engine

Status: **IMPLEMENTED** (phases A–E; see README for the API surface).

Two deliverables, in dependency order:

1. **Journal Analytics** — server-computed performance analytics over our
   entry/exit cards, with a visual browser UI (detailed + transparent).
2. **SetupFactorEngine** — a new sizing factor per setup, derived from that
   setup's *real* performance (expectancy, drawdown, profit factor, sample
   size), sitting beside the existing grade and regime multipliers.

The old standalone journal (Chrome extension) is the idea source, not the
template. What we take from it: the metric formulas (expectancy, profit
factor, R-multiples, MAE/MFE, capture %, max drawdown, SQN, payoff,
streaks), the equity-curve-with-drawdown visual, the calendar heatmap, and
the per-setup stats table with sparklines. What we drop: the correlation
tab, checklist win-weights, fills import/fees engine, and its trade-card
format — our cards are already richer (mandatory/default/additional
results, grade breakdown, gate snapshot, sizing factors).

Architecture rules carried over from the screener spec: **server is the
only source of truth** — every metric is computed server-side and the
browser only renders; every number shown must be reproducible from the
API response (transparency: no hidden math in the UI).

---

## Phase A — Exit data + per-trade enrichment (server)

Analytics needs closed trades. Today exits are filled manually via
`PUT /api/journal/{id}/exit`. This phase makes exits first-class and
enriches each closed card once at close time (immutable, like entry).

**A1. Exit enrichment on close.** When an exit is recorded, compute and
store on the journal row (new nullable columns):

| Field | Definition |
| :--- | :--- |
| `r_multiple` | signed PnL per share ÷ planned risk per share (entry − SL) |
| `planned_rr` | (TP − entry) ÷ (entry − SL) at entry (nullable if no TP) |
| `mae_pct`, `mfe_pct` | max adverse/favorable excursion between entry and exit, from cached OHLCV bars (best effort; null if bars unavailable) |
| `capture_pct` | realized favorable move ÷ max favorable move (how much of the available move was taken) |
| `hold_minutes` | exit_time − entry_signal_time |
| `exit_verdict` | classification from capture_pct (e.g. ≥80 excellent / ≥50 good / ≥30 early / <30 poor) — thresholds in one visible constant |

**A2. Exit UI.** The Journal tab gets an inline "close trade" form per open
entry (exit price, reason; PnL auto-computed as shares × (exit − entry) ×
side, editable). Also a bulk CSV import of exits (`journal_id` or
`stock+date`, `exit_price`, `exit_time`) for catching up old trades.

**A3. (later, out of scope here)** automatic position monitoring can fill
exits from live data; the enrichment path is the same either way.

---

## Phase B — AnalyticsService + API (server)

One service, pure functions over closed journal rows, no I/O at request
time beyond the DB read. Every endpoint accepts common filters:
`from`/`to` date, `setup_id`, `side`, `stock`, `grade`, `status`.

**B1. Account metrics** (`GET /api/analytics/overview`) — one object:
net PnL, gross win/loss, trade counts, win rate, profit factor,
expectancy ($/trade and R/trade), avg win, avg loss, payoff ratio,
max drawdown ($ and % of peak), recovery factor, SQN, Kelly %, daily
consistency, max win/loss streaks, avg hold (winners vs losers),
long/short split. Formulas identical to the old tool's
`jnl_accountMetrics` (they are standard and already proven).

**B2. Equity curve** (`GET /api/analytics/equity`) — cumulative PnL
series ordered by exit time, with running peak and drawdown per point
(the UI shades drawdown under the curve).

**B3. Calendar** (`GET /api/analytics/calendar?month=`) — daily net PnL,
trade count, win count per day for the heatmap; a day drills into its
trades.

**B4. Breakdowns** (`GET /api/analytics/breakdown?dim=`) — the workhorse
replacing the old correlation tab, suited to our structured cards. One
endpoint, one `dim` parameter; returns per-bucket account metrics
(same shape as B1) plus a small equity series for sparklines:

* `dim=setup` — the per-setup table (feeds the eye for Phase C)
* `dim=grade` — does A+ actually outperform B? Validates the grading model
* `dim=regime` — from the gate screener snapshot captured at entry
* `dim=side`, `dim=stock`, `dim=weekday`
* **entry-time analysis**: `dim=hour` (entry hour bucket) and
  `dim=session` (open 9:35–10:30 / morning / midday / power hour) from
  `entry_signal_time`, plus hold-duration buckets — a dedicated Time view
  in the UI, like the old tool's Time tab
* `dim=condition` — per default/additional condition name: metrics for
  trades where it was aligned vs not aligned. This is the transparent,
  tabular replacement for the old "win weights"/correlation idea, and it
  is the data view your future setup-enhancement engine will formalize.

**B5. Trade detail** — extend the existing journal detail with the Phase-A
enrichment fields so a single card shows: entry snapshot (already there),
exit snapshot, R, MAE/MFE, capture, verdict, and every factor the sizer
used. Nothing hidden.

---

## Phase C — Journal Analytics UI (browser)

Extend the existing single-page UI. The current **Journal** tab keeps the
card list + exit form (it is the old tool's "Trades" tab); a new
**Analytics** tab hosts the sub-views — all the useful tabs from the old
tool carried over (only Correlation is dropped, replaced by Breakdowns):

1. **Overview** — stat tiles (net PnL, win rate, expectancy $/R, PF, max
   DD, SQN, payoff, streaks) + the equity curve with drawdown shading.
   Each tile shows the formula/inputs in a tooltip (transparency).
2. **Calendar** — month grid heatmap (green/red by daily PnL, count
   badge), month navigation, click-through to that day's trades.
3. **Time** — entry-time analysis: metrics by entry hour, by session
   period, by weekday, plus hold-duration distribution (winners vs
   losers). (old tool: Time tab)
4. **Risk** — drawdown curve and max-DD detail, R-multiple distribution
   histogram, streaks, Kelly/SQN/recovery, risk-per-trade adherence
   (planned risk vs realized loss). (old tool: Risk tab)
5. **Stats** — the full metrics catalog in one transparent table: every
   metric with its value, formula and inputs. (old tool: Stats tab)
6. **Magnitude** — PnL/%-move magnitude buckets (small/medium/large
   winners and losers), MAE/MFE scatter, capture-% distribution — shows
   whether profits come from many small or few big trades. (old tool:
   Magnitude tab)
7. **Breakdowns** — dimension picker (Setup / Grade / Regime / Side /
   Stock / Hour / Session / Weekday / Condition) rendering the B4 table:
   bucket, trades, win %, expectancy, PF, total PnL, avg R, capture %,
   max DD, sparkline. Sortable columns, same filters as the API.
8. **Setup Factor** — see Phase D; lives here so the factor's inputs and
   the resulting multiplier are inspected in the same place.

Charts: plain inline SVG like the rest of our UI (the old tool's
sparkline/equity approach, no chart library dependency). All views are
static renders of API responses — refresh on filter change and on
`new_entry` WebSocket events; no client-side math.

---

## Phase D — SetupFactorEngine (server)

The third sizing factor. Same design principles as the grading engine
(and the screener's Side E): **model loaded from the database,
user-editable, signal-points/threshold style, fully transparent output.**

**D1. Inputs per setup** (closed trades only, optionally split by side):
`n` (sample size), expectancy R, profit factor, win rate, max drawdown R,
recent form (last-N expectancy vs overall).

**D2. Scoring — same signal-points pattern.** Each component is a signal
with user-editable thresholds/points, e.g. (defaults, all editable):

| Signal | Rule (defaults) | Points |
| :--- | :--- | :--- |
| Expectancy R | ≥ +0.5R → +2 · ≥ +0.2R → +1 · < 0R → −2 | asymmetric |
| Profit factor | ≥ 1.5 → +1 · < 1.0 → −1 | |
| Win rate | ≥ 55% → +1 · < 40% → −1 | |
| Max drawdown | ≤ 5R → +1 · > 10R → −2 | asymmetric, risk-first |
| Recent form | last-10 expectancy ≥ overall → +1, else 0 | trend check |

`score = Σ signal_points`, normalized 0–100 exactly like the grade score.

**D3. Score → factor via a user-editable mapping table** (like the grade
multiplier table): e.g. ≥80 → 1.5 · ≥60 → 1.25 · ≥40 → 1.0 · ≥20 → 0.5 ·
else **0.0**. Bounds default **0.0–1.5**: a setup with proven bad
performance reaches factor 0 → zero shares → the entry card is still
written (status `blocked_by_setup_factor`) so the record stays complete,
but no alert is dispatched.

**D4. Confidence shrinkage (critical).** With few closed trades the factor
must not swing sizing. Final factor is pulled toward neutral 1.0:

```
final_factor = 1.0 + (mapped_factor − 1.0) × min(1, n / min_trades)
```

`min_trades` user-editable (default 20). Below a hard floor (default 5)
the factor is exactly 1.0 ("insufficient data" shown in UI). Both knobs
in the model row.

**D5. Storage & recompute.** A `SetupFactorState` row per setup (and per
side if enabled): all raw inputs, per-signal points, score, mapped factor,
shrinkage, final factor, computed_at. Recomputed whenever an exit is
recorded and daily at session start — never at signal time (zero-latency:
the sizer reads the cached row).

**D6. Integration.**
`shares = base × grade_mult × regime_mult × setup_factor`. The entry
card's `entry_factors` gains `setup_factor` plus its full breakdown —
the card remains a complete audit of the size decision.

**D7. API + UI.** `GET /api/setup-factor` (all setups, full breakdown),
`GET/PUT /api/setup-factor/model` (weights/thresholds/mapping/knobs),
`POST /api/setup-factor/recompute`. UI in Analytics → Setup Factor: one
row per setup showing every input → points → score → factor → shrinkage →
final, so the multiplier is never a black box.

---

## Phase E — Accounts & capital guard (sizer fixes)

Answers three gaps in the current sizer: account size is one manual
number, there is no multi-account support, and nothing stops a position
from exceeding available capital *at the moment* of the signal.

**E1. AccountModel** — multiple accounts: `name`, `account_size`
(manual base), optional `risk_per_trade` override (falls back to global
settings), optional linked broker, `is_active`. A default account is
seeded from the existing settings value.

**E2. CapitalService (the "at the moment" part)** — per account, keeps an
in-memory, continuously-updated view: `capital_base` (live buying power
synced from Alpaca on an interval when a broker is linked; otherwise the
manual account_size) minus `open_allocation` (Σ entry_price × shares of
this account's open cards) = `available_capital`. Zero I/O at signal
time — the pipeline reads the cached value.

**E3. Hard cap in sizing** — per account:
`final_shares = min(risk_based_shares, floor(available_capital / entry_price))`.
When the cap binds, the entry card records it
(`capital_capped: true`, with both numbers) — transparent.

**E4. Multi-account cards/alerts** — sizing runs once per active
account; the entry card stores a per-account breakdown in
`entry_factors.accounts`, `entry_shares` holds the primary account's
shares, and each broker alert uses its linked account's share count.

**E5. Pipeline order fix** — grading runs as step 6 and sizing as step 7
(the v11 spec listed sizing before grading, but sizing consumes the
grade multiplier; grade-then-size is now the explicit order).

## How this feeds the future setups-enhancement engine

Phase B4's `dim=condition` breakdown + the per-condition
`grade_breakdown` already stored on every card + Phase D's per-setup
performance state are exactly the substrate that engine needs: it will
compare a setup's realized performance across condition-alignment splits
and propose "drop X / add Y / X is harmful" — as setup *variations* to
paper-evaluate, not silent edits. Nothing in this plan needs rework for
that step.

## Suggested build order & test focus

1. A1/A2 (exit enrichment + UI) — unit tests for R/MAE/MFE/capture math.
2. B1–B5 (AnalyticsService) — golden-number tests on a fixture set of
   ~20 synthetic closed trades (hand-computed expected metrics).
3. C (UI) — render from fixtures; no client math to test.
4. D (SetupFactorEngine) — tests for each signal's thresholds, the
   mapping, shrinkage behavior at n = 0/5/10/20+, and sizer integration.

## Open decisions (defaults chosen; can be changed before build)

1. **Side split:** compute setup factor per (setup, side) when both sides
   have ≥ hard-floor trades, else pooled. *Default: pooled, side split as
   a model toggle.*
2. **Which PnL:** expectancy measured in R (risk-normalized) rather than
   $ so account-size changes don't distort the factor. *Default: R.*
3. **Recency:** recent-form window. *Default: last 10 closed trades.*
4. **Factor bounds:** *default 0.5–1.5* (never more than halve/1.5× the
   size on setup history alone).
