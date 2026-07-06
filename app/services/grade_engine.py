"""GradeEngine (spec 3.7).

Placeholder implementation: always returns ``('B', 1.0)``. The modular
design allows swapping in a real grading model later without touching
the pipeline.
"""

from typing import Tuple


class GradeEngine:
    def evaluate(self, mandatory: dict, default: dict, additional: dict) -> Tuple[str, float]:
        return ("B", 1.0)
