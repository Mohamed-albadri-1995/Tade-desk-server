"""
Auto-import every module in this package so `@primitive` decorators fire on
first `import qp`. Drop a new file next to bars.py/ma.py, decorate a
function inside it, and the compare tool picks it up on next reload —
no wiring here.

Modules whose name starts with `_` are skipped (reserved for helpers).
"""

from __future__ import annotations

import importlib
import pkgutil

# `bars` first so other modules can `from qp.primitives.bars import Bars`
# without hitting a partially-initialised package.
from qp.primitives import bars  # noqa: F401

for _finder, _name, _ispkg in pkgutil.iter_modules(__path__):
    if _name in ('bars',) or _name.startswith('_'):
        continue
    importlib.import_module(f'{__name__}.{_name}')
