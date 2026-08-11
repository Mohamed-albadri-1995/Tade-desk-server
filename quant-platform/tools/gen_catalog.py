"""
Generate docs/CATALOG.md from the live registry.

Run from quant-platform/:
    python3 tools/gen_catalog.py

The catalog is generated, never hand-edited — it cannot drift from the
code. Re-run after adding primitives and commit the result.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qp  # noqa: E402
from qp.registry import REGISTRY, is_approved  # noqa: E402


def _param_str(p) -> str:
    s = f'`{p.name}`: {p.kind}'
    if p.default is not None:
        s += f' = {p.default!r}' if p.kind == 'str' else f' = {p.default}'
    lims = []
    if p.min is not None: lims.append(f'min {p.min:g}')
    if p.max is not None: lims.append(f'max {p.max:g}')
    if lims: s += f' ({", ".join(lims)})'
    return s


def main() -> None:
    lines = []
    w = lines.append
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    n_appr = sum(1 for k in REGISTRY if is_approved(k))
    w('# qp primitive catalog')
    w('')
    w(f'Generated from the registry by `tools/gen_catalog.py` — do not edit by hand.')
    w(f'')
    w(f'**{len(REGISTRY)} primitives · {n_appr} approved** (as of {now}).')
    w('Approval status changes as verification progresses; the source of truth')
    w('is `approvals/approvals.json`, queried at runtime via `qp.approved_primitives()`.')
    w('')
    w('Conventions:')
    w('- **input `source`** — takes a 1-D float array (pick close/open/high/low/')
    w('  hl2/hlc3/ohlc4/volume/body_high/body_low); **input `bars`** — takes a')
    w('  `qp.Bars` (validated OHLCV DataFrame).')
    w('- **output `value`** — returns one `np.ndarray` aligned to the input bars;')
    w('  anything else — returns `dict[str, np.ndarray]` with those keys.')
    w('- NaN marks warm-up bars and bars where the value is undefined')
    w('  (outside session, before an anchor, level not yet known).')
    w('')

    groups: dict[str, list] = {}
    for key in sorted(REGISTRY):
        m = REGISTRY[key]
        groups.setdefault(m.group, []).append(m)

    for g in sorted(groups):
        w(f'## {g}')
        w('')
        for m in groups[g]:
            badge = '✅' if is_approved(m.key) else '🚧'
            w(f'### {badge} `{m.key}`')
            w('')
            w(m.description)
            w('')
            w(f'- input: `{", ".join(m.inputs)}`')
            if m.outputs == ('value',):
                w('- output: single series')
            else:
                w(f'- output: dict with keys `{", ".join(m.outputs)}`')
            if m.params:
                w('- params: ' + ' · '.join(_param_str(p) for p in m.params))
            else:
                w('- params: none')
            w('')

    out_path = Path(__file__).resolve().parents[1] / 'docs' / 'CATALOG.md'
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines) + '\n')
    print(f'wrote {out_path} ({len(REGISTRY)} primitives, {n_appr} approved)')


if __name__ == '__main__':
    main()
