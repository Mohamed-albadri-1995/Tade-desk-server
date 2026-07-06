import pytest

from app.services.gate_engine import GateEngine
from app.services.screener_data import TickerContext, _parse_record
from app.services.sizer_engine import SizerEngine


def make_sizer():
    sizer = SizerEngine()
    sizer.account_size = 100000.0
    sizer.risk_per_trade = 0.01
    sizer._grade_multipliers = {"A+": 1.5, "B": 1.0, "D": 0.5}
    sizer._regime_multipliers = {"BULL": 1.2}
    return sizer


def test_sizer_basic():
    result = make_sizer().calculate(entry_price=100.0, sl_price=98.0, grade="B", regime_key="")
    # risk = 1000, per-share risk = 2 -> 500 shares * 1.0 * 1.0
    assert result["final_shares"] == 500
    assert result["factors"]["risk_amount"] == 1000.0


def test_sizer_multipliers():
    result = make_sizer().calculate(entry_price=100.0, sl_price=98.0, grade="A+", regime_key="BULL")
    assert result["final_shares"] == int(500 * 1.5 * 1.2)


def test_sizer_zero_risk_distance():
    result = make_sizer().calculate(entry_price=100.0, sl_price=100.0, grade="B", regime_key="")
    assert result["final_shares"] == 0


def make_gate(rules, context=None):
    cache = {}
    if context:
        cache[context.stock] = context
    gate = GateEngine(cache)
    gate._rules = sorted(rules, key=lambda r: -r["priority"])
    return gate


def ctx(**kwargs):
    return TickerContext(stock="AAPL", **kwargs)


def test_gate_default_allow_without_rules():
    allowed, snapshot = make_gate([], ctx(regime="BULL")).is_allowed("AAPL", "long")
    assert allowed is True
    assert snapshot["regime"] == "BULL"


def test_gate_rule_blocks_side():
    rules = [
        {"id": 1, "rule_name": "bearish-long-block", "condition": {"secBias": "BEARISH"},
         "side_allowed": "short", "priority": 10},
    ]
    gate = make_gate(rules, ctx(secBias="BEARISH"))
    allowed, snapshot = gate.is_allowed("AAPL", "long")
    assert allowed is False
    assert snapshot["gate_rule"] == "bearish-long-block"
    allowed, _ = gate.is_allowed("AAPL", "short")
    assert allowed is True


def test_gate_priority_order():
    rules = [
        {"id": 1, "rule_name": "low", "condition": {}, "side_allowed": "both", "priority": 1},
        {"id": 2, "rule_name": "high", "condition": {}, "side_allowed": "long", "priority": 5},
    ]
    gate = make_gate(rules, ctx())
    allowed, snapshot = gate.is_allowed("AAPL", "short")
    assert snapshot["gate_rule"] == "high"
    assert allowed is False


def test_gate_missing_screener_data():
    allowed, snapshot = make_gate([]).is_allowed("MSFT", "long")
    assert allowed is True
    assert snapshot["missing"] is True


def test_parse_record_variants():
    record = {"ticker": "nvda", "context": {"regime": "BULL_TREND", "secBias": "BULLISH", "secHot": True}}
    parsed = _parse_record(record)
    assert parsed.stock == "NVDA"
    assert parsed.regime == "BULL_TREND"
    assert parsed.secHot is True
    assert _parse_record({"no_ticker": 1}) is None
