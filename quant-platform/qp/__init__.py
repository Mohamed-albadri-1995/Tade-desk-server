"""
qp — verified primitives library.

One rule: no math outside `qp/primitives/`. Every exported function
in a primitives module is `@primitive`-decorated so the compare tool
knows about it. Everything downstream (compare tool, trading server's
market_data, backtests, user scripts) calls into the same registry.

Add a primitive → verify it in the compare tool → approve. Approvals
live in `approvals/approvals.json` and are git-tracked. Callers of an
unapproved primitive get a red "🚧" badge in the UI so you always
know what's verified vs. draft.
"""

from qp.registry import primitive, REGISTRY, get_approval, is_approved

# Import every primitives module so the decorators register.
from qp import primitives as _primitives  # noqa: F401

__all__ = ['primitive', 'REGISTRY', 'get_approval', 'is_approved']
