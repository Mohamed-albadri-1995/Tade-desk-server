"""Pydantic request/response schemas."""

from datetime import datetime
from typing import List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field


# ------------------------------------------------------------------- setups
class SetupCreate(BaseModel):
    name: str
    script_content: str
    mandatory_conditions: List[str] = Field(default_factory=list)
    sl_tp: Optional[Tuple[Optional[float], Optional[float]]] = None
    entry_method: str = "market"
    entry_price: Optional[float] = None
    close_at_session_end: bool = True
    is_active: bool = True


class SetupUpdate(BaseModel):
    name: Optional[str] = None
    script_content: Optional[str] = None
    mandatory_conditions: Optional[List[str]] = None
    sl_tp: Optional[Tuple[Optional[float], Optional[float]]] = None
    entry_method: Optional[str] = None
    entry_price: Optional[float] = None
    close_at_session_end: Optional[bool] = None
    is_active: Optional[bool] = None


class SetupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    script_content: str
    mandatory_conditions: list
    sl_tp: Optional[list] = None
    entry_method: str
    entry_price: Optional[float] = None
    close_at_session_end: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------- conditions
class ConditionCreate(BaseModel):
    name: str
    type: str = "default"  # 'default' | 'additional'
    script_content: str
    associated_setups: List[int] = Field(default_factory=list)
    is_active: bool = True


class ConditionUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    script_content: Optional[str] = None
    associated_setups: Optional[List[int]] = None
    is_active: Optional[bool] = None


class ConditionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    type: str
    script_content: str
    associated_setups: list
    is_active: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------- watchlist
class WatchlistOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    symbols: list
    uploaded_at: datetime


# ------------------------------------------------------------------ brokers
class BrokerCreate(BaseModel):
    type: str  # 'alpaca' | 'signalstack'
    name: str
    api_key: str = ""
    secret: str = ""
    is_active: bool = True


class BrokerUpdate(BaseModel):
    type: Optional[str] = None
    name: Optional[str] = None
    api_key: Optional[str] = None
    secret: Optional[str] = None
    is_active: Optional[bool] = None


class BrokerOut(BaseModel):
    id: int
    type: str
    name: str
    is_active: bool
    has_api_key: bool
    has_secret: bool


# ------------------------------------------------------------- multipliers
class GradeMultiplierIn(BaseModel):
    grade: str
    multiplier: float


class RegimeMultiplierIn(BaseModel):
    regime_key: str
    multiplier: float


# ------------------------------------------------------------ grading model
class GradeScoringModelUpdate(BaseModel):
    default_weight: Optional[float] = None
    additional_weight: Optional[float] = None
    misaligned_default_penalty: Optional[float] = None
    misaligned_additional_penalty: Optional[float] = None
    condition_weights: Optional[dict] = None
    grade_thresholds: Optional[dict] = None


class GradeScoringModelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    default_weight: float
    additional_weight: float
    misaligned_default_penalty: float
    misaligned_additional_penalty: float
    condition_weights: dict
    grade_thresholds: dict
    updated_at: datetime


class GradePreviewIn(BaseModel):
    default_results: dict = Field(default_factory=dict)
    additional_results: dict = Field(default_factory=dict)


# --------------------------------------------------------------- gate rules
class GateRuleCreate(BaseModel):
    rule_name: str
    condition: dict = Field(default_factory=dict)
    side_allowed: str = "both"
    priority: int = 0


class GateRuleUpdate(BaseModel):
    rule_name: Optional[str] = None
    condition: Optional[dict] = None
    side_allowed: Optional[str] = None
    priority: Optional[int] = None


class GateRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_name: str
    condition: dict
    side_allowed: str
    priority: int


# ----------------------------------------------------------------- settings
class UserSettingsUpdate(BaseModel):
    account_size: Optional[float] = None
    risk_per_trade: Optional[float] = None
    session_start_time: Optional[str] = None
    session_end_time: Optional[str] = None
    watchlist_source: Optional[str] = None  # 'screener' | 'manual'
    screener_refresh_interval: Optional[int] = None
    market_refresh_interval: Optional[int] = None
    ohlcv_lookback_bars: Optional[int] = None


class UserSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_size: float
    risk_per_trade: float
    session_start_time: str
    session_end_time: str
    watchlist_source: str
    screener_refresh_interval: int
    market_refresh_interval: int
    ohlcv_lookback_bars: int


# ------------------------------------------------------------------ journal
class ExitCardUpdate(BaseModel):
    exit_price: Optional[float] = None
    exit_pnl: Optional[float] = None
    exit_reason: Optional[str] = None
    exit_time: Optional[datetime] = None
    status: Optional[str] = None
