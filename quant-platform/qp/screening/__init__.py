"""
STAGE 13 — Screening Engine.

Runs setups from Stage 12 across a symbol universe and produces a
structured match table. Stateless — no state machine, no notifications,
no routing decisions. It just answers "which (symbol, setup, bar)
tuples triggered?"

Two entry points:
    - scan(setups, symbol_bars, contexts?) → ScanResult (all matches
      across the entire bar history).
    - scan_latest(setups, symbol_bars, contexts?) → DataFrame (only
      matches on the last bar of each symbol — the intraday
      "what's firing NOW" case).

Higher layers (live engine, notifications, backtest) consume the
match table.
"""

from qp.screening.engine import scan, scan_latest, ScanResult

__all__ = ['scan', 'scan_latest', 'ScanResult']
