"""Run the LIVE data check and print it. Needs a network; not in the gate.

    python3 chart/tests/datacheck_live.py            (from quant-platform/)
    python3 chart/tests/datacheck_live.py QQQ

WHY THIS IS NOT IN run_all.py. That gate is offline and deterministic: every
part of it computes a known answer from data built by hand, so a failure means
the code changed. This asks the internet a question, and its answer changes
every day — putting it in the gate would make the gate fail for reasons that
are not regressions, which is how a gate stops being read.

The JUDGEMENT this uses is tested offline, in logic_audit53.py. That is the
part that can regress. This is the part that tells you about today.

Exit code is 1 if anything is DOWN, 0 if everything is ok or merely degraded —
so it can be a deploy step or a cron line without failing on a half-day.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from chart import datacheck as dc                              # noqa: E402

MARK = {'ok': 'ok  ', 'degraded': 'WARN', 'down': 'DOWN'}

symbol = sys.argv[1] if len(sys.argv) > 1 else 'SPY'
print(f'Checking every data source against {symbol}…\n')
r = dc.run_all(symbol)

for c in r['checks']:
    print(f"[{MARK.get(c.get('severity'), '????')}] {c.get('name', '?'):38s} "
          f"{c.get('detail', '')}")

print()
print(f"{r['passed']}/{r['total']} sources returned usable data")
if r['degraded']:
    print(f"{r['degraded']} degraded — working, but worth looking at")
if r['down']:
    print(f"{r['down']} DOWN")
print(f"took {r['ms'] / 1000:.1f}s")
sys.exit(1 if r['down'] else 0)
