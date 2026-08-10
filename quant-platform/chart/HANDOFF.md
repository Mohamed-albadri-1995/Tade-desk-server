# HANDOFF — state of the scalp-validation platform (2026-08-08)

Written so ANY future session (any model) can continue without re-deriving
context. Read this + SCALPS_SPEC.md before touching anything.

## What this is

A verified quant platform (EC2 51.20.92.202:8765) that mechanizes the 5 SMB
scalps from `trades_.pdf` EXACTLY as written and validates them one at a time
on the R1 register (the screener's frozen per-day shortlist —
survivorship-bias-free; exists from ~2026-07-01, ~7-8 symbols/day). The PDF
is a **1-minute playbook** — always backtest on 1m (5m gave 0 trades). It
also hosts user-specified setups (OR+VWAP, T2) that are NOT from the PDF.

ONE repo now holds TWO tools: `quant-platform/` (this one) and `src/` (the
nine scanning tools). Both ship on branch `claude/multi-tool-screeners`;
`claude/read-j5hgnf` is where this tool is developed and is merged into it
before every deploy. A `git reset --hard` to either branch overwrites the
other tool, which has already happened once — never deploy a branch that
lacks the other's work.

**The failure mode to expect from that arrangement** (it has already bitten
twice, both times reaching the live box): each session is green against the
code it can see, and the break appears only where the two meet. On
2026-08-10 the scanner side added `_pairs(spec, strategy)` against a `run()`
that by then held a LIST of books, so EVERY backtest died with
`UnboundLocalError` before fetching a bar; and storing a setup's `tools` made
every seed differ from its bundle on every startup, wiping the user's tool
assignment on each deploy. So: **merge the other branch into yours FIRST,
run the whole suite on the merged tree, and only then push.** `run_all.py`
now includes the scanner side's pytest parts for exactly this reason, and
`logic_audit33` pins both bugs.

- `qp/` — verified primitives library (frozen but extendable WITH tests).
- `chart/` — strategy engine (`strategy.py::evaluate`), seeds
  (`seeds/scalps.json`), backtest (`backtest.py`), screener client, alerts,
  UI (`static/index.html`), tests (`tests/run_all.py`, 37 parts incl. a
  node-based UI runtime check, must be ALL GREEN before every commit).
- `SCALPS_SPEC.md` — THE derivation document: per-scalp logic from the PDF,
  mechanization map, provenance of every number, validation log. Update it
  with every change; it is the memory.

## Operating loop (the user drives the server; sessions cannot reach it)

0. `git merge origin/claude/multi-tool-screeners` into `claude/read-j5hgnf`
   BEFORE testing — the other tool's changes reach `chart/` too.
1. Assistant edits code → suite green → commit + push to `claude/read-j5hgnf`.
2. User deploys BOTH tools from the shared branch:
   `git checkout claude/multi-tool-screeners && git reset --hard
   origin/claude/multi-tool-screeners && git merge origin/claude/read-j5hgnf
   && git push origin claude/multi-tool-screeners && sudo systemctl restart
   qp-chart`. Run `bash deploy-tools.sh` too ONLY when the scanner side
   changed — it restarts 18 processes on a 1 GB box.
3. User runs backtests in the UI (register R1 · 1m · polygon · next open ·
   date range) and pastes the CSV back. Assistant analyzes, never guesses.

## Strategy status board

