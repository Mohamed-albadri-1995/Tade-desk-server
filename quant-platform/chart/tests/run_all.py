"""Run the full strategy-engine audit suite (hand-computed expected results).

Usage:  python3 chart/tests/run_all.py        (from quant-platform/)

Each part is a standalone script that exits non-zero on any failure. The suite
is the regression gate for the strategy engine: run it after ANY change to
chart/strategy.py, chart/store.py, or the qp glue before deploying.
"""
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
PARTS = [
    ('logic_audit.py',      'operators, groups, THEN, bounce, slope, SL/TP pairing'),
    ('logic_audit2.py',     'pct ops, cross+hold, anchored SL/TP, slope v2'),
    ('logic_audit3.py',     'bounce v3 attack cases, status pairing, volume composition'),
    ('logic_audit4.py',     "rule-level signal offset ('ago')"),
    ('level_view_audit.py', 'SL/TP level views (what gets drawn)'),
    ('logic_audit6.py',     'pct negative refs, k clamp, unprotected-entry skip, open trade'),
    ('logic_audit7.py',     'Trade operand (P&L / bars / entry), expr-anchored SL'),
    ('logic_audit8.py',     'SL/TP/exit can never fire before entry'),
    ('e2e_expr.py',         'end-to-end through evaluate() with a stub feed'),
]

failed = []
for name, what in PARTS:
    r = subprocess.run([sys.executable, str(HERE / name)],
                       capture_output=True, text=True)
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
