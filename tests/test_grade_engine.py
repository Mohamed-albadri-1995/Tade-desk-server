"""GradeEngine — signal-points model on the screener scoring principles."""

import pytest

from app.services.grade_engine import DEFAULT_MODEL, GradeEngine


def make_engine(**model_overrides):
    engine = GradeEngine()
    engine.model = {**DEFAULT_MODEL, **model_overrides}
    return engine


def test_all_aligned_is_a_plus():
    engine = make_engine()
    grade, score = engine.evaluate(
        mandatory={"m1": True},
        default={"d1": True, "d2": True},
        additional={"a1": True},
    )
    assert grade == "A+"
    assert score == 100.0


def test_all_misaligned_is_d():
    grade, score = make_engine().evaluate({}, {"d1": False}, {"a1": False})
    assert grade == "D"
    assert score == 0.0


def test_mandatory_results_are_excluded_from_grading():
    engine = make_engine()
    # Identical default/additional results must grade identically no matter
    # what the mandatory dict contains.
    with_pass = engine.evaluate({"m1": True, "m2": True}, {"d1": True}, {})
    with_fail = engine.evaluate({"m1": False, "m2": False}, {"d1": True}, {})
    assert with_pass == with_fail


def test_no_conditions_is_neutral_b():
    grade, score = make_engine().evaluate({}, {}, {})
    assert score == 50.0
    assert grade == "B"


def test_default_conditions_weigh_more_than_additional():
    engine = make_engine()
    # default aligned + additional misaligned: raw = 2 - 1 = 1 of range [-3, 3] -> 66.67
    detail = engine.evaluate_detailed({"d1": True}, {"a1": False})
    assert detail["raw_points"] == pytest.approx(1.0)
    assert detail["score"] == pytest.approx(66.67, abs=0.01)
    assert detail["grade"] == "B"
    # flipped: additional aligned + default misaligned -> raw = -2 + 1 = -1 -> 33.33 -> C
    detail = engine.evaluate_detailed({"d1": False}, {"a1": True})
    assert detail["score"] == pytest.approx(33.33, abs=0.01)
    assert detail["grade"] == "C"


def test_per_condition_weight_override():
    engine = make_engine(condition_weights={"vol": 5.0})
    detail = engine.evaluate_detailed({}, {"vol": True, "a1": False})
    # vol: +5 of [-5, 5]; a1: -1 of [-1, 1] -> raw 4, range [-6, 6] -> 83.33 -> A
    assert detail["raw_points"] == pytest.approx(4.0)
    assert detail["grade"] == "A"
    assert detail["breakdown"]["vol"]["points"] == 5.0


def test_custom_thresholds():
    engine = make_engine(grade_thresholds={"A+": 99.0, "A": 90.0, "B": 10.0, "C": 5.0})
    grade, score = engine.evaluate({}, {"d1": True, "d2": False}, {})
    assert score == 50.0
    assert grade == "B"


def test_breakdown_records_every_condition():
    detail = make_engine().evaluate_detailed({"d1": True, "d2": False}, {"a1": True})
    assert set(detail["breakdown"]) == {"d1", "d2", "a1"}
    assert detail["breakdown"]["d2"] == {"type": "default", "aligned": False, "points": -2.0}
    assert detail["breakdown"]["a1"]["type"] == "additional"
