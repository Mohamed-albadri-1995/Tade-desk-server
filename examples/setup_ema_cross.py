# Example setup script (paste into the Setups tab).
# Runs inside the sandbox: only typing/datetime/math/collections importable;
# all indicator math comes from qp primitives via the injected market_data.
from typing import Dict, List, Optional, Tuple
from datetime import datetime


class SetupIndicator:
    def get_mandatory_conditions(self) -> List[str]:
        return ["price_above_vwap", "ema9_above_ema21"]

    def evaluate_mandatory(self, stock: str, timestamp: datetime, market_data) -> Dict[str, bool]:
        price = market_data.get_current_price(stock)
        vwap = market_data.vwap(stock, lookback=390)
        ema9 = market_data.ema(stock, lookback=200, length=9)
        ema21 = market_data.ema(stock, lookback=200, length=21)
        return {
            "price_above_vwap": price > vwap,
            "ema9_above_ema21": ema9 > ema21,
        }

    def check_signal(self, stock: str, timestamp: datetime, market_data) -> Optional[str]:
        results = self.evaluate_mandatory(stock, timestamp, market_data)
        if all(results.values()):
            rsi = market_data.rsi(stock, lookback=200, length=14)
            if rsi > 55:
                return "long"
        return None

    def get_sl_tp(self, stock: str, timestamp: datetime, market_data) -> Tuple[float, float]:
        price = market_data.get_current_price(stock)
        atr = market_data.atr(stock, lookback=200, length=14)
        return (price - 2.0 * atr, price + 3.0 * atr)

    def get_entry_params(self) -> Tuple[str, Optional[float]]:
        return ("market", None)
