"""
R1-replay backtester.

For each historical trading day in [start, end], read the trade desk's
R1 register (`r1_frozen.data` JSON blob), sort by score, take the top
N tickers, fetch that day's intraday bars, run a qp setup module, and
walk the firings forward using the setup's STOP/TARGET rules.

The gate the live scanner would have applied is baked into R1 already
(scores computed from broad-market bias, sector, rvol, catalyst, etc.
at 09:36 that day), so this simultaneously backtests the scanner
picks, the gate, and the setup entry logic.

Data source: whatever `qp.data.load` supports — usually
'alpaca:iex' for free-tier historical intraday. Yahoo caps at ~7
calendar days on 1m so it's only usable for very recent windows.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from qp.data import load


_TRADEDESK_DB = Path(__file__).resolve().parents[3] / 'data' / 'tradedesk.db'


@dataclass
class BacktestTrade:
    date:      str
    ticker:    str
    side:      str     # 'long' | 'short'
    entry_ts:  int     # unix seconds
    entry:    float
    stop:     float
    target:   float
    exit_ts:   int
    exit_price: float
    outcome:   str     # 'target' | 'stop' | 'eod'
    r_multiple: float


@dataclass
class BacktestDaySummary:
    date:       str
    n_tickers:  int
    n_fired:    int
    n_trades:   int
    n_wins:     int
    total_r:    float


@dataclass
class BacktestResult:
    setup_id:      str
    start_date:    str
    end_date:      str
    n_days:        int
    n_trades:      int
    n_wins:        int
    n_losses:      int
    win_rate:      float
    total_r:       float
    avg_r:         float
    expectancy_r:  float
    per_day:       list = field(default_factory=list)
    trades:        list = field(default_factory=list)
    error:         Optional[str] = None


def _load_r1_by_day(start_date: str, end_date: str,
                    tradedesk_db: Path) -> dict[str, list[dict]]:
    """{date: [{ticker, score, bias, ...}, ...]}. Empty dict if DB
    missing or dates have no R1 rows."""
    out: dict[str, list[dict]] = {}
    if not tradedesk_db.exists():
        return out
    conn = sqlite3.connect(f'file:{tradedesk_db}?mode=ro', uri=True)
    try:
        rows = conn.execute(
            'SELECT date, ticker, data FROM r1_frozen '
            'WHERE date >= ? AND date <= ? ORDER BY date, ticker',
            (start_date, end_date),
        ).fetchall()
    finally:
        conn.close()
    for date, ticker, data in rows:
        try:
            payload = json.loads(data or '{}')
        except Exception:
            payload = {}
        payload.setdefault('ticker', ticker)
        payload.setdefault('date', date)
        out.setdefault(date, []).append(payload)
    return out


def _top_n(rows: list[dict], top_n: Optional[int],
           top_pct: Optional[float]) -> list[dict]:
    """Sort by score desc and slice. Missing scores sink to the bottom.
    Ties break by ticker for determinism."""
    def _key(r):
        s = r.get('_score')
        if s is None: s = r.get('score')
        return (-(float(s) if s is not None else -1e18), str(r.get('ticker') or ''))
    ordered = sorted(rows, key=_key)
    if top_n is not None and top_n > 0:
        return ordered[:top_n]
    if top_pct is not None and 0 < top_pct <= 100:
        k = max(1, int(round(len(ordered) * (top_pct / 100.0))))
        return ordered[:k]
    return ordered


def _walk_trade(bars_df: pd.DataFrame, i_entry: int,
                side: str, entry: float, stop: float, target: float) -> BacktestTrade:
    """Walk forward from `i_entry` until stop or target is touched.
    Returns a BacktestTrade with exit_ts / exit_price / outcome / r."""
    highs = bars_df['high'].to_numpy(dtype=float)
    lows  = bars_df['low'].to_numpy(dtype=float)
    closes = bars_df['close'].to_numpy(dtype=float)
    ts = (bars_df.index.view('int64') // 1_000_000_000).tolist()
    n = len(bars_df)
    stop_dist = abs(entry - stop) if stop == stop else 0.0
    for i in range(i_entry + 1, n):
        if side == 'long':
            hit_stop   = stop   == stop   and lows[i]  <= stop
            hit_target = target == target and highs[i] >= target
            if hit_stop and hit_target:
                return BacktestTrade(
                    date=str(bars_df.index[i].tz_convert('America/New_York').date()),
                    ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
                    stop=stop, target=target, exit_ts=ts[i],
                    exit_price=stop, outcome='stop', r_multiple=-1.0,
                )
            if hit_target:
                r = (target - entry) / stop_dist if stop_dist > 0 else 0.0
                return BacktestTrade(
                    date=str(bars_df.index[i].tz_convert('America/New_York').date()),
                    ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
                    stop=stop, target=target, exit_ts=ts[i],
                    exit_price=target, outcome='target', r_multiple=r,
                )
            if hit_stop:
                return BacktestTrade(
                    date=str(bars_df.index[i].tz_convert('America/New_York').date()),
                    ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
                    stop=stop, target=target, exit_ts=ts[i],
                    exit_price=stop, outcome='stop', r_multiple=-1.0,
                )
        else:  # short
            hit_stop   = stop   == stop   and highs[i] >= stop
            hit_target = target == target and lows[i]  <= target
            if hit_stop and hit_target:
                return BacktestTrade(
                    date=str(bars_df.index[i].tz_convert('America/New_York').date()),
                    ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
                    stop=stop, target=target, exit_ts=ts[i],
                    exit_price=stop, outcome='stop', r_multiple=-1.0,
                )
            if hit_target:
                r = (entry - target) / stop_dist if stop_dist > 0 else 0.0
                return BacktestTrade(
                    date=str(bars_df.index[i].tz_convert('America/New_York').date()),
                    ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
                    stop=stop, target=target, exit_ts=ts[i],
                    exit_price=target, outcome='target', r_multiple=r,
                )
            if hit_stop:
                return BacktestTrade(
                    date=str(bars_df.index[i].tz_convert('America/New_York').date()),
                    ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
                    stop=stop, target=target, exit_ts=ts[i],
                    exit_price=stop, outcome='stop', r_multiple=-1.0,
                )
    # EOD close
    r = ((closes[-1] - entry) if side == 'long' else (entry - closes[-1]))
    r = r / stop_dist if stop_dist > 0 else 0.0
    return BacktestTrade(
        date=str(bars_df.index[-1].tz_convert('America/New_York').date()),
        ticker='', side=side, entry_ts=ts[i_entry], entry=entry,
        stop=stop, target=target, exit_ts=ts[-1],
        exit_price=float(closes[-1]), outcome='eod', r_multiple=r,
    )


def _stop_target_for(setup_mod, side: str, entry: float,
                     atr_val: Optional[float]) -> tuple[float, float]:
    """Compute (stop, target) prices from the setup module's STOP/TARGET
    rules. Returns (NaN, NaN) if the rules can't produce a stop."""
    stop_rule   = getattr(setup_mod, 'STOP', None)
    target_rule = getattr(setup_mod, 'TARGET', None)
    stop_dist = None
    if stop_rule is not None:
        if stop_rule.kind == 'atr' and atr_val is not None and np.isfinite(atr_val):
            stop_dist = float(stop_rule.mult) * float(atr_val)
        elif stop_rule.kind == 'percent':
            stop_dist = float(stop_rule.pct) * entry
    if stop_dist is None or stop_dist <= 0:
        return float('nan'), float('nan')
    stop_price = entry - stop_dist if side == 'long' else entry + stop_dist
    target_price = float('nan')
    if target_rule is not None:
        if target_rule.kind == 'r_multiple':
            tgt_dist = float(target_rule.r) * stop_dist
            target_price = (entry + tgt_dist) if side == 'long' else (entry - tgt_dist)
        elif target_rule.kind == 'percent':
            tgt_dist = float(target_rule.pct) * entry
            target_price = (entry + tgt_dist) if side == 'long' else (entry - tgt_dist)
    return stop_price, target_price


