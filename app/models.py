"""SQLAlchemy models (spec section 2)."""

from datetime import datetime

from typing import Optional

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
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
    sl_tp: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # (sl, tp) tuple
    entry_method: Mapped[str] = mapped_column(String(50), default="market")
    entry_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
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
    entry_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    entry_sl_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    entry_tp_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    entry_shares: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    entry_factors: Mapped[dict] = mapped_column(JSON, default=dict)
    entry_grade: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    entry_gate_allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    entry_gate_screener_snapshot: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    exit_time: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    exit_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    exit_pnl: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    exit_reason: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    # Exit enrichment — computed once when the exit is recorded (immutable).
    r_multiple: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    planned_rr: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    mae_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    mfe_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    capture_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    hold_minutes: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    exit_verdict: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)


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


class GradeScoringModelModel(Base):
    """User-editable grading model (singleton row, id=1) — same principle
    as the screener's Side E scoring model: loaded from the database,
    signal points per condition, thresholds for classification."""

    __tablename__ = "grade_scoring_model"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # singleton (id=1)
    default_weight: Mapped[float] = mapped_column(Float, default=2.0)
    additional_weight: Mapped[float] = mapped_column(Float, default=1.0)
    misaligned_default_penalty: Mapped[float] = mapped_column(Float, default=-2.0)
    misaligned_additional_penalty: Mapped[float] = mapped_column(Float, default=-1.0)
    condition_weights: Mapped[dict] = mapped_column(JSON, default=dict)  # {name: weight}
    grade_thresholds: Mapped[dict] = mapped_column(
        JSON, default=lambda: {"A+": 85.0, "A": 70.0, "B": 50.0, "C": 30.0}
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class GateRuleModel(Base):
    __tablename__ = "gate_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rule_name: Mapped[str] = mapped_column(String(200), nullable=False)
    condition: Mapped[dict] = mapped_column(JSON, default=dict)  # e.g. {"secBias":"BULLISH","secHot":true}
    side_allowed: Mapped[str] = mapped_column(String(10), default="both")  # 'long'|'short'|'both'
    priority: Mapped[int] = mapped_column(Integer, default=0)


class AccountModel(Base):
    """A trading account the sizer computes shares for. ``account_size`` is
    the manual capital base; when a broker of type 'alpaca' is linked, the
    CapitalService replaces it with live buying power on an interval."""

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    account_size: Mapped[float] = mapped_column(Float, default=100000.0)
    risk_per_trade: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # None -> global
    broker_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class SetupFactorModelModel(Base):
    """User-editable setup-factor model (singleton id=1) — signal points
    over a setup's real performance, mapped to a sizing factor that can
    reach 0.0 (block) with confidence shrinkage toward 1.0 for small n."""

    __tablename__ = "setup_factor_model"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Signal thresholds/points: {signal: {thresholds/points...}} — kept as
    # JSON so every knob is user-editable without schema changes.
    signals: Mapped[dict] = mapped_column(JSON, default=dict)
    # Score -> factor mapping, checked best-first: {"80": 1.5, "60": 1.25, ...}
    factor_map: Mapped[dict] = mapped_column(JSON, default=dict)
    # Compute separate long/short factors (falls back to pooled while a
    # side has too few trades).
    split_by_side: Mapped[bool] = mapped_column(Boolean, default=True)
    factor_min: Mapped[float] = mapped_column(Float, default=0.0)
    factor_max: Mapped[float] = mapped_column(Float, default=1.5)
    min_trades: Mapped[int] = mapped_column(Integer, default=20)  # full confidence at n>=this
    hard_floor_trades: Mapped[int] = mapped_column(Integer, default=5)  # below -> factor 1.0
    recent_window: Mapped[int] = mapped_column(Integer, default=10)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class SetupFactorStateModel(Base):
    """Computed setup-factor state per setup — full audit trail of how the
    factor was derived. Recomputed on exit updates and at session start;
    read (never computed) at signal time."""

    __tablename__ = "setup_factor_state"
    __table_args__ = (UniqueConstraint("setup_id", "side", name="uq_setup_factor_side"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    setup_id: Mapped[int] = mapped_column(Integer, nullable=False)
    side: Mapped[str] = mapped_column(String(10), default="pooled")  # pooled|long|short
    inputs: Mapped[dict] = mapped_column(JSON, default=dict)  # n, expectancy_r, pf, win_rate, ...
    signal_points: Mapped[dict] = mapped_column(JSON, default=dict)  # per-signal points
    score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # 0..100
    mapped_factor: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    confidence: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # 0..1 shrinkage weight
    final_factor: Mapped[float] = mapped_column(Float, default=1.0)
    insufficient_data: Mapped[bool] = mapped_column(Boolean, default=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class UserSettingsModel(Base):
    __tablename__ = "user_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)  # singleton row (id=1)
    account_size: Mapped[float] = mapped_column(Float, default=100000.0)
    risk_per_trade: Mapped[float] = mapped_column(Float, default=0.01)  # fraction of account
    session_start_time: Mapped[str] = mapped_column(String(5), default="09:35")
    session_end_time: Mapped[str] = mapped_column(String(5), default="10:00")  # last entry
    watchlist_source: Mapped[str] = mapped_column(String(10), default="shortlist")  # shortlist|registry|manual
    screener_refresh_interval: Mapped[int] = mapped_column(Integer, default=15)
    market_refresh_interval: Mapped[int] = mapped_column(Integer, default=5)
    ohlcv_lookback_bars: Mapped[int] = mapped_column(Integer, default=5000)
