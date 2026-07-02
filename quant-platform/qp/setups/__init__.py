"""
STAGE 12 — Setup Library.

A **Setup** names a trade concept and packages three things:

    1. A `trigger` — any callable(bars) → bool array. Compose it from
       Stage 10 primitives against Stage 11 indicators, Stage 8
       levels, or Stage 6 VWAPs. Any boolean composition works.
    2. A `stop` rule — ATR-multiple, percent, or a per-bar level array.
    3. A `target` rule — ATR-multiple, percent, R-multiple, or level.

Setups are pure data + a callable — trivially serialisable across the
platform. The `evaluate()` function projects a setup onto a bars
DataFrame and returns per-bar entries + stop / target arrays that
the backtester (Stage 16) and live engine (Stage 17) consume.

This module does NOT decide which setups exist — it defines the
grammar. Concrete named setups (e.g. "9:30 open range breakout") are
built by callers using this grammar and stored where they need to be.
"""

from qp.setups.spec import Setup, StopRule, TargetRule
from qp.setups.evaluator import evaluate, EvalResult

__all__ = [
    'Setup', 'StopRule', 'TargetRule',
    'evaluate', 'EvalResult',
]