| Strategy | Status | Evidence |
|---|---|---|
| Fashionably Late | VALIDATED, LOCKED | #89: 75% win |
| RubberBand Long | VALIDATED, FROZEN | #125: 23 trades, 60.9% win, 2.2:1, +41% |
| RubberBand Short | VALIDATED, FROZEN | #124: 13 trades, 53.8% win, 1.71:1 |
| Back$ide | VALIDATED, FROZEN | #94: 44% win, 1.55:1, +4.9% |
| Second Chance | LADDER RULE VALIDATED (#131, 6/7 pre-registered predictions, first profitable run +7.6%); full validation pending the honest-RVOL In-Play run | #126→#131 chain in SCALPS_SPEC |
| OR + VWAP 09:35 (Long/Short) | BUILT, NOT RUN | user spec; opening range 09:30-09:34, entry 09:35 open, stop at OR midpoint, half at 2R, runner trails session VWAP. logic_audit31 |
| T2 10:00 VWAP Extension (Long/Short) | BUILT, NOT RUN | setup_spec.md v1.0; decision bar 09:59, entry 10:00 open, stop = session VWAP frozen, 2R, ranked top-2 per day ACROSS BOTH BOOKS. logic_audit32 |
| HitchHiker | NOT VALIDATED — next in queue | window fixed to 930-1030; exits carry the same fidelity questions fixed for SC (frozen SL, runner scope) — apply with HH's OWN evidence |

## The validation protocol (anti-Goodhart — the user demanded this)

1. Seeds derive from the PDF only. Arc tests are SMOKE, never calibration.
2. Every number carries provenance (SCALPS_SPEC table): PDF-literal /
   user-observed / mechanization-judgment / DATA-FITTED+window.
3. ONE deliberate change per strategy per data window. Diagnose first:
   funnel (`/api/strategy/explain`, `explain_scan`, leave-one-out
   `without_this`), then CSV leg-math, then user chart screenshots.
4. **Pre-register predictions** before a validation run (which trades must
   survive/vanish), judge the rule on them — not on the aggregate alone.
5. Count the **cap/cooldown shift side-effect**: dropping entries frees the
   2/day cap for new, possibly worse ones (#129's silent killer).
6. Failed experiments stay documented (capped-range rule: REVERTED — see
   SCALPS_SPEC provenance). Never re-add without new geometry.
7. Register accrues daily → next week is free out-of-sample. Never iterate
   twice on the same window.

## Engine semantics added during validation (all tested)

- `freeze: true` on prim SL/TP anchors — evaluate at the signal bar, hold
  for the trade (book stops/targets are FIXED levels). audit21.
- exit `scope: "runner"` — exit rule arms only after a scale-out leg banks
  ("trail the remaining ½"); falls back to whole-position when no leg armed.
- WRONG-SIDE GUARD — a profit leg must sit beyond the entry fill; gapped
  fills above a frozen target no longer bank phantom losses (#127: 21/77
  poisoned). Engine-wide.
- `abs: 0.02` dollar stop offsets (the book's literal ".02 below").
- Cross-symbol operands (`"symbol":"SPY"`) — causal market gate. audit20.
- Ladder rule pattern: `heldPivot ≥ 0.97×heldPivot[20]` (hold applies BEFORE
  offset) — refuses lower-high crosses inside fades. Chart-audit derived.
- `risk.stop_first: true` (opt-in, default OFF) — when one bar touches BOTH
  the stop and a target, book the STOP. Without it the target wins. Only
  the T2 setup sets it; changing the default would rewrite every past run.
- **Per-day cross-symbol ranking** (`spec.rank_per_day`) lives in
  `backtest.py`, NOT in a strategy — `evaluate()` only ever sees one symbol.
  Score = R-multiple to stop, in %. With `spec.strategy_ids` a single run
  spans MULTIPLE books so long+short compete for the same top-N slots.
- Real-account sizing: portfolio-wide capital cap (`room = equity × lev −
  open_notional`); trades that can't be sized are counted in
  `skipped_no_capital` with an `acct_note`, never silently dropped. Fee key
  accepts both `fee_min` and `fee_min_per_order`.
- `levels.window_high/low(start, end)` — **`end` is EXCLUSIVE**; the level
  runs live inside the window and freezes after it.
- The session window is checked on the **FILL** bar, not the signal bar —
  with `fill: 'next_open'` a 09:34 signal fills at 09:35 and is judged there.
- `min_rvol` backtest universe filter — honest SMB RVOL (qp
  `volume.rel_volume`: cumulative vs same-time-of-day average, 20 sessions)
  at the strategy's window_start. **The register's ctx_rvol is NOT this** —
  it is TradingView's one-bar `relative_volume_intraday|5` snapshot at
  ~09:36 (SHPH read 0.02 on a real M&A gap day). Never filter on ctx_rvol.
  Open definitional question: premarket volume is currently EXCLUDED
  (RTH-cumulative); if In-Play gappers show up in `rvol_below` samples,
  switch the library definition deliberately, with tests.

## Live alerts (chart/alerts.py, added 2026-07-21)

🔔 button in the UI. Server watcher polls today's **R1 + Shortlist** every
60s during 09:25–16:05 ET, evaluates **every saved strategy** (current or
future — reads the store each cycle) on live 1m bars, alerts on
`entry_now`. Dedup per (strategy, symbol, bar) + 10-min suppression;
strategies outside their session window are skipped. UI polls
`/api/alerts/recent` every 20s → beep + browser Notification + floating
log. API: POST `/api/alerts/start|stop`, GET `/api/alerts/status|recent`.
No bar cache exists — each (strategy×symbol) is one Polygon fetch per
cycle; keep interval ≥60s.

## Multi-source screeners (added 2026-08)

The user runs NINE scanning tools, each with its own R1 + Shortlist. Sources
are AUTO-DISCOVERED from `tools.config.json` (`screener.py::_from_tools_config`)
— never hardcode the list, it has been wrong before (T7 is "Liquid Movers",
not "Sessions"). The source is encoded in the register string:
`R1` = default tool, `T2:R1` = one tool, `*:R1` = union of all, with
per-symbol attribution and a per-source coverage line in the UI.

Exports (1 click): `/api/r1/csv`, `/api/r1/cards.csv`,
`/api/pairs/print|csv|parse`, plus the print sheet (`_print_window` counts
TRADING days, not calendar days).

## Warm-up correctness (data_manager.py)

`required_days()` is ADDITIVE: `base_days + warm-up`, capped by `_MAX_DAYS`
per timeframe. It was twice broken (a ceiling that SHRANK the request; a
`max()` that dropped the warm-up entirely) — long-period primitives then
silently computed from a truncated history. `_WARMUP_DAYS` is a MEASURED
table (see `tests/tools_warmup_probe.py`, sampled on RTH bars only), not a
guess. Adding a primitive with a lookback longer than a day means adding a
row there + a `logic_audit30` case.

## Open queue (in order)

1. **Run the two new setups on polygon** (OR+VWAP 09:35, T2 10:00). Both are
   BUILT, NOT RUN — no evidence exists for either yet.
2. **Feed question, open:** the user's `node scripts/verify-setup.js`
   reproduced 1/8 of the tool's T2 trades. Diagnosed: entries match EXACTLY
   on the yahoo rows; 100% of the divergence is VWAP (yahoo's bars vs
   polygon's). Settle it by re-running both setups on **polygon** and
   comparing, before touching any setup logic.
3. Second Chance: user runs with **min RVOL = 5** → judge vs sheet
   (50-55%, 1.9:1). On In-Play names #131 already reads 46.8%/1.77:1.
4. HitchHiker validation pass: apply exit fidelity (freeze + runner scope)
   with its own backtest evidence; window now 930-1030.
5. Known SC loser classes for forward OOS: spike-top chases (LHAI 11:57,
   rising ladder — book's "over-extension" factor); per-level 2-strikes
   (cap currently spends attempts on unrelated levels).
6. Universe decision (user's): tighten R1 criteria to In-Play once the
   honest-RVOL run confirms the 4-run directional split.
7. Premarket-inclusive RVOL definition — only with named evidence.
8. Phase 5: trading-tool bridge (INTEGRATION.md).
9. **DECISION NEEDED — `levels.day_open` look-ahead into premarket.**
   `qp/primitives/levels.py::_daily_agg(ago=0)` gives every bar of a session
   that session's aggregate, so on a historical frame a 04:00 PREMARKET bar
   already reads the 09:30 RTH open (reproduced: PM bars = 21.0, the exact
   09:30 open). The docstring calls this "display convenience", and it is
   harmless for every strategy we ship (all entry windows are RTH), but a
   user-built PREMARKET setup using `day_open` would be silently look-ahead.
   NOT changed in the 2026-07-28 review pass: fixing it would blank the
   day-open line across premarket on every chart, which is a product
   decision, not a bug fix. Affects `levels.day_open` only — `prev_day_*`
   use ago=1 (safe) and `today_high/low`, `pm_high/low`, `vwap.session` are
   genuinely running. Options: (a) leave as-is and document, (b) NaN before
   the session's first bar for evaluation while keeping the drawn line, (c)
   split into `day_open` (display) and a causal variant.
10. `backtest.run()` raises IndexError on `cov['by_source'][0]` if `pairs`
    is ever empty (`'symbols' not in by_src` lets an EMPTY dict into the
    branch). NOT reachable today — every `_pairs` path either raises or
    returns a non-empty list, and `_dates` raises on an empty range — so it
    was left alone rather than "fixed". Guard it the moment a universe kind
    can legitimately return zero pairs.
11. `volume.rel_volume` computes from as little as ONE prior session — the
    docstring says it needs `length`. A backtest `min_rvol` filter therefore
    accepts a value built on a 1-day baseline as "verified". Not changed
    (tightening it would silently drop pairs from past runs); decide whether
    the filter should require a minimum baseline depth.

## Box constraints (read before deploying)

t3.micro-class: **1 GB RAM**, small disk. It has WEDGED once from RAM+disk
exhaustion (recovered only via an AWS-console reboot + log cleanup, 90%→68%).
`deploy-tools.sh` restarts ~18 PM2 processes at once — run it ONLY when the
scanner side changed. It has aborted at step 5/6 with `[PM2][ERROR] Script
already launched` for ALERTS; the fix is to delete that PM2 entry before
re-running, not to re-run blindly. T1 is the only TRAINED scorer (its 167 MB
model is legitimate) and runs a month earlier than the other tools, which is
why it shows more restarts — do not "fix" that.

## Rules for any future assistant

- Commit after every patch; suite (`python3 chart/tests/run_all.py`) ALL
  GREEN first; trailers: `Co-Authored-By: Claude Fable 5
  <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01EPEBCN8SGZ2ABsATSpV7JH`.
  Never put model IDs in repo artifacts.
- Never loosen a seed to make a test or backtest pass. Diagnose → one
  PDF-sanctioned change → pre-registered predictions → user runs → judge.
- Frozen/validated strategies are untouchable without next-window evidence.
- The user's chart screenshots are the geometry ground truth — ask for them
  when the CSVs don't explain the losers.
- Short responses. Lead with the verdict. No assumptions — READ the code
  first; the user has asked for this explicitly and repeatedly.
- The UI is served `Cache-Control: no-store` and self-checks its own hash
  (`_ui_fingerprint`) so a stale tab announces itself — if the user reports
  a fix "not working", confirm the page is fresh before re-diagnosing.
  Mobile height uses `100dvh` (+ a JS fallback); never revert to `100vh`.
- `tests/ui_runtime.js` executes the page's JS in node and catches scope
  bugs (it was written after I introduced one in `_resizeChart`). It is part
  of `run_all.py`; keep it green.
