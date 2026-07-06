"""GradeEngine (spec 3.7) — signal-points grading model.

Built on the same principles as the screener's Side E scoring engine:

* the scoring model is **loaded from the database** (user-editable);
* every check is a *signal* that contributes weighted points, with
  asymmetric aligned/misaligned weighting allowed (like the screener's
  VIX signal);
* ``score = Σ signal_points``, normalized to 0..100;
* the final classification comes from fixed thresholds on that score.

Only default and additional condition results are graded. Mandatory
conditions are intentionally **excluded**: they are prerequisites for
the signal to exist at all, so they carry no grading information.

The public interface stays per spec 3.7:
``evaluate(mandatory, default, additional) -> Tuple[str, float]``
(the ``mandatory`` argument is accepted and ignored).
``evaluate_detailed`` additionally returns the per-condition points
breakdown, which the pipeline stores on the entry card so later
analysis (e.g. a setup-enhancement engine) can learn which conditions
help or hurt.
"""

import logging
from typing import Dict, Tuple

from sqlalchemy import select

from app.database import async_session_factory
from app.models import GradeScoringModelModel

logger = logging.getLogger(__name__)

DEFAULT_MODEL = {
    "default_weight": 2.0,
    "additional_weight": 1.0,
    "misaligned_default_penalty": -2.0,
    "misaligned_additional_penalty": -1.0,
    # Per-condition overrides: {condition_name: weight} — aligned gets
    # +weight, misaligned gets -weight for that condition.
    "condition_weights": {},
    # Minimum normalized score for each grade, checked best-first.
    # Anything below the lowest threshold is a D.
    "grade_thresholds": {"A+": 85.0, "A": 70.0, "B": 50.0, "C": 30.0},
}

GRADE_ORDER = ("A+", "A", "B", "C")


class GradeEngine:
    def __init__(self):
        self.model: dict = dict(DEFAULT_MODEL)

    async def refresh(self) -> None:
        """Load the current scoring model from the database."""
        async with async_session_factory() as session:
            row = (
                await session.execute(
                    select(GradeScoringModelModel).where(GradeScoringModelModel.id == 1)
                )
            ).scalar_one_or_none()
        if row is not None:
            self.model = {
                "default_weight": row.default_weight,
                "additional_weight": row.additional_weight,
                "misaligned_default_penalty": row.misaligned_default_penalty,
                "misaligned_additional_penalty": row.misaligned_additional_penalty,
                "condition_weights": row.condition_weights or {},
                "grade_thresholds": row.grade_thresholds or DEFAULT_MODEL["grade_thresholds"],
            }

    # ------------------------------------------------------------- scoring

    def _signal_points(self, name: str, aligned: bool, kind: str) -> Tuple[float, float, float]:
        """Return (points, max_points, min_points) for one condition signal."""
        override = (self.model.get("condition_weights") or {}).get(name)
        if override is not None:
            aligned_points = float(override)
            misaligned_points = -float(override)
        elif kind == "default":
            aligned_points = float(self.model["default_weight"])
            misaligned_points = float(self.model["misaligned_default_penalty"])
        else:
            aligned_points = float(self.model["additional_weight"])
            misaligned_points = float(self.model["misaligned_additional_penalty"])
        points = aligned_points if aligned else misaligned_points
        return points, aligned_points, misaligned_points

    def evaluate_detailed(self, default: dict, additional: dict) -> dict:
        """Score default+additional condition results (mandatory excluded)."""
        breakdown: Dict[str, dict] = {}
        raw = best = worst = 0.0
        for kind, results in (("default", default or {}), ("additional", additional or {})):
            for name, aligned in results.items():
                points, max_p, min_p = self._signal_points(name, bool(aligned), kind)
                raw += points
                best += max_p
                worst += min_p
                breakdown[name] = {
                    "type": kind,
                    "aligned": bool(aligned),
                    "points": points,
                }

        # Normalize Σ signal_points into 0..100 against the model's range.
        if best > worst:
            score = (raw - worst) / (best - worst) * 100.0
        else:  # no gradable conditions -> neutral midpoint
            score = 50.0

        thresholds = self.model.get("grade_thresholds") or DEFAULT_MODEL["grade_thresholds"]
        grade = "D"
        for candidate in GRADE_ORDER:
            minimum = thresholds.get(candidate)
            if minimum is not None and score >= float(minimum):
                grade = candidate
                break

        return {
            "grade": grade,
            "score": round(score, 2),
            "raw_points": raw,
            "max_points": best,
            "min_points": worst,
            "breakdown": breakdown,
        }

    def evaluate(self, mandatory: dict, default: dict, additional: dict) -> Tuple[str, float]:
        # ``mandatory`` is intentionally not graded.
        detail = self.evaluate_detailed(default, additional)
        return (detail["grade"], detail["score"])
