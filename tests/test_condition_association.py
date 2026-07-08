"""Condition→setup association: 'default' applies to every setup, while
'additional' applies only to setups whose id is listed."""

from app.models import ConditionModel, SetupModel


def _conditions_by_setup(setups, conditions):
    """Mirror of MonitorService._tick's association rule."""
    return {
        setup.id: [
            c
            for c in conditions
            if c.type == "default" or setup.id in (c.associated_setups or [])
        ]
        for setup in setups
    }


def _setup(setup_id):
    return SetupModel(id=setup_id, name=f"s{setup_id}", script_content="x=1")


def _cond(cond_id, ctype, assoc=None):
    return ConditionModel(
        id=cond_id, name=f"c{cond_id}", type=ctype,
        script_content="x=1", associated_setups=assoc or [],
    )


def test_default_condition_applies_to_all_setups():
    setups = [_setup(1), _setup(2), _setup(3)]
    default = _cond(10, "default")  # no ids given
    mapping = _conditions_by_setup(setups, [default])
    assert all(default in mapping[s.id] for s in setups)


def test_additional_condition_only_listed_setups():
    setups = [_setup(1), _setup(2), _setup(3)]
    add = _cond(11, "additional", assoc=[2])
    mapping = _conditions_by_setup(setups, [add])
    assert add not in mapping[1]
    assert add in mapping[2]
    assert add not in mapping[3]


def test_mixed():
    setups = [_setup(1), _setup(2)]
    default = _cond(10, "default")
    add = _cond(11, "additional", assoc=[1])
    mapping = _conditions_by_setup(setups, [default, add])
    assert mapping[1] == [default, add]
    assert mapping[2] == [default]
