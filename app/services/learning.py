"""Self-learning sizing engine (per the Trade Desk Rebuild plan).

One model per (setup_id, side), trained nightly (and on demand) from
closed trades in journal_condition_alignments:

* features: condition alignments (0/1) + regime one-hot
* target:   realised R-multiple
* pipeline: StandardScaler -> PCA (<=5 comps) -> Ridge(alpha=1.0)

The trained pipeline is flattened to *effective weights* in the original
feature space (pca.components_.T @ ridge.coef_, plus the scaler's
mean/scale and the intercept) and persisted. Live prediction is then
``intercept + Σ w_i × (x_i − mean_i)/scale_i`` — pure arithmetic, no
sklearn import, no DB read at signal time (everything cached in memory).

Grades come from quantiles of the training predictions (q75/q50/q25 →
A+/A/B/C); each bucket's multiplier is bucket_avg_R / overall_avg_R,
clamped to [0.5, 1.5]. Fallback with no model: grade B, multiplier 1.0.
"""

import logging
from collections import defaultdict
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from sqlalchemy import delete, select

from app.database import async_session_factory
from app.models import (
    JournalConditionAlignmentModel,
    JournalModel,
    LearnedGradeBucketModel,
    LearnedGradeWeightModel,
    LearnedModelModel,
    LearningConfigModel,
)

logger = logging.getLogger(__name__)

GRADE_ORDER = ("A+", "A", "B", "C")
MULTIPLIER_CLAMP = (0.5, 1.5)
FALLBACK = {"grade": "B", "multiplier": 1.0, "predicted_r": None, "model": None}


def _clamp(value: float) -> float:
    return max(MULTIPLIER_CLAMP[0], min(MULTIPLIER_CLAMP[1], value))


async def backfill_alignments() -> int:
    """One-off (idempotent): populate journal_condition_alignments from
    the JSON columns of journal cards written before the table existed."""
    async with async_session_factory() as session:
        have = {
            row[0]
            for row in (
                await session.execute(select(JournalConditionAlignmentModel.journal_id).distinct())
            ).all()
        }
        entries = (await session.execute(select(JournalModel))).scalars().all()
        created = 0
        for entry in entries:
            if entry.id in have:
                continue
            snapshot = entry.entry_gate_screener_snapshot or {}
            regime = snapshot.get("regime")
            buckets = (
                ("default", entry.entry_default_results or {}),
                ("additional", entry.entry_additional_results or {}),
            )
            for condition_type, results in buckets:
                for name, aligned in results.items():
                    session.add(
                        JournalConditionAlignmentModel(
                            journal_id=entry.id,
                            setup_id=entry.setup_id,
                            side=entry.signal_side,
                            condition_name=name,
                            condition_type=condition_type,
                            regime=str(regime) if regime else None,
                            aligned=bool(aligned),
                        )
                    )
                    created += 1
        await session.commit()
    if created:
        logger.info("backfilled %d condition alignments", created)
    return created


