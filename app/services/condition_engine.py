"""ConditionEngine (spec 3.4).

Executes sandboxed condition scripts (``ConditionCheck`` classes).
``get_raw_display`` is optional on the script; ``evaluate_alignment``
calls the script's ``evaluate()``.
"""

import logging
from datetime import datetime
from typing import Dict, Optional, Tuple

from app.models import ConditionModel
from app.services.market_proxy import MarketDataProxy
from app.services.sandbox import instantiate

logger = logging.getLogger(__name__)


class ConditionEngine:
    def __init__(self, market_data: MarketDataProxy):
        self.market_data = market_data
        self._instances: Dict[int, Tuple[str, object]] = {}

    def _get_instance(self, condition: ConditionModel):
        cached = self._instances.get(condition.id)
        if cached and cached[0] == condition.script_content:
            return cached[1]
        instance = instantiate(condition.script_content, "ConditionCheck")
        self._instances[condition.id] = (condition.script_content, instance)
        return instance

    def invalidate(self, condition_id: int) -> None:
        self._instances.pop(condition_id, None)

    def get_raw_display(self, condition: ConditionModel, stock: str, timestamp: datetime) -> dict:
        try:
            instance = self._get_instance(condition)
            raw_display = None
            # getattr is fine here — this is engine code, not sandboxed script code.
            fn = getattr(instance, "get_raw_display", None)
            if callable(fn):
                raw_display = fn(stock, timestamp, self.market_data)
            return raw_display or {}
        except Exception as exc:
            logger.warning("raw display failed for condition %s/%s: %s", condition.id, stock, exc)
            return {"error": str(exc)}

    def evaluate_alignment(
        self, condition: ConditionModel, stock: str, timestamp: datetime, signal_side: str
    ) -> bool:
        try:
            instance = self._get_instance(condition)
            return bool(instance.evaluate(signal_side, stock, timestamp, self.market_data))
        except Exception as exc:
            logger.warning("alignment failed for condition %s/%s: %s", condition.id, stock, exc)
            return False

    def get_name(self, condition: ConditionModel) -> str:
        try:
            return str(self._get_instance(condition).get_name())
        except Exception:
            return condition.name
