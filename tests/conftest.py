import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Use an isolated in-memory database for the whole test session (must be set
# before app.config / app.database are imported).
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test_trade_desk.db")
os.environ.setdefault("SECRET_KEY", "test-secret")

import pytest


@pytest.fixture()
def bars():
    """100 synthetic 1-minute bars trending upward."""
    out = []
    price = 100.0
    for i in range(100):
        o = price
        c = price + 0.1
        out.append(
            {
                "timestamp": f"2026-01-01T09:{30 + i // 60:02d}:{i % 60:02d}Z",
                "open": o,
                "high": max(o, c) + 0.05,
                "low": min(o, c) - 0.05,
                "close": c,
                "volume": 1000 + i,
            }
        )
        price = c
    return out
