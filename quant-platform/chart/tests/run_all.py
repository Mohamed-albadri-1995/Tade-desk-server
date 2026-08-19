"""Run the full strategy-engine audit suite (hand-computed expected results).

Usage:  python3 chart/tests/run_all.py        (from quant-platform/)

Each part is a standalone script that exits non-zero on any failure. The suite
is the regression gate for the strategy engine: run it after ANY change to
chart/strategy.py, chart/store.py, or the qp glue before deploying.
"""
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
PARTS = [
    ('logic_audit.py',      'operators, groups, THEN, bounce, slope, SL/TP pairing'),
    ('logic_audit2.py',     'pct ops, cross+hold, anchored SL/TP, slope v3'),
    ('logic_audit3.py',     'bounce v3 attack cases, status pairing, volume composition'),
    ('logic_audit4.py',     "rule-level signal offset ('ago')"),
    ('level_view_audit.py', 'SL/TP level views (what gets drawn)'),
    ('logic_audit6.py',     'pct negative refs, k clamp, unprotected-entry skip, open trade'),
    ('logic_audit7.py',     'Trade operand (P&L / bars / entry), expr-anchored SL'),
    ('logic_audit8.py',     'SL/TP/exit can never fire before entry'),
    ('logic_audit9.py',     "fill model: 'close' preview vs 'next_open' honest live"),
    ('logic_audit10.py',    'backtest: store, runner, day-slice, register universe'),
    ('logic_audit11.py',    'backtest API lifecycle: start/poll/done, guards'),
    ('logic_audit12.py',    'Trade The Pool rules: session, fees, min-profit, one-position'),
    ('logic_audit13.py',    'Phase-1 foundation: higher-TF look-ahead (causal reindex)'),
    ('logic_audit14.py',    'Phase-1 foundation: asof replay boundary (no D+1 leak)'),
    ('logic_audit15.py',    'backtest coverage: no-data pairs counted, spec normalization'),
    ('logic_audit16.py',    'preview window honesty: warm-up outputs sliced (no ladders)'),
    ('logic_audit17.py',    'the 5 pro scalps (trades_.pdf) build + fire through evaluate()'),
    ('logic_audit18.py',    'scale-out: R-multiple + non-R legs, weighted return, TTP'),
    ('logic_audit19.py',    'entry discipline: attempts cap, cooldown, min-hold'),
    ('logic_audit20.py',    'SCALPS_SPEC gaps: cross-symbol market gate + today_vol_max'),
    ('logic_audit21.py',    'exit fidelity: frozen SL/TP anchors + runner-scoped exit rule'),
    ('logic_audit22.py',    'In-Play universe filter: honest SMB rvol (min_rvol) in the runner'),
    ('logic_audit23.py',    'live alerts: scan/dedupe/suppress, window gating, register union'),
    ('logic_audit24.py',    'PM Breakout (2m) seed: day gate + pm-high breakout + wick/body filter'),
    ('logic_audit25.py',    'real-account risk sizing: 0.5%/trade, compounding, leverage cap'),
    ('logic_audit26.py',    'user strategies survive deploys: restore-only seeds'),
    ('logic_audit27.py',    'Print R1 sheet: window, tickers, indicators, page'),
    ('logic_audit28.py',    'review pass: fees, portfolio capital cap, warm-up cap, alerts, print days'),
    ('logic_audit29.py',    'multi-source screeners: N scanning tools, merge, attribution, dead-source'),
    ('logic_audit30.py',    'warm-up sweep: every primitive gets the history it measurably needs'),
    ('logic_audit31.py',    'OR + session VWAP 09:35 setup: timing, gates, 2R half, VWAP trail'),
    ('logic_audit32.py',    'T2 10:00 VWAP-extension: direction, invalidation, stop-first, per-day rank'),
    ('logic_audit33.py',    'cross-tool integration: run() reaches _pairs, tool assignment survives'),
    ('logic_audit34.py',    'professional report: metrics vs hand arithmetic, journal, exports'),
    ('logic_audit35.py',    'strategies survive a deploy: DB outside the repo, user edits win, JSON copies'),
    ('logic_audit36.py',    'watchlist gate: no trade before the scanner found the stock'),
    ('logic_audit37.py',    'every headline metric against hand arithmetic'),
    ('logic_audit38.py',    'managing an open position: exit rules + the ratchet'),
    ('../exports/or_vwap_0935.py', 'standalone 09:35 reference implementation selftest'),
    ('e2e_expr.py',         'end-to-end through evaluate() with a stub feed'),
    # pytest-style parts, written by the scanner-tool side of this repo. They
    # are in the SAME gate on purpose: both live failures of 2026-08-10 came
    # from two sessions editing this repo, each green against the code it could
    # see. One gate is what makes that visible.
    ('test_setup_tools.py', 'a setup carries its tools, and backtests on their picks'),
    ('test_feeds.py',       'feed loaders: yahoo ceilings, registry, interval limits'),
    ('ui_runtime.js',       'browser UI: page script evaluates, click handlers run'),
]

def _has_pytest() -> bool:
    return subprocess.run([sys.executable, '-c', 'import pytest'],
                          capture_output=True).returncode == 0


failed = []
for name, what in PARTS:
    if name.startswith('test_'):                       # pytest-style part
        if not _has_pytest():
            print(f'[skip] {name:22s} {what}\n        pytest not installed '
                  f'(pip install pytest)')
            continue
        cmd = [sys.executable, '-m', 'pytest', '-q', str(HERE / name)]
    elif name.endswith('.py'):
        cmd = [sys.executable, str(HERE / name)]
    else:
        cmd = ['node', str(HERE / name)]
    if name.endswith('.js') and not shutil.which('node'):
        print(f'[skip] {name:22s} {what}\n        node not installed')
        continue
    r = subprocess.run(cmd, capture_output=True, text=True)
    tail = (r.stdout or '').strip().splitlines()
    verdict = tail[-1] if tail else '(no output)'
    status = 'ok ' if r.returncode == 0 else 'FAIL'
    print(f'[{status}] {name:22s} {what}\n        {verdict}')
    if r.returncode != 0:
        failed.append(name)
        print(r.stdout)
        print(r.stderr)

print('\n' + ('ALL GREEN' if not failed else f'FAILURES: {failed}'))
sys.exit(1 if failed else 0)
