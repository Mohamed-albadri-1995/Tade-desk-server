"""
STAGE 16 — Backtest / Replay Engine.

Walks a Setup over historical bars, opens on trigger, exits on stop
or target intra-bar. Returns a trade log + summary stats measured in
R multiples (multiples of initial risk).

  backtest(setup, bars, context?) → TradeLog{trades, summary}
      One position at a time; no pyramiding. Conservative on
      simultaneous stop+target: assume stop first.

  backtest_from_eval(eval_result, bars, side) → TradeLog
      Same walker but consumes an already-computed EvalResult so a
      caller (e.g. a UI) can share the evaluator output between the
      backtest and a chart overlay.

Summary metrics:
    n_trades, n_wins, n_losses, win_rate, avg_r,
    expectancy_r = win_rate * avg_win_r + loss_rate * avg_loss_r,
    max_dd_r     = deepest peak-to-trough in cumulative R,
    total_r.

R multiples are the universal PnL currency here — position sizing
lives in Stage 17 (live engine).
"""

from qp.backtest.engine import backtest, backtest_from_eval, TradeLog, Summary
from qp.backtest.r1_replay import (
    run_r1_backtest, BacktestResult, BacktestTrade, BacktestDaySummary,
)

__all__ = ['backtest', 'backtest_from_eval', 'TradeLog', 'Summary',
           'run_r1_backtest', 'BacktestResult',
           'BacktestTrade', 'BacktestDaySummary']
