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
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

# LOAD THE SAME ENVIRONMENT THE SERVICE RUNS IN, and this is not a nicety.
#
# qp runs under systemd with `EnvironmentFile=~/trade-desk.env`. A shell does
# not, so the first live run of this reported polygon and alpaca as DOWN with
# "API key must be set" — about the SHELL's environment, while the service
# beside it had the keys and was working.
#
# A health check that reports a different environment from the one that
# actually runs is worse than no health check: it is a red light for a green
# system, and the next real failure is the one nobody believes.
_LOADED = []
for _f in (pathlib.Path.home() / 'trade-desk.env',
           pathlib.Path(__file__).resolve().parents[2] / '.env'):
    try:
        if not _f.exists():
            continue
        for _line in _f.read_text().splitlines():
            _line = _line.strip()
            if not _line or _line.startswith('#') or '=' not in _line:
                continue
            _k, _v = _line.split('=', 1)
            _k = _k.strip().removeprefix('export ').strip()
            _v = _v.strip().strip('"').strip("'")
            # Anything already exported WINS: running with a key on the command
            # line has to keep working, and this is a fallback not an override.
            os.environ.setdefault(_k, _v)
        _LOADED.append(str(_f))
    except Exception:                                          # noqa: BLE001
        pass

from chart import datacheck as dc                              # noqa: E402

MARK = {'ok': 'ok  ', 'degraded': 'WARN', 'down': 'DOWN'}

symbol = sys.argv[1] if len(sys.argv) > 1 else 'SPY'
print(f'Checking every data source against {symbol}…')
if _LOADED:
    print(f'environment from: {", ".join(_LOADED)}')
else:
    # Said out loud, because without it every keyed feed reports DOWN for a
    # reason that has nothing to do with the feed.
    print('WARNING: no environment file found (~/trade-desk.env). Any feed that '
          'needs a key will report DOWN because this shell has no keys, not '
          'because the feed is broken.')
print()
r = dc.run_all(symbol)

for c in r['checks']:
    print(f"[{MARK.get(c.get('severity'), '????')}] {c.get('name', '?'):38s} "
          f"{c.get('detail', '')}")
    if c.get('fix'):
        print(f"{'':7s}{'':38s} → {c['fix']}")

print()
print(f"{r['passed']}/{r['total']} sources returned usable data")
if r['degraded']:
    print(f"{r['degraded']} degraded — working, but worth looking at")
if r['down']:
    print(f"{r['down']} DOWN")
print(f"took {r['ms'] / 1000:.1f}s")
sys.exit(1 if r['down'] else 0)
