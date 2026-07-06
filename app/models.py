"""SQLAlchemy models (spec section 2)."""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def utcnow() -> datetime:
    return datetime.utcnow()


class SetupModel(Base):
    __tablename__ = "setups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    script_content: Mapped[str] = mapped_column(Text, nullable=False)
    mandatory_conditions: Mapped[list] = mapped_column(JSON, default=list)  # list of strings
    sl_tp: Mapped[list | None] = mapped_column(JSON, nullable=True)  # (sl, tp) tuple
    entry_method: Mapped[str] = mapped_column(String(50), default="market")
    entry_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class ConditionModel(Base):
    __tablename__ = "conditions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    type: Mapped[str] = mapped_column(String(20), default="default")  # 'default' | 'additional'
    script_content: Mapped[str] = mapped_column(Text, nullable=False)
    associated_setups: Mapped[list] = mapped_column(JSON, default=list)  # list of setup ids
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class WatchlistModel(Base):
    __tablename__ = "watchlists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    symbols: Mapped[list] = mapped_column(JSON, default=list)  # list of ticker strings
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class JournalModel(Base):
    __tablename__ = "journal"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stock: Mapped[str] = mapped_column(String(20), nullable=False)
    setup_id: Mapped[int] = mapped_column(Integer, nullable=False)
    signal_side: Mapped[str] = mapped_column(String(10), nullable=False)  # 'long' | 'short'
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|rejected|alerted|closed
    entry_signal_time: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    entry_mandatory_results: Mapped[dict] = mapped_column(JSON, default=dict)
    entry_default_results: Mapped[dict] = mapped_column(JSON, default=dict)
    entry_additional_results: Mapped[dict] = mapped_column(JSON, default=dict)
    entry_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_sl_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_tp_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_shares: Mapped[float | None] = mapped_column(Float, nullable=True)
    entry_factors: Mapped[dict] = mapped_column(JSON, default=dict)
    entry_grade: Mapped[str | None] = mapped_column(String(5), nullable=True)
    entry_gate_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    entry_gate_screener_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    exit_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    exit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)
    exit_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)


class BrokerModel(Base):
    __tablename__ = "brokers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False)  # 'alpaca' | 'signalstack'
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    api_key: Mapped[str] = mapped_column(Text, default="")  # encrypted
    secret: Mapped[str] = mapped_column(Text, default="")  # encrypted
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class GradeMultiplierModel(Base):
    __tablename__ = "grade_multipliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    grade: Mapped[str] = mapped_column(String(5), unique=True, nullable=False)  # A+, A, B, C, D
    multiplier: Mapped[float] = mapped_column(Float, default=1.0)


class RegimeMultiplierModel(Base):
    __tablename__ = "regime_multipliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    regime_key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    multiplier: Mapped[float] = mapped_column(Float, default=1.0)


class GateRuleModel(Base):
    __tablename__ = "gate_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rule_name: Mapped[str] = mapped_column(String(200), nullable=False)
    condition: Mapped[dict] = mapped_column(JSON, default=dict)  # e.g. {"secBias":"BULLISH","secHot":true}
    side_allowed: Mapped[str] = mapped_column(String(10), default="both")  # 'long'|'short'|'both'
    priority: Mapped[int] = mapped_column(Integer, default=0)


class UserSettingsModel(Base):
    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # singleton row (id=1)
    account_size: Mapped[float] = mapped_column(Float, default=100000.0)
    risk_per_trade: Mapped[float] = mapped_column(Float, default=0.01)  # fraction of account
    session_start_time: Mapped[str] = mapped_column(String(5), default="09:35")
    screener_refresh_interval: Mapped[int] = mapped_column(Integer, default=15)
    market_refresh_interval: Mapped[int] = mapped_column(Integer, default=5)
    ohlcv_lookback_bars: Mapped[int] = mapped_column(Integer, default=5000)
