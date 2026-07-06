# Example condition script (paste into the Conditions tab).
from datetime import datetime


class ConditionCheck:
    def get_name(self) -> str:
        return "relative_volume_above_1_5"

    def evaluate(self, signal_side: str, stock: str, timestamp: datetime, market_data) -> bool:
        rvol = market_data.rel_volume(stock, lookback=100, length=20)
        return rvol >= 1.5

    def get_raw_display(self, stock: str, timestamp: datetime, market_data) -> dict:
        return {"rel_volume": market_data.rel_volume(stock, lookback=100, length=20)}
