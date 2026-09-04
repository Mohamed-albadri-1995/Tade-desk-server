"""The control strategy: a rule that must fire on every bar that exists.

WHY THERE IS A CONTROL AT ALL.

`OR + VWAP 09:35` takes nothing, and there are two entirely different reasons
for that — the CHAIN is broken (qp did not answer, the feed is behind, no cards
arrived) or the RULES did not match. From the outside both produce the same
sentence, "nothing qualified", and nothing on the desk could tell them apart.

So the desk asks a second strategy the same question, on the same bar, over the
same cards, through the same feed, with an entry rule that is true of every bar
that exists: `close > 0`. If the control fires and the setup does not, the chain
works and it is the rules. If neither fires, it is the chain — and the reason
comes with it.

That argument only holds if the control really does fire on every bar. This
drives the SHIPPED definition — imported from src/setups/canary.js rather than
restated here, so the two cannot drift — over a crafted 1-minute frame.

THE TRAP THIS EXISTS FOR: entry_mode. The default is 'edge', which fires once
per contiguous true-RUN. A rule that is always true is ONE run, so edge mode
produces exactly one signal — at the first bar of the day — and nothing
afterwards. A control like that would report "did not fire" on every bar after
09:30 and read as a permanently broken desk. Level mode fires on every bar the
mask is true, which is what a control needs.
"""
import sys
import pathlib
import re
import json
import subprocess

import pandas as pd

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import tools.compare_server as cs                                    # noqa: E402
import chart.strategy as S                                           # noqa: E402
from chart import decide as dec                                      # noqa: E402

PASS = 0
FAIL = 0


def ok(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {extra}")


# ── the shipped definition, read out of the desk's own source ──────────────
#
# A copy of the spec here would pass this audit for ever while the desk shipped
# something else — so it is loaded from the module, through node, as the value
# the desk actually sends to qp. Not a transcription of it, and not a parse of
# the source text either: the object itself.
SPEC_JS = (pathlib.Path(__file__).resolve().parents[3]
           / 'src' / 'setups' / 'canary.js')
_out = subprocess.run(
    ['node', '-e',
     f'process.stdout.write(JSON.stringify(require({str(SPEC_JS)!r}).SPEC))'],
    capture_output=True, text=True)
ok("the desk's own control spec can be read, as the value it actually ships",
   _out.returncode == 0 and _out.stdout.strip().startswith('{'),
   (_out.stderr or '').strip()[:200])
SPEC = json.loads(_out.stdout)

ok("the entry rule is close > 0 — true of every bar that exists",
   SPEC['entry']['rules'] == [{'left': {'kind': 'price', 'field': 'close'},
                               'op': 'gt',
                               'right': {'kind': 'const', 'value': 0}}],
   json.dumps(SPEC['entry']['rules']))

ok("entry_mode is 'level', NOT the default 'edge'",
   SPEC['risk'].get('entry_mode') == 'level',
   f"got {SPEC['risk'].get('entry_mode')!r}")

ok("it carries a stop, so a pick has a real entry/stop/target",
   SPEC['risk']['sl']['type'] == 'pct' and SPEC['risk']['sl']['value'] > 0)

ok("the window spans premarket to the close — a control answers whenever the "
   "desk asks", (SPEC['risk']['window_start'], SPEC['risk']['window_end'])
   == (400, 1600))


# ── a 1-minute frame with nothing special about it ─────────────────────────
_ET = 'America/New_York'


def bars1m(n, day, start='09:30', px=10.0):
    idx = [pd.Timestamp(f'{day} {start}', tz=_ET) + pd.Timedelta(minutes=i)
           for i in range(n)]
    return pd.DataFrame(
        {'open': [px] * n, 'high': [px + .1] * n, 'low': [px - .1] * n,
         'close': [px + (i % 3) * 0.01 for i in range(n)],
         'volume': [1e5] * n},
        index=pd.DatetimeIndex(idx).tz_convert('UTC'))


FULL = pd.concat([bars1m(60, '2024-01-08'), bars1m(60, '2024-01-09')])


class Stub:
    def load(self, sym, tf, start, end):
        return FULL[(FULL.index >= start) & (FULL.index < end)]


cs._LOADERS['control'] = Stub()


def run(spec):
    return S.evaluate(json.loads(json.dumps(spec)), 'X', '1m', 2,
                      feed='control', view='all', asof='2024-01-09', fill='live')


r = run(SPEC)
ok("the spec is valid and evaluates", r.get('ok') and r.get('bars'),
   str(r.get('error') or ''))

trades = r.get('trades') or []
ok("it opens a position on EVERY bar of the day — 60 bars, 60 trades",
   len(trades) == 60, f"got {len(trades)}")

# ── the trap, demonstrated rather than described ───────────────────────────
edge = json.loads(json.dumps(SPEC))
edge['risk']['entry_mode'] = 'edge'
re_ = run(edge)
ok("EDGE MODE would fire once for the whole day — the bug this spec avoids",
   len(re_.get('trades') or []) == 1, f"got {len(re_.get('trades') or [])}")

# ── what the desk actually receives ────────────────────────────────────────
out = dec.decide([SPEC], ['AAA'], '2024-01-09', tf='1m', feed='control',
                 view='all', fill='live', top_n=0, target_r=2.0)
ok("decide() answers ok with the newest bar stamped",
   out.get('ok') and out.get('last_bar') == '10:29',
   f"last_bar={out.get('last_bar')!r}")

picks = out.get('picks') or []
ok("every pick carries an entry, a stop and a target — the desk sizes off "
   "these, so a control with no plan would prove less than it claims",
   bool(picks) and all(p.get('entry') and p.get('stop') and p.get('target')
                       for p in picks),
   json.dumps(picks[:1])[:200])

ok("every pick is stamped with the bar it fired on",
   all(re.match(r'^\d{2}:\d{2}$', str(p.get('entry_at') or '')) for p in picks))

# THE PROPERTY THE DESK RELIES ON: a pick within one minute of any bar of the
# session. The desk asks "did the control fire on THIS bar" and allows one bar
# of tolerance, exactly as it does for a real pick.
fired_at = {p['entry_at'] for p in picks}


def near(bar):
    h, m = (int(x) for x in bar.split(':'))
    want = h * 60 + m
    for at in fired_at:
        ah, am = (int(x) for x in at.split(':'))
        if abs(ah * 60 + am - want) <= 1:
            return True
    return False


ok("for every bar of the session there is a control signal within one minute",
   all(near(f"{9 + (30 + i) // 60:02d}:{(30 + i) % 60:02d}") for i in range(60)),
   f"fired on {len(fired_at)} of 60 bars")

# ── a bar that is not there produces no signal, which is the whole point ───
#
# If the feed is behind, the newest bar is older than the one the desk asked
# about — and the control must NOT fire on the bar it was asked about. A control
# that fired anyway would report a working chain off a fifteen-minute-old bar,
# which is the exact failure it was built to catch.
ok("no control signal exists after the newest bar the feed had",
   not near('10:45') and not near('11:30'),
   f"latest signal {max(fired_at) if fired_at else None}")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
