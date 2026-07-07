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
    env = os.getenv("QP_PATH", "").strip()
    if env:
        yield Path(env).expanduser()
    repo_root = Path(__file__).resolve().parents[1]
    yield repo_root / "quant-platform"
    yield Path.home() / "Tade-desk-server" / "quant-platform"


def load() -> bool:
    global VERIFIED, QP_DIR
    if VERIFIED:
        return True
    for candidate in _candidates():
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
                "VERIFIED qp library loaded from %s — %d approved primitives",
                candidate, len(qp.approved_primitives()),
            )
            return True
        except Exception as exc:
            logger.warning("could not load verified qp from %s: %s", candidate, exc)
            if str(candidate) in sys.path:
                sys.path.remove(str(candidate))
            _purge_qp_modules()
    logger.warning(
        "verified qp library not found — falling back to the built-in "
        "PLACEHOLDER primitives (not TradingView-verified). Set QP_PATH "
        "in .env to the quant-platform directory."
    )
    return False


load()
