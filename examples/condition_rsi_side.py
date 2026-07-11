# Example condition script (paste into the Conditions tab).
# One condition serves BOTH sides: evaluate() receives signal_side, so
# you write the long and short logic in one place. Uses only approved
# verified primitives (see /api/primitives for the full list).
from datetime import datetime


class ConditionCheck:
    def get_name(self) -> str:
        return "rsi_confirms_side"

    def evaluate(self, signal_side: str, stock: str, timestamp: datetime, market_data) -> bool:
        rsi = market_data.rsi(stock, length=14)
        if rsi is None:
            return False
        if signal_side == "long":
            return rsi > 55      # momentum up for longs
        return rsi < 45          # momentum down for shorts

    def get_raw_display(self, stock: str, timestamp: datetime, market_data) -> dict:
        return {"rsi14": market_data.rsi(stock, length=14)}