def run_r1_backtest(setup_id: str, start_date: str, end_date: str,
                    top_n: Optional[int] = 5,
                    top_pct: Optional[float] = None,
                    side: str = 'long',
                    data_source: str = 'alpaca:iex',
                    timeframe: str = '5m',
                    tradedesk_db: Optional[Path] = None) -> BacktestResult:
    """Iterate every trading day in the range, take top-N R1 tickers,
    run the setup on each, walk forward using STOP/TARGET, and roll
    up per-day + overall stats.

    setup_id: 'qp:xxx' or bare 'xxx' — resolves against
              qp.setups.library.REGISTRY.
    """
    from qp.setups.library import REGISTRY
    sid = setup_id[3:] if setup_id.startswith('qp:') else setup_id
    setup_mod = REGISTRY.get(sid)
    if setup_mod is None:
        return BacktestResult(setup_id=setup_id, start_date=start_date,
                              end_date=end_date, n_days=0, n_trades=0,
                              n_wins=0, n_losses=0, win_rate=0.0,
                              total_r=0.0, avg_r=0.0, expectancy_r=0.0,
                              error=f'unknown setup {sid!r}')
    db_path = tradedesk_db or _TRADEDESK_DB
    r1_by_day = _load_r1_by_day(start_date, end_date, db_path)
    if not r1_by_day:
        return BacktestResult(setup_id=setup_id, start_date=start_date,
                              end_date=end_date, n_days=0, n_trades=0,
                              n_wins=0, n_losses=0, win_rate=0.0,
                              total_r=0.0, avg_r=0.0, expectancy_r=0.0,
                              error='no R1 rows in date range')

    all_trades: list[BacktestTrade] = []
    per_day: list[BacktestDaySummary] = []

    for date_str in sorted(r1_by_day.keys()):
        rows = r1_by_day[date_str]
        picks = _top_n(rows, top_n, top_pct)
        day_fired = 0
        day_trades: list[BacktestTrade] = []
        for pick in picks:
            ticker = str(pick.get('ticker') or '').upper()
            if not ticker:
                continue
            try:
                # Load a window that covers `date_str` +/- a few days so
                # session-anchored VWAPs / prior-day levels warm up.
                d_start = pd.Timestamp(date_str) - pd.Timedelta(days=5)
                d_end   = pd.Timestamp(date_str) + pd.Timedelta(days=1)
                bars = load(ticker, timeframe=timeframe,
                            start=d_start, end=d_end,
                            source=data_source, session='regular')
                if bars is None or len(bars) == 0:
                    continue
                df = bars.df
                # Filter to just the target date's bars for evaluate().
                # (evaluator handles NaN pre-warmup correctly.)
                target_day = df.index.tz_convert('America/New_York').date == pd.Timestamp(date_str).date()
                if not target_day.any():
                    continue
                try:
                    mask = setup_mod.evaluate(df, side=side)
                except TypeError:
                    mask = setup_mod.evaluate(df)
                mask = np.asarray(mask, dtype=bool) & np.asarray(target_day, dtype=bool)
                if not mask.any():
                    continue
                # ATR for stop distance (recomputed once per ticker/day).
                atr_arr = None
                stop_rule = getattr(setup_mod, 'STOP', None)
                if stop_rule is not None and stop_rule.kind == 'atr':
                    from qp.volatility import atr as _atr_fn
                    atr_arr = np.asarray(_atr_fn(df, stop_rule.atr_length))
                closes = df['close'].to_numpy(dtype=float)
                for i_entry in np.where(mask)[0]:
                    day_fired += 1
                    entry = float(closes[i_entry])
                    atr_i = float(atr_arr[i_entry]) if atr_arr is not None and np.isfinite(atr_arr[i_entry]) else None
                    stop_price, target_price = _stop_target_for(setup_mod, side, entry, atr_i)
                    if stop_price != stop_price:
                        continue
                    trade = _walk_trade(df, int(i_entry), side, entry, stop_price, target_price)
                    trade = BacktestTrade(**{**trade.__dict__, 'ticker': ticker, 'date': date_str})
                    day_trades.append(trade)
                    all_trades.append(trade)
            except Exception:
                continue

        wins = sum(1 for t in day_trades if t.r_multiple > 0)
        per_day.append(BacktestDaySummary(
            date=date_str, n_tickers=len(picks), n_fired=day_fired,
            n_trades=len(day_trades), n_wins=wins,
            total_r=float(sum(t.r_multiple for t in day_trades)),
        ))

    n = len(all_trades)
    wins = sum(1 for t in all_trades if t.r_multiple > 0)
    losses = sum(1 for t in all_trades if t.r_multiple <= 0)
    total_r = float(sum(t.r_multiple for t in all_trades))
    avg_r = total_r / n if n else 0.0
    win_rate = wins / n if n else 0.0
    if wins > 0 and losses > 0:
        avg_win = sum(t.r_multiple for t in all_trades if t.r_multiple > 0) / wins
        avg_loss = sum(t.r_multiple for t in all_trades if t.r_multiple <= 0) / losses
        expectancy = win_rate * avg_win + (1 - win_rate) * avg_loss
    else:
        expectancy = avg_r
    return BacktestResult(
        setup_id=setup_id, start_date=start_date, end_date=end_date,
        n_days=len(per_day), n_trades=n, n_wins=wins, n_losses=losses,
        win_rate=win_rate, total_r=total_r, avg_r=avg_r,
        expectancy_r=expectancy,
        per_day=[d.__dict__ for d in per_day],
        trades=[t.__dict__ for t in all_trades],
    )
