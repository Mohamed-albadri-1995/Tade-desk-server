"""
Backtest engine — walks a Setup over bars, opens on trigger, closes
when the stop or target is hit intra-bar.

Model:
    - one position at a time per setup (no pyramiding).
    - trigger bar close is the entry price (pessimistic vs "next bar
      open" but conservative and matches most Pine backtests when the
      script's `strategy.entry` uses `barIndex[0].close`).
    - stop / target are the levels the evaluator produced.
    - exit rule: if stop and target both sit inside the bar range,
      assume stop hits first (conservative). Otherwise whichever is
      inside the range wins.
    - end of series: any open position is closed at the final bar's
      close as "eod".

Returns a TradeLog dataclass:
    trades   → DataFrame per closed trade.
    summary  → Summary dataclass with expectancy, win rate, avg R,
               max drawdown (in R units), n_trades.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from qp.setups import Setup, evaluate
from qp.setups.evaluator import EvalResult


@dataclass(frozen=True)
class Summary:
    n_trades:      int
    n_wins:        int
    n_losses:      int
    win_rate:      float
    avg_r:         float           # average R multiple across trades
    expectancy_r:  float           # win_rate*avg_win_r - loss_rate*|avg_loss_r|
    max_dd_r:      float           # deepest peak-to-trough in cumulative R
    total_r:       float


@dataclass(frozen=True)
class TradeLog:
    trades:  pd.DataFrame
    summary: Summary


def backtest(setup: Setup,
             bars: pd.DataFrame,
             context: Optional[Dict[str, np.ndarray]] = None) -> TradeLog:
    r = evaluate(setup, bars, context=context)
    return backtest_from_eval(r, bars, side=setup.side)


def backtest_from_eval(r: EvalResult,
                       bars: pd.DataFrame,
                       side: str) -> TradeLog:
    """Backtest against an already-evaluated setup. Splitting this out
    lets callers reuse the EvalResult for chart annotation without
    re-running the trigger."""
    high  = bars['high'].to_numpy(dtype=float)
    low   = bars['low'].to_numpy(dtype=float)
    close = bars['close'].to_numpy(dtype=float)
    index = bars.index

    trades: List[dict] = []
    in_position = False
    entry_i: int = -1
    entry_px = stop_px = target_px = 0.0

    for i in range(len(bars)):
        if in_position:
            hit_stop, hit_target = _check_exits(high[i], low[i],
                                                stop_px, target_px, side)
            exit_px = None
            reason = None
            if hit_stop and hit_target:
                # Conservative: assume stop first.
                exit_px, reason = stop_px, 'stop'
            elif hit_stop:
                exit_px, reason = stop_px, 'stop'
            elif hit_target:
                exit_px, reason = target_px, 'target'

            if exit_px is not None:
                trades.append(_close_trade(entry_i, i, entry_px, stop_px,
                                           target_px, exit_px, reason, side,
                                           index))
                in_position = False

        # Enter AFTER checking exits so we don't accidentally enter and
        # exit on the same bar's stop/target hit.
        if not in_position and r.entries[i]:
            in_position = True
            entry_i    = i
            entry_px   = r.entry_px[i]
            stop_px    = r.stop_px[i]
            target_px  = r.target_px[i]

    if in_position:
        trades.append(_close_trade(entry_i, len(bars) - 1, entry_px, stop_px,
                                   target_px, close[-1], 'eod', side, index))

    df = pd.DataFrame(trades, columns=[
        'entry_bar', 'exit_bar', 'entry_ts', 'exit_ts', 'side',
        'entry_px', 'stop_px', 'target_px', 'exit_px',
        'exit_reason', 'r_multiple',
    ])
    return TradeLog(trades=df, summary=_summarize(df))


def _check_exits(high, low, stop, target, side):
    if side == 'long':
        return (low <= stop, high >= target)
    return (high >= stop, low <= target)


def _close_trade(entry_i, exit_i, entry_px, stop_px, target_px,
                 exit_px, reason, side, index):
    risk = abs(entry_px - stop_px)
    if risk == 0 or np.isnan(risk):
        r_mult = 0.0
    else:
        direction = 1.0 if side == 'long' else -1.0
        r_mult = direction * (exit_px - entry_px) / risk
    return {
        'entry_bar': int(entry_i), 'exit_bar': int(exit_i),
        'entry_ts':  index[entry_i], 'exit_ts':  index[exit_i],
        'side':      side,
        'entry_px':  float(entry_px), 'stop_px': float(stop_px),
        'target_px': float(target_px), 'exit_px': float(exit_px),
        'exit_reason': reason,
        'r_multiple':  float(r_mult),
    }


def _summarize(trades: pd.DataFrame) -> Summary:
    if trades.empty:
        return Summary(n_trades=0, n_wins=0, n_losses=0,
                       win_rate=0.0, avg_r=0.0, expectancy_r=0.0,
                       max_dd_r=0.0, total_r=0.0)
    r = trades['r_multiple'].to_numpy(dtype=float)
    n = len(r)
    wins = r[r > 0]
    losses = r[r < 0]
    win_rate = len(wins) / n if n else 0.0
    loss_rate = len(losses) / n if n else 0.0
    avg_win  = wins.mean()   if len(wins) else 0.0
    avg_loss = losses.mean() if len(losses) else 0.0
    expectancy = win_rate * avg_win + loss_rate * avg_loss

    cum = np.cumsum(r)
    peak = np.maximum.accumulate(cum)
    max_dd = float(np.min(cum - peak))
    return Summary(
        n_trades=n,
        n_wins=int(len(wins)),
        n_losses=int(len(losses)),
        win_rate=float(win_rate),
        avg_r=float(r.mean()),
        expectancy_r=float(expectancy),
        max_dd_r=max_dd,
        total_r=float(r.sum()),
    )