class LearningEngine:
    def __init__(self):
        self.min_trades = 30
        self.last_run_at: Optional[datetime] = None
        # (setup_id, side) -> {"intercept","features":[(key,weight,mean,scale)],
        #                      "buckets":[...], "sample_count","trained_at","overall_avg_r"}
        self._models: Dict[Tuple[int, str], dict] = {}

    # ------------------------------------------------------------- caching

    async def load(self) -> None:
        """Load config + all persisted models into memory (startup / after runs)."""
        async with async_session_factory() as session:
            config = (
                await session.execute(select(LearningConfigModel).where(LearningConfigModel.id == 1))
            ).scalar_one_or_none()
            if config:
                self.min_trades = config.min_trades
                self.last_run_at = config.last_run_at
            models = (await session.execute(select(LearnedModelModel))).scalars().all()
            weights = (await session.execute(select(LearnedGradeWeightModel))).scalars().all()
            buckets = (await session.execute(select(LearnedGradeBucketModel))).scalars().all()

        weights_by_key = defaultdict(list)
        for w in weights:
            weights_by_key[(w.setup_id, w.side)].append((w.feature_key, w.weight, w.mean, w.scale))
        buckets_by_key = defaultdict(list)
        for b in buckets:
            buckets_by_key[(b.setup_id, b.side)].append(
                {"grade": b.grade, "lower": b.lower_bound, "upper": b.upper_bound,
                 "multiplier": b.multiplier, "n": b.sample_count}
            )
        self._models = {
            (m.setup_id, m.side): {
                "intercept": m.intercept,
                "features": weights_by_key.get((m.setup_id, m.side), []),
                "buckets": buckets_by_key.get((m.setup_id, m.side), []),
                "sample_count": m.sample_count,
                "overall_avg_r": m.overall_avg_r,
                "trained_at": m.trained_at.isoformat() if m.trained_at else None,
            }
            for m in models
        }
        logger.info("learning cache loaded: %d models", len(self._models))

    def status(self) -> dict:
        return {
            "min_trades": self.min_trades,
            "last_run_at": self.last_run_at.isoformat() if self.last_run_at else None,
            "models": [
                {
                    "setup_id": setup_id,
                    "side": side,
                    "sample_count": model["sample_count"],
                    "trained_at": model["trained_at"],
                    "top_features": sorted(
                        ({"feature": k, "weight": round(w, 4)} for k, w, _, _ in model["features"]),
                        key=lambda f: -abs(f["weight"]),
                    )[:5],
                    "buckets": model["buckets"],
                }
                for (setup_id, side), model in sorted(self._models.items())
            ],
        }

    # ---------------------------------------------------------- prediction

    def predict(self, setup_id: int, side: str, conditions: Dict[str, bool],
                regime: Optional[str]) -> dict:
        """Live grading — pure arithmetic on the cached model. Returns the
        FALLBACK dict (grade B, ×1.0) when no model is trained."""
        model = self._models.get((setup_id, side))
        if not model or not model["features"]:
            return dict(FALLBACK)

        live = {f"cond:{name}": 1.0 if aligned else 0.0 for name, aligned in conditions.items()}
        if regime:
            live[f"regime:{regime}"] = 1.0

        predicted = model["intercept"]
        drivers = []
        for key, weight, mean, scale in model["features"]:
            raw = live.get(key, 0.0)
            standardized = (raw - mean) / scale if scale else 0.0
            contribution = weight * standardized
            predicted += contribution
            drivers.append({"feature": key, "value": raw, "contribution": round(contribution, 4)})
        drivers.sort(key=lambda d: -abs(d["contribution"]))

        grade, multiplier = "C", MULTIPLIER_CLAMP[0]
        for bucket in model["buckets"]:
            low = bucket["lower"] if bucket["lower"] is not None else float("-inf")
            high = bucket["upper"] if bucket["upper"] is not None else float("inf")
            if low <= predicted < high:
                grade, multiplier = bucket["grade"], bucket["multiplier"]
                break

        return {
            "grade": grade,
            "multiplier": multiplier,
            "predicted_r": round(predicted, 4),
            "drivers": drivers[:6],
            "model": {"sample_count": model["sample_count"], "trained_at": model["trained_at"]},
        }

    # ------------------------------------------------------------ training

    async def run_learning(self) -> dict:
        """Train every (setup_id, side) with >= min_trades closed trades."""
        import numpy as np  # heavy imports only in the training path
        from sklearn.decomposition import PCA
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler

        async with async_session_factory() as session:
            closed = (
                await session.execute(
                    select(JournalModel.id, JournalModel.setup_id, JournalModel.signal_side,
                           JournalModel.r_multiple).where(JournalModel.r_multiple != None)  # noqa: E711
                )
            ).all()
            alignments = (
                await session.execute(select(JournalConditionAlignmentModel))
            ).scalars().all()

        by_journal = defaultdict(dict)
        regime_by_journal = {}
        for a in alignments:
            by_journal[a.journal_id][f"cond:{a.condition_name}"] = 1.0 if a.aligned else 0.0
            if a.regime:
                regime_by_journal[a.journal_id] = a.regime

        groups = defaultdict(list)
        for journal_id, setup_id, side, r in closed:
            groups[(setup_id, side)].append((journal_id, float(r)))

        trained, skipped = [], []
        for (setup_id, side), rows in groups.items():
            if len(rows) < self.min_trades:
                skipped.append({"setup_id": setup_id, "side": side, "n": len(rows)})
                continue
            feature_keys = sorted(
                {k for jid, _ in rows for k in by_journal.get(jid, {})}
                | {f"regime:{regime_by_journal[jid]}" for jid, _ in rows if jid in regime_by_journal}
            )
            if not feature_keys:
                skipped.append({"setup_id": setup_id, "side": side, "n": len(rows),
                                "reason": "no condition alignments recorded"})
                continue

            X = np.zeros((len(rows), len(feature_keys)))
            y = np.zeros(len(rows))
            for i, (jid, r) in enumerate(rows):
                y[i] = r
                feats = dict(by_journal.get(jid, {}))
                if jid in regime_by_journal:
                    feats[f"regime:{regime_by_journal[jid]}"] = 1.0
                for j, key in enumerate(feature_keys):
                    X[i, j] = feats.get(key, 0.0)

            scaler = StandardScaler()
            X_scaled = scaler.fit_transform(X)
            n_comp = max(1, min(X.shape[1], 5, X.shape[0] - 1))
            pca = PCA(n_components=n_comp)
            X_pca = pca.fit_transform(X_scaled)
            ridge = Ridge(alpha=1.0)
            ridge.fit(X_pca, y)

            effective = pca.components_.T @ ridge.coef_  # back to feature space
            # PCA centers its input; fold that shift into the intercept so
            # prediction = intercept + effective · x_scaled reproduces the
            # full pipeline exactly.
            intercept = float(ridge.intercept_ - effective @ pca.mean_)

            y_pred = ridge.predict(X_pca)
            q25, q50, q75 = np.percentile(y_pred, [25, 50, 75])
            overall_avg = float(np.mean(y))
            buckets = []
            for grade, low, high in (
                ("A+", float(q75), None), ("A", float(q50), float(q75)),
                ("B", float(q25), float(q50)), ("C", None, float(q25)),
            ):
                mask = np.ones(len(y), dtype=bool)
                if low is not None:
                    mask &= y_pred >= low
                if high is not None:
                    mask &= y_pred < high
                bucket_avg = float(np.mean(y[mask])) if mask.any() else overall_avg
                multiplier = _clamp(bucket_avg / overall_avg) if overall_avg > 0 else 1.0
                buckets.append({"grade": grade, "lower": low, "upper": high,
                                "multiplier": round(multiplier, 4), "n": int(mask.sum())})

            await self._persist(
                setup_id, side, intercept, len(rows), overall_avg,
                [(feature_keys[j], float(effective[j]), float(scaler.mean_[j]),
                  float(scaler.scale_[j]) or 1.0) for j in range(len(feature_keys))],
                buckets,
            )
            trained.append({"setup_id": setup_id, "side": side, "n": len(rows)})

        async with async_session_factory() as session:
            config = (
                await session.execute(select(LearningConfigModel).where(LearningConfigModel.id == 1))
            ).scalar_one_or_none()
            if config is None:
                config = LearningConfigModel(id=1)
                session.add(config)
            config.last_run_at = datetime.utcnow()
            await session.commit()

        await self.load()
        logger.info("learning run: trained %d, skipped %d", len(trained), len(skipped))
        return {"trained": trained, "skipped": skipped, "ran_at": datetime.utcnow().isoformat()}

    async def _persist(self, setup_id, side, intercept, n, overall_avg_r, features, buckets):
        async with async_session_factory() as session:
            model = (
                await session.execute(
                    select(LearnedModelModel).where(
                        LearnedModelModel.setup_id == setup_id, LearnedModelModel.side == side
                    )
                )
            ).scalar_one_or_none()
            if model is None:
                model = LearnedModelModel(setup_id=setup_id, side=side)
                session.add(model)
            model.intercept = intercept
            model.sample_count = n
            model.overall_avg_r = overall_avg_r

            await session.execute(
                delete(LearnedGradeWeightModel).where(
                    LearnedGradeWeightModel.setup_id == setup_id,
                    LearnedGradeWeightModel.side == side,
                )
            )
            for key, weight, mean, scale in features:
                session.add(LearnedGradeWeightModel(
                    setup_id=setup_id, side=side, feature_key=key,
                    weight=weight, mean=mean, scale=scale,
                ))
            await session.execute(
                delete(LearnedGradeBucketModel).where(
                    LearnedGradeBucketModel.setup_id == setup_id,
                    LearnedGradeBucketModel.side == side,
                )
            )
            for b in buckets:
                session.add(LearnedGradeBucketModel(
                    setup_id=setup_id, side=side, grade=b["grade"],
                    lower_bound=b["lower"], upper_bound=b["upper"],
                    multiplier=b["multiplier"], sample_count=b["n"],
                ))
            await session.commit()
