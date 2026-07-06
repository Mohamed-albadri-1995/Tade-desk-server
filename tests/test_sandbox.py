import pytest

from app.services.sandbox import SandboxError, execute_script, instantiate


def test_allowed_imports():
    ns = execute_script("import math\nimport datetime\nimport typing\nimport collections\nx = math.pi")
    assert ns["x"] > 3


def test_disallowed_import_blocked():
    with pytest.raises(SandboxError, match="not allowed"):
        execute_script("import os")


def test_removed_builtins():
    for expr in (
        "open('x')",
        "eval('1')",
        "exec('1')",
        "compile('1', 'f', 'eval')",
        "globals()",
        "locals()",
        "getattr(int, 'x')",
        "setattr(int, 'x', 1)",
        "delattr(int, 'x')",
        "__import__('os')",
    ):
        with pytest.raises(SandboxError):
            execute_script(expr)


def test_class_definition_and_instantiation():
    script = """
class ConditionCheck:
    def get_name(self):
        return "always_true"
    def evaluate(self, signal_side, stock, timestamp, market_data):
        return True
"""
    instance = instantiate(script, "ConditionCheck")
    assert instance.get_name() == "always_true"
    assert instance.evaluate("long", "AAPL", None, None) is True


def test_missing_class_raises():
    with pytest.raises(SandboxError, match="does not define"):
        instantiate("x = 1", "SetupIndicator")


def test_market_data_proxy_routes_to_registry(bars):
    from app.services.market_proxy import MarketDataProxy

    cache = {"AAPL": {"bars": bars, "price": bars[-1]["close"], "timestamp": None}}
    proxy = MarketDataProxy(cache)
    assert proxy.get_current_price("AAPL") == bars[-1]["close"]
    assert len(proxy.get_ohlcv("AAPL", 10)) == 10
    expected = sum(b["close"] for b in bars[-9:]) / 9
    assert abs(proxy.sma("AAPL", length=9) - expected) < 1e-9
    with pytest.raises(AttributeError):
        proxy.not_a_primitive
