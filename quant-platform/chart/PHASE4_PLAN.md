# Phase 4 — Backtest Engine: PLAN + LIVE PROGRESS

**Read this first if you are resuming this work (any model, any session).**
Update the checkboxes + "STATE" line after EVERY step. One commit per step.

## STATE: Steps 1-2 done. Next: Step 3 (store tables).

## Context (30-second version)
- The platform: verified `qp` primitives → chart server (`chart/server.py`, box
  port 8765) → declarative strategy JSON built in the UI → evaluated by
  `chart/strategy.py::evaluate()` (the ONLY evaluator — preview, backtest, and
  the trading tool all run the same JSON through it; no conversion, ever).
- Screener (Node, box port 3000) freezes **R1** (all scanned tickers, 9:36 ET
  snapshot) and **Shortlist** (picks) per date; `chart/screener.py` reads them
  over HTTP (`SCREENER_URL`). `asof=YYYY-MM-DD` in `prepare_bars` replays any
  past day.
- Regression gate: `python3 chart/tests/run_all.py` (139+ hand-computed cases).
  MUST be green before every commit. qp library is FROZEN — never touch it.
- Deploy: box tracks `claude/read-j5hgnf`. `git fetch && git checkout
  claude/read-j5hgnf && git reset --hard origin/claude/read-j5hgnf` + restart
  `qp-chart` (systemd) — see PROGRESS.md It.20 area for the full command.

## Goal
Run a SAVED strategy over historical data — a fixed symbol list OR the
screener's frozen registers (per-date membership) — using the same
`evaluate()` math, producing per-trade results + summary + equity curve,
stored in SQLite, browsable in the chart UI, each trade clickable to replay
that chart as-of its day.

## Design decisions (already made — do not relitigate)
1. **No conversion**: the backtester calls `chart/strategy.py` internals
   directly (same process). Universe/date iteration lives in a new
   `chart/backtest.py`.
2. **Day-slice honesty**: evaluating with `asof=D` returns a window ending at
   D (with warm-up days before it). Only trades whose ENTRY bar falls on the
   ET date D count for day D — warm-up-day signals are context, not trades.
3. **Register membership is per-day**: on day D you may only trade tickers on
   the chosen register FOR day D (that is the whole point of frozen registers).
4. **Fill model is explicit**: `fill='close'` (signal bar close — matches the
   chart preview) or `fill='next_open'` (honest live assumption). Applies to
   entries and exit-RULE exits; SL/TP always fill intrabar AT the level.
5. **SL priority protocol unchanged**: SL → TP → exit rule; entry bar exempt;
   never before entry; unpriceable SL ⇒ skip entry (see tests part 8).
6. **Small box**: t3.micro + swap. Sequential runs, one backtest at a time,
   per-run in-memory bar cache keyed (symbol, tf). No parallelism.
7. **Stats in % returns** (same as preview): win rate, avg/total return,
   exits-by-reason, max drawdown of the cumulative curve, equity curve points.
   Position sizing/R-multiples belong to the trading tool's sizer, not here.

## Steps (one commit each; check off + update STATE when done)
- [x] **1. This plan doc** — commit `chart/PHASE4_PLAN.md`.
- [x] **2. Fill model in the engine** — `_pair_trades(..., fill='close'|'next_open')`:
      entry price = next bar's open (entry signal on bar j ⇒ position starts
      at j+1's open; SL/TP checks then start at j+1 too, using that entry
      price for fixed distances); exit-rule fills at next open likewise; SL/TP
      unchanged (intrabar at level). `evaluate()` passes it through
      (`strategy` dict stays pure — fill is a call arg, default 'close').
      Hand-computed tests: logic_audit9.py (entry px, SL distance re-anchored,
      last-bar signal ⇒ no trade, next_open vs close divergence).
- [ ] **3. Store: backtest tables** — `chart/store.py`: `backtests`
      (id, name, spec TEXT, status running|done|error, progress REAL,
      summary TEXT, error TEXT, created_at, updated_at) and `backtest_trades`
      (id, bt_id, date, symbol, side, entry_ts, exit_ts, entry, exit, ret,
      reason). CRUD: create_backtest, update_backtest, add_bt_trades,
      get_backtest(+trades), list_backtests, delete_backtest. Tests: store
      roundtrip in tests (tmp db, same pattern as logic_audit6 part 5).
- [ ] **4. Runner core** — `chart/backtest.py::run(spec, progress_cb=None)`:
      spec = {name, strategy (inline dict) OR strategy_id, universe:
      {kind:'symbols', symbols:[...]} , start, end (YYYY-MM-DD, ET dates),
      tf, feed, view, fill}. For each trading day D in [start,end] (skip
      weekends; a day with no bars just yields nothing), for each symbol:
      evaluate day-sliced trades (decision 2), collect, aggregate summary
      (decision 7). Per-run bar cache: monkeypatch-free — pass a dict cache
      into a thin wrapper around cs.prepare_bars (cache key symbol|tf|window
      derived from asof+days; MVP may skip caching if correctness first).
      Tests: stub loader (reuse e2e_expr.py pattern) with a deterministic
      strategy ⇒ hand-count trades across 2 symbols × 3 days; day-slice test
      (a signal on warm-up day D-1 must NOT create a day-D trade).
- [ ] **5. Register universe** — universe {kind:'register',
      register:'R1'|'Shortlist'}: dates from `screener.available_dates()`
      ∩ [start,end]; per-date tickers from `screener.register_rows(reg, D)`.
      Graceful: screener down ⇒ error status with clear message. Test with a
      monkeypatched screener module.
- [ ] **6. API** — `chart/server.py`: POST /api/backtest (validates spec,
      rejects if one already running, spawns daemon thread, returns id),
      GET /api/backtest/{id} (status+progress+summary+trades),
      GET /api/backtests, DELETE /api/backtest/{id}. Progress = fraction of
      (day,symbol) pairs done, written to store every few pairs.
- [ ] **7. UI** — new "🧪 Backtest" section (side panel, under the register
      browser): saved-strategy picker, universe toggle (Symbols text input /
      Register+range), start+end dates, tf, fill selector, Run button,
      progress bar (poll GET every 2s while running), then: summary line
      (trades, win%, total%, maxDD, exits-by), equity curve drawn in the osc
      pane (reuse drawStratSeries with a step:false series), trades table
      (date, sym, side, entry→exit, ret%, reason) — clicking a row sets
      symbol+asof and loads that chart so the trade is inspectable.
- [ ] **8. Final pass** — full `run_all.py` + new tests green; headless UI
      smoke (run a stub backtest end-to-end through the API); PROGRESS.md
      iteration entry; README section; deploy command for the user.

## Verification protocol (every step)
1. `cd quant-platform && python3 chart/tests/run_all.py` → ALL GREEN.
2. New behavior gets hand-computed cases in `chart/tests/` (same style).
3. UI steps: headless Chromium (`/opt/pw-browsers/chromium`) smoke — no JS
   errors, feature visibly works (screenshot when it matters).
4. Commit message explains WHAT + WHY; push `claude/read-j5hgnf`; update this
   file's checkboxes + STATE line in the same commit.
