"""
Screening engine — runs one or more setups across a symbol universe
and returns per-symbol match summaries.

Two entry points:

    scan(setups, symbol_bars) → ScanResult
        Runs every setup against every symbol's bars. Returns a
        DataFrame of matches with columns:
            [symbol, setup, bar_index, timestamp, entry_px, stop_px,
             target_px, side]

    scan_latest(setups, symbol_bars) → pd.DataFrame
        Convenience for "what setups fire on THE LAST bar?" — the
        common intraday screener use case.

The screener is intentionally stateless: it does not decide who to
notify, what to trade, or how to route. It just answers "which
(symbol, setup, bar) tuples fire?" That answer is consumed by higher
layers (live engine, notifications, UI).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional

import numpy as np
import pandas as pd

from qp.setups import Setup, evaluate


@dataclass(frozen=True)
class ScanResult:
    matches: pd.DataFrame  # rows = (symbol, setup, bar, entry, stop, target).


def scan(setups: Iterable[Setup],
         symbol_bars: Dict[str, pd.DataFrame],
         contexts: Optional[Dict[str, Dict[str, np.ndarray]]] = None) -> ScanResult:
    """Evaluate every setup on every symbol and return all matches.

    `contexts` is a per-symbol dict of context arrays (for level-based
    stop/target rules): `{symbol: {level_name: array}}`.
    """
    rows: List[dict] = []
    ctxs = contexts or {}
    for symbol, bars in symbol_bars.items():
        symbol_ctx = ctxs.get(symbol, {})
        for setup in setups:
            r = evaluate(setup, bars, context=symbol_ctx)
            fired = np.where(r.entries)[0]
            for i in fired:
                rows.append({
                    'symbol':    symbol,
                    'setup':     setup.name,
                    'bar_index': int(i),
                    'timestamp': bars.index[i] if len(bars.index) else None,
                    'side':      setup.side,
                    'entry_px':  float(r.entry_px[i]),
                    'stop_px':   float(r.stop_px[i])   if not np.isnan(r.stop_px[i])   else None,
                    'target_px': float(r.target_px[i]) if not np.isnan(r.target_px[i]) else None,
                })
    columns = ['symbol', 'setup', 'bar_index', 'timestamp',
               'side', 'entry_px', 'stop_px', 'target_px']
    df = pd.DataFrame(rows, columns=columns)
    return ScanResult(matches=df)


def scan_latest(setups: Iterable[Setup],
                symbol_bars: Dict[str, pd.DataFrame],
                contexts: Optional[Dict[str, Dict[str, np.ndarray]]] = None) -> pd.DataFrame:
    """Return only matches that fire on the LAST bar of each symbol.
    Common intraday use case: "what setups fired on the current bar?"
    """
    full = scan(setups, symbol_bars, contexts).matches
    if full.empty:
        return full
    # For each symbol, keep matches whose bar_index == last bar index.
    last_idx = {sym: len(df) - 1 for sym, df in symbol_bars.items()}
    mask = full.apply(lambda r: r['bar_index'] == last_idx.get(r['symbol'], -1),
                      axis=1)
    return full[mask].reset_index(drop=True)
