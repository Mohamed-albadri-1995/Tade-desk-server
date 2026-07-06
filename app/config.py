"""Application configuration loaded from environment / .env file."""

import os
from dataclasses import dataclass, field


def _load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader (no extra dependency)."""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


@dataclass
class Settings:
    alpaca_api_key: str = field(default_factory=lambda: os.getenv("ALPACA_API_KEY", ""))
    alpaca_secret_key: str = field(default_factory=lambda: os.getenv("ALPACA_SECRET_KEY", ""))
    polygon_api_key: str = field(default_factory=lambda: os.getenv("POLYGON_API_KEY", ""))
    screener_url: str = field(default_factory=lambda: os.getenv("SCREENER_URL", "http://localhost:8001"))
    secret_key: str = field(default_factory=lambda: os.getenv("SECRET_KEY", "dev-secret-key-change-me"))
    database_url: str = field(
        default_factory=lambda: os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./trade_desk.db")
    )
    alpaca_data_url: str = field(
        default_factory=lambda: os.getenv("ALPACA_DATA_URL", "https://data.alpaca.markets")
    )
    alpaca_trading_url: str = field(
        default_factory=lambda: os.getenv("ALPACA_TRADING_URL", "https://paper-api.alpaca.markets")
    )


settings = Settings()
