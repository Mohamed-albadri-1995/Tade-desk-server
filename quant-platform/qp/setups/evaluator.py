"""
Setup evaluator — runs a `Setup` over a bars DataFrame and returns a
structured result:

    entries   — bool ndarray (True on bars the setup triggers).
    entry_px  — float ndarray (close on trigger bar, NaN elsewhere).
    stop_px   — float ndarray (stop level on trigger bar, NaN elsewhere).
    target_px — float ndarray (target level on trigger bar, NaN elsewhere).

Downstream (Stage 16 backtester) walks these arrays to simulate PnL.
Live engine (Stage 17) latches on to the trigger bar and issues an
order at its close.

The evaluator does NOT know how to loop over trades or manage state —
it just projects the setup's rules onto the bar series. Backtest /
live add their own state machines.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

import numpy as np
import pandas as pd

from qp.setups.spec import Setup, StopRule, TargetRule
from qp.volatility import atr as _atr


@dataclass(frozen=True)
class EvalResult:
    entries:   np.ndarray  # bool
    entry_px:  np.ndarray  # float, NaN when no entry
    stop_px:   np.ndarray  # float, NaN when no entry
    target_px: np.ndarray  # float, NaN when no entry


def evaluate(setup: Setup,
             bars: pd.DataFrame,
             context: Optional[Dict[str, np.ndarray]] = None) -> EvalResult:
    """Evaluate `setup` over `bars`. `context` provides per-bar arrays
    for level-based stops / targets (e.g. `{'prev_day_low': ...}`).
    """
    entries = np.asarray(setup.trigger(bars), dtype=bool)
    if entries.shape != (len(bars),):
        raise ValueError(f'trigger must return a bool array of shape '
                         f'({len(bars)},); got {entries.shape}')
    close = bars['close'].to_numpy(dtype=float)

    entry_px = np.where(entries, close, np.nan)
    stop_px  = _stop_prices(setup, bars, entries, entry_px, context or {})
    tgt_px   = _target_prices(setup, bars, entries, entry_px, stop_px, context or {})
    return EvalResult(entries=entries, entry_px=entry_px,
                      stop_px=stop_px, target_px=tgt_px)


def _stop_prices(setup: Setup,
                 bars: pd.DataFrame,
                 entries: np.ndarray,
                 entry_px: np.ndarray,
                 context: Dict[str, np.ndarray]) -> np.ndarray:
    rule: StopRule = setup.stop
    side_sign = -1.0 if setup.side == 'long' else 1.0  # stop is BELOW for long.

    if rule.kind == 'atr':
        distance = rule.mult * _atr(bars, rule.atr_length)
    elif rule.kind == 'percent':
        distance = rule.pct * entry_px
    elif rule.kind == 'level':
        level = _get_context_level(context, rule.level_name, len(bars))
        # Stop = level exactly; return level where entry fires, NaN elsewhere.
        return np.where(entries, level, np.nan)
    else:
        raise ValueError(f'unknown stop kind {rule.kind!r}')

    stop = entry_px + side_sign * distance
    return np.where(entries, stop, np.nan)


def _target_prices(setup: Setup,
                   bars: pd.DataFrame,
                   entries: np.ndarray,
                   entry_px: np.ndarray,
                   stop_px:  np.ndarray,
                   context: Dict[str, np.ndarray]) -> np.ndarray:
    rule: TargetRule = setup.target
    side_sign = 1.0 if setup.side == 'long' else -1.0  # target is ABOVE for long.

    if rule.kind == 'atr':
        distance = rule.mult * _atr(bars, rule.atr_length)
    elif rule.kind == 'percent':
        distance = rule.pct * entry_px
    elif rule.kind == 'r_multiple':
        # R = |entry - stop|; target = entry + r × R in trade direction.
        distance = rule.r * np.abs(entry_px - stop_px)
    elif rule.kind == 'level':
        level = _get_context_level(context, rule.level_name, len(bars))
        return np.where(entries, level, np.nan)
    else:
        raise ValueError(f'unknown target kind {rule.kind!r}')

    target = entry_px + side_sign * distance
    return np.where(entries, target, np.nan)


def _get_context_level(context: Dict[str, np.ndarray],
                       name: str, n: int) -> np.ndarray:
    if not name:
        raise ValueError('level_name must be set for kind="level" rules')
    if name not in context:
        raise KeyError(f'context missing level series {name!r}')
    arr = np.asarray(context[name], dtype=float)
    if arr.shape != (n,):
        raise ValueError(f'context[{name!r}] must be length {n}, '
                         f'got {arr.shape}')
    return arr
