"""GateEngine (spec 3.5, simplified per the Rebuild plan).

Primary gate: one allow/block toggle per market regime and side
(gate_regime_settings). The advanced JSON rules remain as a secondary
layer for users who need them. Both are cached in memory and refreshed
by the monitor loop, so ``is_allowed`` performs zero I/O at signal time.
"""

import logging
from typing import Dict, List, Tuple

from sqlalchemy import select

from app.database import async_session_factory
from app.models import GateRuleModel, RegimeGateModel
from app.services.screener_data import TickerContext

logger = logging.getLogger(__name__)


class GateEngine:
    def __init__(self, screener_cache: Dict[str, TickerContext], market_provider=None):
        self.screener_cache = screener_cache
        # Returns the screener's live /api/market/snapshot (or None). Its
        # regime is fresher than the per-row copy made at scan time, so it
        # overrides the row's regime for rule matching and sizing; the
        # row's own value is kept as row_regime for the audit trail.
        self._market_provider = market_provider
        self._rules: List[dict] = []
        self._regime_gates: Dict[str, dict] = {}  # regime_key -> {allow_long, allow_short}

    async def refresh_rules(self) -> None:
        async with async_session_factory() as session:
            gates = (await session.execute(select(RegimeGateModel))).scalars().all()
            self._regime_gates = {
                g.regime_key: {"allow_long": g.allow_long, "allow_short": g.allow_short}
                for g in gates
            }
            result = await session.execute(
                select(GateRuleModel).order_by(GateRuleModel.priority.desc(), GateRuleModel.id)
            )
            self._rules = [
                {
                    "id": r.id,
                    "rule_name": r.rule_name,
                    "condition": r.condition or {},
                    "side_allowed": r.side_allowed,
                    "priority": r.priority,
                }
                for r in result.scalars().all()
            ]

    @staticmethod
    def _matches(condition: dict, snapshot: dict) -> bool:
        raw = snapshot.get("raw") or {}
        raw_context = raw.get("context") if isinstance(raw.get("context"), dict) else {}
        for key, expected in (condition or {}).items():
            actual = snapshot.get(key)
            if actual is None:
                actual = raw_context.get(key)
            if actual is None:
                actual = raw.get(key)
            if actual != expected:
                return False
        return True

    def is_allowed(self, stock: str, side: str) -> Tuple[bool, dict]:
        context = self.screener_cache.get(stock.upper())
        snapshot = context.snapshot() if context else {"stock": stock.upper(), "missing": True}

        market = self._market_provider() if self._market_provider else None
        if market:
            snapshot["market"] = market
            snapshot["row_regime"] = snapshot.get("regime")
            if market.get("regime"):
                snapshot["regime"] = market["regime"]

        # Primary gate: the per-regime long/short toggle. Unknown regimes
        # (not yet in the table) default to allowed.
        regime = snapshot.get("regime")
        gate = self._regime_gates.get(str(regime)) if regime else None
        if gate is not None:
            allowed_for_side = gate["allow_long"] if side == "long" else gate["allow_short"]
            if not allowed_for_side:
                snapshot["gate_rule"] = f"regime:{regime} blocks {side}"
                return False, snapshot

        for rule in self._rules:  # already sorted by priority (highest first)
            if self._matches(rule["condition"], snapshot):
                side_allowed = rule["side_allowed"]
                allowed = side_allowed == "both" or side_allowed == side
                snapshot["gate_rule"] = rule["rule_name"]
                return allowed, snapshot

        # No rule matched: default allow.
        snapshot["gate_rule"] = None
        return True, snapshot
