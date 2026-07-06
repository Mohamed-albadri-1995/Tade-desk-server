"""SetupEngine (spec 3.3).

Executes the sandboxed setup script (which must define a
``SetupIndicator`` class) and evaluates it. Keeps the script instance
alive between evaluations; re-instantiates only when the script text
changes.
"""

import logging
from datetime import datetime
from typing import Dict, Optional, Tuple

from app.models import SetupModel
from app.services.market_proxy import MarketDataProxy
from app.services.sandbox import SandboxError, instantiate

logger = logging.getLogger(__name__)


class SetupEngine:
    def __init__(self, market_data: MarketDataProxy):
        self.market_data = market_data
        self._instances: Dict[int, Tuple[str, object]] = {}  # setup_id -> (script, instance)

    def _get_instance(self, setup: SetupModel):
        cached = self._instances.get(setup.id)
        if cached and cached[0] == setup.script_content:
            return cached[1]
        instance = instantiate(setup.script_content, "SetupIndicator")
        self._instances[setup.id] = (setup.script_content, instance)
        return instance

    def invalidate(self, setup_id: int) -> None:
        self._instances.pop(setup_id, None)

    def evaluate(self, stock: str, setup: SetupModel, timestamp: datetime) -> Dict:
        """Returns mandatory_results, signal_side (or None), sl_tp, entry_params."""
        result = {
            "mandatory_results": {},
            "signal_side": None,
            "sl_tp": None,
            "entry_params": None,
            "error": None,
        }
        try:
            instance = self._get_instance(setup)
            result["mandatory_results"] = instance.evaluate_mandatory(
                stock, timestamp, self.market_data
            ) or {}
            signal_side = instance.check_signal(stock, timestamp, self.market_data)
            result["signal_side"] = signal_side
            if signal_side is not None:
                result["sl_tp"] = instance.get_sl_tp(stock, timestamp, self.market_data)
                result["entry_params"] = instance.get_entry_params()
        except (SandboxError, Exception) as exc:
            logger.warning("setup %s evaluation failed for %s: %s", setup.id, stock, exc)
            result["error"] = str(exc)
        return result

    def get_mandatory_conditions(self, setup: SetupModel) -> list:
        try:
            return list(self._get_instance(setup).get_mandatory_conditions() or [])
        except Exception as exc:
            logger.warning("get_mandatory_conditions failed for setup %s: %s", setup.id, exc)
            return list(setup.mandatory_conditions or [])
