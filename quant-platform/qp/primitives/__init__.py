"""
Auto-import every primitives module so `@primitive` decorators fire on
first `import qp`. Modules listed here are also the compare tool's
groups (dropdown labels come from the group= arg of each decorator).

Add a new module → list it here → the compare tool sees its primitives
on next reload. No other wiring.
"""

from qp.primitives import bars  # dataclass, always first
from qp.primitives import ma    # ma.sma is the seed primitive
