"""Sandboxed execution of raw Python scripts (spec section 8).

Raw scripts are stored as text and executed directly via ``exec()`` —
no conversion or interpretation. The execution namespace uses a
restricted set of built-ins:

* Allowed imports: ``typing``, ``datetime``, ``math``, ``collections``.
* Removed built-ins: ``open``, ``eval``, ``exec``, ``__import__``,
  ``compile``, ``globals``, ``locals``, ``getattr``, ``setattr``,
  ``delattr``.

Python's ``import`` statement requires a ``__import__`` hook; the raw
built-in is removed and replaced with a guarded importer that only
resolves the four allowed modules, so scripts cannot import anything
else.
"""

import builtins as _builtins
from typing import Any, Dict, Optional

ALLOWED_IMPORTS = {"typing", "datetime", "math", "collections"}

REMOVED_BUILTINS = {
    "open",
    "eval",
    "exec",
    "__import__",
    "compile",
    "globals",
    "locals",
    "getattr",
    "setattr",
    "delattr",
}


class SandboxError(Exception):
    """Raised when a script violates sandbox rules or fails to load."""


def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED_IMPORTS:
        raise ImportError(f"import of '{name}' is not allowed in the sandbox")
    return _builtins.__import__(name, globals, locals, fromlist, level)


def build_sandbox_builtins() -> Dict[str, Any]:
    safe: Dict[str, Any] = {}
    for name in dir(_builtins):
        if name.startswith("__") or name in REMOVED_BUILTINS:
            continue
        safe[name] = getattr(_builtins, name)
    safe["__import__"] = _guarded_import  # guarded replacement, whitelist-only
    safe["__build_class__"] = _builtins.__build_class__  # required for class statements
    safe["__name__"] = "sandbox"
    return safe


def execute_script(script_content: str, extra_globals: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Execute a raw script inside the sandbox and return its namespace."""
    namespace: Dict[str, Any] = {"__builtins__": build_sandbox_builtins()}
    if extra_globals:
        namespace.update(extra_globals)
    try:
        exec(script_content, namespace)  # noqa: S102 — spec-mandated raw exec
    except Exception as exc:  # surface script errors with context
        raise SandboxError(f"script execution failed: {exc}") from exc
    return namespace


def instantiate(script_content: str, class_name: str) -> Any:
    """Execute a script and instantiate the interface class it defines."""
    namespace = execute_script(script_content)
    cls = namespace.get(class_name)
    if cls is None:
        raise SandboxError(f"script does not define a '{class_name}' class")
    try:
        return cls()
    except Exception as exc:
        raise SandboxError(f"could not instantiate {class_name}: {exc}") from exc
