# HANDOFF — state of the scalp-validation platform (2026-07-21)

Written so ANY future session (any model) can continue without re-deriving
context. Read this + SCALPS_SPEC.md before touching anything.

## What this is

A verified quant platform (EC2 51.20.92.202:8765, branch `claude/read-j5hgnf`)
that mechanizes the 5 SMB scalps from `trades_.pdf` EXACTLY as written and
validates them one at a time on the R1 register (the screener's frozen per-day
shortlist — survivorship-bias-free; exists from ~2026-07-01, ~7-8 symbols/day).
The PDF is a **1-minute playbook** — always backtest on 1m (5m gave 0 trades).

- `qp/` — verified primitives library (frozen but extendable WITH tests).
- `chart/` — strategy engine (`strategy.py::evaluate`), seeds
  (`seeds/scalps.json`), backtest (`backtest.py`), screener client, alerts,
  UI (`static/index.html`), tests (`tests/run_all.py`, 24 parts, must be ALL
  GREEN before every commit).
- `SCALPS_SPEC.md` — THE derivation document: per-scalp logic from the PDF,
  mechanization map, provenance of every number, validation log. Update it
  with every change; it is the memory.

## Operating loop (the user drives the server; sessions cannot reach it)

1. Assistant edits code → suite green → commit + push to `claude/read-j5hgnf`.
2. User deploys: `ssh ec2 'cd Tade-desk-server && git fetch origin
   claude/read-j5hgnf && git reset --hard origin/claude/read-j5hgnf && sudo
   systemctl restart qp-chart'`.
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

## Open queue (in order)

1. Second Chance: user runs with **min RVOL = 5** → judge vs sheet
   (50-55%, 1.9:1). On In-Play names #131 already reads 46.8%/1.77:1.
2. HitchHiker validation pass: apply exit fidelity (freeze + runner scope)
   with its own backtest evidence; window now 930-1030.
3. Known SC loser classes for forward OOS: spike-top chases (LHAI 11:57,
   rising ladder — book's "over-extension" factor); per-level 2-strikes
   (cap currently spends attempts on unrelated levels).
4. Universe decision (user's): tighten R1 criteria to In-Play once the
   honest-RVOL run confirms the 4-run directional split.
5. Premarket-inclusive RVOL definition — only with named evidence.
6. Phase 5: trading-tool bridge (INTEGRATION.md).

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
- Short responses. Lead with the verdict.
