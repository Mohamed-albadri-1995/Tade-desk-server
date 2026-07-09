"""LearningEngine — PCA+Ridge training, grade buckets, live prediction."""

from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from sqlalchemy import delete

from app.database import async_session_factory, init_db
from app.models import (
    JournalConditionAlignmentModel,
    JournalModel,
    LearnedGradeBucketModel,
    LearnedGradeWeightModel,
    LearnedModelModel,
)
from app.services.learning import FALLBACK, LearningEngine

pytestmark = pytest.mark.asyncio

SETUP_ID = 777


@pytest_asyncio.fixture()
async def engine():
    await init_db()
    # Clean slate for this setup's synthetic universe.
    async with async_session_factory() as session:
        await session.execute(delete(JournalModel).where(JournalModel.setup_id == SETUP_ID))
        await session.execute(
            delete(JournalConditionAlignmentModel).where(
                JournalConditionAlignmentModel.setup_id == SETUP_ID
            )
        )
        for model in (LearnedModelModel, LearnedGradeWeightModel, LearnedGradeBucketModel):
            await session.execute(delete(model).where(model.setup_id == SETUP_ID))
        await session.commit()

    # 40 closed long trades: condition 'hot' aligned -> ~+1.5R, misaligned
    # -> ~-0.5R; regime alternates but carries no signal.
    async with async_session_factory() as session:
        for i in range(40):
            aligned = i % 2 == 0
            r = 1.5 if aligned else -0.5
            t0 = datetime(2026, 6, 1, 14, 0) + timedelta(hours=i)
            entry = JournalModel(
                stock="LRN", setup_id=SETUP_ID, signal_side="long", status="closed",
                entry_signal_time=t0, entry_price=100.0, entry_sl_price=98.0,
                entry_shares=10, exit_time=t0 + timedelta(minutes=30),
                exit_price=100.0 + 2 * r, exit_pnl=20.0 * r, r_multiple=r,
            )
            session.add(entry)
            await session.flush()
            regime = "STRONG_UP" if i % 3 else "CHOP_BULL"
            session.add(JournalConditionAlignmentModel(
                journal_id=entry.id, setup_id=SETUP_ID, side="long",
                condition_name="hot", condition_type="default",
                regime=regime, aligned=aligned,
            ))
            session.add(JournalConditionAlignmentModel(
                journal_id=entry.id, setup_id=SETUP_ID, side="long",
                condition_name="noise", condition_type="additional",
                regime=regime, aligned=(i % 5 == 0),
            ))
        await session.commit()

    eng = LearningEngine()
    eng.min_trades = 30
    return eng


async def test_training_and_prediction(engine):
    result = await engine.run_learning()
    trained_keys = {(t["setup_id"], t["side"]) for t in result["trained"]}
    assert (SETUP_ID, "long") in trained_keys

    model = engine._models[(SETUP_ID, "long")]
    assert model["sample_count"] == 40
    weights = {k: w for k, w, _, _ in model["features"]}
    assert weights["cond:hot"] > 0.1  # the predictive condition gets positive weight
    assert abs(weights.get("cond:noise", 0.0)) < weights["cond:hot"]

    # Live prediction: aligned 'hot' must grade far better than misaligned.
    good = engine.predict(SETUP_ID, "long", {"hot": True, "noise": False}, "STRONG_UP")
    bad = engine.predict(SETUP_ID, "long", {"hot": False, "noise": False}, "STRONG_UP")
    assert good["predicted_r"] > bad["predicted_r"]
    assert good["grade"] in ("A+", "A")
    assert bad["grade"] in ("B", "C")
    assert good["multiplier"] >= bad["multiplier"]
    assert 0.5 <= good["multiplier"] <= 1.5 and 0.5 <= bad["multiplier"] <= 1.5

    # The prediction reproduces training predictions: check drivers exist.
    assert any(d["feature"] == "cond:hot" for d in good["drivers"])


async def test_prediction_survives_reload(engine):
    await engine.run_learning()
    before = engine.predict(SETUP_ID, "long", {"hot": True}, "STRONG_UP")

    fresh = LearningEngine()
    await fresh.load()  # from DB only — flattened weights round-trip
    after = fresh.predict(SETUP_ID, "long", {"hot": True}, "STRONG_UP")
    assert after["predicted_r"] == pytest.approx(before["predicted_r"], abs=1e-6)
    assert after["grade"] == before["grade"]


async def test_fallback_without_model(engine):
    out = engine.predict(999999, "short", {"x": True}, "DOWN")
    assert out["grade"] == FALLBACK["grade"] == "B"
    assert out["multiplier"] == 1.0


async def test_too_few_trades_skipped(engine):
    engine.min_trades = 100  # more than the 40 we inserted
    result = await engine.run_learning()
    assert (SETUP_ID, "long") not in {(t["setup_id"], t["side"]) for t in result["trained"]}
    assert any(s["setup_id"] == SETUP_ID for s in result["skipped"])
