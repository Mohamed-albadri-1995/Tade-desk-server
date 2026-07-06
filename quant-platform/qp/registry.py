"""
Primitive registry.

@primitive is the single doorway into qp. A function that doesn't wear
the decorator isn't in the library — the compare tool won't see it, the
trading server can't call it, user scripts get a clean AttributeError.

The registry keeps three facts per primitive:
    - metadata (name, group, description, params, inputs)
    - the callable itself
    - the source file path (so the compare tool can say "edit
      qp/primitives/ma.py line 12")

Approvals are read from `approvals/approvals.json` at import time.
Editing the JSON is a git-tracked change — an approval is a promise to
future callers that this primitive matches TradingView bar-for-bar.
"""

from __future__ import annotations

import inspect
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

_APPROVALS_PATH = Path(__file__).resolve().parents[1] / 'approvals' / 'approvals.json'


@dataclass(frozen=True)
class Param:
    name: str
    kind: str = 'int'      # 'int' | 'float' | 'str' | 'bool'
    default: Any = None
    min: Optional[float] = None
    max: Optional[float] = None
    description: str = ''


@dataclass
class PrimitiveMeta:
    key: str               # unique — 'ma.sma', 'vwap.session', etc.
    name: str              # short human label
    group: str             # 'ma' | 'vwap' | 'volatility' | ...
    description: str
    params: tuple          # tuple[Param, ...]
    inputs: tuple          # tuple[str, ...] — e.g. ('source',), ('bars',)
    fn: Callable
    module: str
    file: str
    lineno: int


REGISTRY: dict[str, PrimitiveMeta] = {}

# Short-name → key. Short names must be globally unique (not just unique
# within a group) because the trading tool exposes each approved primitive
# as `market_data.<name>()` — a collision there would silently shadow one
# primitive with another.
_NAME_TO_KEY: dict[str, str] = {}


def primitive(
    *,
    name: str,
    group: str,
    description: str = '',
    params: tuple = (),
    inputs: tuple = ('bars',),
) -> Callable:
    """Register a function as a qp primitive.

    Example:
        @primitive(
            name='sma', group='ma',
            description='Simple moving average of `source` over `length` bars.',
            params=(Param('length', 'int', default=9, min=1),),
            inputs=('source',),
        )
        def sma(source, length): ...
    """
    def _decorate(fn: Callable) -> Callable:
        key = f'{group}.{name}'
        if key in REGISTRY:
            raise RuntimeError(
                f'duplicate primitive key {key!r} — already registered at '
                f'{REGISTRY[key].file}:{REGISTRY[key].lineno}'
            )
        if name in _NAME_TO_KEY:
            other = REGISTRY[_NAME_TO_KEY[name]]
            raise RuntimeError(
                f'primitive short name {name!r} already used by '
                f'{other.key} ({other.file}:{other.lineno}) — short names '
                f'must be globally unique because the trading tool exposes '
                f'them as market_data.{name}()'
            )
        try:
            src_file = inspect.getsourcefile(fn) or ''
            _, lineno = inspect.getsourcelines(fn)
        except (OSError, TypeError):
            src_file, lineno = '', 0
        REGISTRY[key] = PrimitiveMeta(
            key=key, name=name, group=group, description=description,
            params=tuple(params), inputs=tuple(inputs), fn=fn,
            module=fn.__module__, file=src_file, lineno=lineno,
        )
        _NAME_TO_KEY[name] = key
        fn._qp_key = key  # convenience for inspection
        return fn
    return _decorate


def _load_approvals() -> dict[str, dict]:
    if not _APPROVALS_PATH.exists():
        return {}
    try:
        with open(_APPROVALS_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


_APPROVALS: dict[str, dict] = _load_approvals()


def get_approval(key: str) -> Optional[dict]:
    """Return the approval record for a primitive key, or None if
    unapproved."""
    return _APPROVALS.get(key)


def is_approved(key: str) -> bool:
    return key in _APPROVALS


def approved_primitives() -> dict[str, PrimitiveMeta]:
    """Return only the approved slice of REGISTRY. Used by the trading tool
    to build sandbox `market_data` methods — v11 §8 rule: no unapproved
    indicator reaches a live setup script."""
    return {k: m for k, m in REGISTRY.items() if k in _APPROVALS}


def refresh_approvals() -> None:
    """Re-read approvals.json — the compare tool calls this after it
    writes a new approval so subsequent /primitives calls see it."""
    global _APPROVALS
    _APPROVALS = _load_approvals()


def save_approval(key: str, *, approved_by: str, notes: str = '',
                  git_sha: str = '') -> None:
    """Write a new approval to disk. Compare tool uses this from the
    Approve button."""
    if key not in REGISTRY:
        raise KeyError(f'unknown primitive {key!r}')
    _APPROVALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    approvals = _load_approvals()
    from datetime import datetime, timezone
    approvals[key] = {
        'approved_by': approved_by,
        'approved_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'git_sha':     git_sha,
        'notes':       notes,
    }
    with open(_APPROVALS_PATH, 'w') as f:
        json.dump(approvals, f, indent=2, sort_keys=True)
        f.write('\n')
    refresh_approvals()
