"""SizerEngine (spec 3.6).

Computes shares from risk settings and the user-editable grade/regime
multiplier tables. Settings and multipliers are cached in memory and
refreshed by the monitor loop so that ``calculate`` performs zero I/O
at signal time.
"""

import logging
import math
from typing import Dict

from sqlalchemy import select

from app.database import async_session_factory
from app.models import GradeMultiplierModel, RegimeMultiplierModel, UserSettingsModel

logger = logging.getLogger(__name__)


class SizerEngine:
    def __init__(self):
        self.account_size: float = 100000.0
        self.risk_per_trade: float = 0.01
        self._grade_multipliers: Dict[str, float] = {}
        self._regime_multipliers: Dict[str, float] = {}

    async def refresh(self) -> None:
        async with async_session_factory() as session:
            settings_row = (
                await session.execute(select(UserSettingsModel).where(UserSettingsModel.id == 1))
            ).scalar_one_or_none()
            if settings_row:
                self.account_size = settings_row.account_size
                self.risk_per_trade = settings_row.risk_per_trade
            grades = (await session.execute(select(GradeMultiplierModel))).scalars().all()
            self._grade_multipliers = {g.grade: g.multiplier for g in grades}
            regimes = (await session.execute(select(RegimeMultiplierModel))).scalars().all()
            self._regime_multipliers = {r.regime_key: r.multiplier for r in regimes}

    def calculate_multi(
        self,
        entry_price: float,
        sl_price: float,
        grade: str,
        regime_key: str,
        setup_factor: float,
        accounts: list,
        available_fn,
    ) -> dict:
        """Per-account sizing with the setup factor and the at-the-moment
        capital cap:  final = min(risk_based, floor(available / entry)).

        ``accounts`` are cached account dicts; ``available_fn(account_id)``
        returns cached available capital (zero I/O). Returns a per-account
        breakdown plus the primary account's shares for the card headline.
        """
        grade_multiplier = self._grade_multipliers.get(grade, 1.0)
        regime_multiplier = self._regime_multipliers.get(regime_key or "", 1.0)
        risk_per_share = abs(entry_price - sl_price)

        per_account = {}
        primary_shares = 0
        for account in accounts:
            risk_fraction = (
                account["risk_per_trade"]
                if account.get("risk_per_trade") is not None
                else self.risk_per_trade
            )
            capital_base = float(account["account_size"])
            risk_amount = capital_base * risk_fraction
            if risk_per_share <= 0:
                risk_shares = 0
            else:
                risk_shares = int(
                    math.floor(
                        risk_amount
                        / risk_per_share
                        * grade_multiplier
                        * regime_multiplier
                        * setup_factor
                    )
                )
            available = available_fn(account["id"])
            cap_shares = (
                int(math.floor(available / entry_price))
                if available is not None and entry_price > 0
                else None
            )
            final = max(0, min(risk_shares, cap_shares) if cap_shares is not None else risk_shares)
            per_account[str(account["id"])] = {
                "name": account["name"],
                "broker_id": account.get("broker_id"),
                "risk_per_trade": risk_fraction,
                "risk_amount": round(risk_amount, 2),
                "risk_based_shares": max(risk_shares, 0),
                "available_capital": available,
                "capital_cap_shares": cap_shares,
                "capital_capped": cap_shares is not None and risk_shares > cap_shares,
                "final_shares": final,
            }
            if account.get("is_primary") or (primary_shares == 0 and final > 0):
                primary_shares = final

        return {
            "final_shares": primary_shares,
            "accounts": per_account,
            "factors": {
                "risk_per_share": risk_per_share,
                "grade": grade,
                "grade_multiplier": grade_multiplier,
                "regime_key": regime_key,
                "regime_multiplier": regime_multiplier,
                "setup_factor": setup_factor,
            },
        }

    def calculate(self, entry_price: float, sl_price: float, grade: str, regime_key: str) -> dict:
        risk_amount = self.account_size * self.risk_per_trade
        risk_per_share = abs(entry_price - sl_price)
        grade_multiplier = self._grade_multipliers.get(grade, 1.0)
        regime_multiplier = self._regime_multipliers.get(regime_key or "", 1.0)

        if risk_per_share <= 0:
            base_shares = 0.0
            final_shares = 0
        else:
            base_shares = risk_amount / risk_per_share
            final_shares = int(math.floor(base_shares * grade_multiplier * regime_multiplier))

        return {
            "final_shares": max(final_shares, 0),
            "factors": {
                "account_size": self.account_size,
                "risk_per_trade": self.risk_per_trade,
                "risk_amount": risk_amount,
                "risk_per_share": risk_per_share,
                "base_shares": base_shares,
                "grade": grade,
                "grade_multiplier": grade_multiplier,
                "regime_key": regime_key,
                "regime_multiplier": regime_multiplier,
            },
        }
