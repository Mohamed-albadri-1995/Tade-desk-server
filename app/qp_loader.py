"""Load the VERIFIED qp library (quant-platform) when available.

Per quant-platform/INTEGRATION.md §4: the verified library must win the
``qp`` name over the trading tool's placeholder package. This module is
imported by ``app/__init__.py`` so it runs before anything else imports
``qp``. Search order:

1. ``QP_PATH`` env var (set it in .env on the server)
2. ``<repo root>/quant-platform`` (after the branches merge)
3. ``~/Tade-desk-server/quant-platform`` (the screener/qp checkout)

If none is found (or pandas is missing) the tool falls back to the
built-in placeholder primitives and says so loudly — placeholder math
is NOT TradingView-verified.
"""

import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

VERIFIED = False
QP_DIR = None


def _purge_qp_modules() -> None:
    for name in [m for m in list(sys.modules) if m == "qp" or m.startswith("qp.")]:
        del sys.modules[name]


def _candidates():
    """Source of the verified qp library.

    If QP_PATH is set it is AUTHORITATIVE (reference mode) — the only
    source tried, so a change in that shared checkout reflects here and a
    broken library fails loudly instead of silently falling back to a
    stale copy. If QP_PATH is unset, use the vendored copy in the repo
    (pinned mode), then the sibling screener checkout as a last resort.
    """
    env = os.getenv("QP_PATH", "").strip()
    if env:
        return [Path(env).expanduser()], "reference"
    repo_root = Path(__file__).resolve().parents[1]
    return [repo_root / "quant-platform",
            Path.home() / "Tade-desk-server" / "quant-platform"], "vendored"


def load() -> bool:
    global VERIFIED, QP_DIR
    if VERIFIED:
        return True
    candidates, mode = _candidates()
    for candidate in candidates:
        if not (candidate / "qp" / "registry.py").exists():
            continue
        sys.path.insert(0, str(candidate))
        _purge_qp_modules()
        try:
            import qp  # noqa: F401

            if not hasattr(qp, "approved_primitives"):
                raise ImportError("wrong qp package resolved (placeholder?)")
            VERIFIED = True
            QP_DIR = candidate
            logger.info(
                "VERIFIED qp library loaded from %s (%s mode) — %d approved primitives",
                candidate, mode, len(qp.approved_primitives()),
            )
            return True
        except Exception as exc:
            logger.warning("could not load verified qp from %s: %s", candidate, exc)
            if str(candidate) in sys.path:
                sys.path.remove(str(candidate))
            _purge_qp_modules()
    # Fail hard: unverified/absent indicator math must never run a live
    # trade (INTEGRATION.md §8.2). In reference mode this also means a
    # broken QP_PATH library stops the tool rather than trading on a
    # stale copy.
    if mode == "reference":
        raise RuntimeError(
            f"QP_PATH is set but the verified qp library there failed to load "
            f"({os.getenv('QP_PATH')}). Fix the library or unset QP_PATH to use "
            "the vendored copy. Refusing to trade on unverified math."
        )
    raise RuntimeError(
        "verified qp library not found — expected quant-platform/ in the repo "
        "or QP_PATH set in .env. Run: git checkout origin/claude/read-j5hgnf -- "
        "quant-platform && pip install -r quant-platform/requirements.txt"
    )


load()
