"""Python-first setup/condition config: everything is derived from the
script itself; broken scripts are rejected at save time with the error."""

import pytest
from fastapi import HTTPException

from app.routers.conditions import derive_condition_name
from app.routers.setups import derive_setup_fields

SETUP_SCRIPT = """
from typing import Dict, List, Optional, Tuple

class SetupIndicator:
    def get_mandatory_conditions(self) -> List[str]:
        return ["above_vwap", "trend_up"]
    def evaluate_mandatory(self, stock, timestamp, market_data):
        return {}
    def check_signal(self, stock, timestamp, market_data):
        return None
    def get_sl_tp(self, stock, timestamp, market_data):
        return (0.0, 0.0)
    def get_entry_params(self):
        return ("limit", 12.5)
"""

CONDITION_SCRIPT = """
class ConditionCheck:
    def get_name(self):
        return "volume_surge"
    def evaluate(self, signal_side, stock, timestamp, market_data):
        return True
"""


def test_setup_fields_come_from_the_script():
    fields = derive_setup_fields(SETUP_SCRIPT)
    assert fields["mandatory_conditions"] == ["above_vwap", "trend_up"]
    assert fields["entry_method"] == "limit"
    assert fields["entry_price"] == 12.5


def test_setup_script_with_syntax_error_rejected():
    with pytest.raises(HTTPException) as err:
        derive_setup_fields("class SetupIndicator(:")
    assert err.value.status_code == 422
    assert "script error" in err.value.detail


def test_setup_script_missing_methods_rejected():
    with pytest.raises(HTTPException) as err:
        derive_setup_fields("class SetupIndicator:\n    pass")
    assert "missing methods" in err.value.detail
    assert "check_signal" in err.value.detail


def test_condition_name_comes_from_get_name():
    assert derive_condition_name(CONDITION_SCRIPT) == "volume_surge"


def test_condition_without_evaluate_rejected():
    script = "class ConditionCheck:\n    def get_name(self):\n        return 'x'"
    with pytest.raises(HTTPException) as err:
        derive_condition_name(script)
    assert "must define evaluate" in err.value.detail


def test_condition_wrong_class_rejected():
    with pytest.raises(HTTPException) as err:
        derive_condition_name("x = 1")
    assert err.value.status_code == 422
