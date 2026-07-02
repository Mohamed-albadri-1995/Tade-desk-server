"""
Statistics store — persists closed trades to SQLite and exposes
per-setup / per-symbol / rolling roll-ups.

Schema (single table, all denormalised — trades are the atomic unit
and we optimise for reads):

    CREATE TABLE trades (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        setup        TEXT    NOT NULL,
        symbol       TEXT    NOT NULL,
        side         TEXT    NOT NULL,
        entry_ts     TEXT    NOT NULL,       -- ISO-8601
        exit_ts      TEXT    NOT NULL,
        entry_px     REAL    NOT NULL,
        exit_px      REAL    NOT NULL,
        stop_px      REAL    NOT NULL,
        target_px    REAL    NOT NULL,
        qty          REAL    NOT NULL,
        exit_reason  TEXT    NOT NULL,
        r_multiple   REAL    NOT NULL
    );

Indexes on (setup), (symbol), (entry_ts).
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Union

import pandas as pd

from qp.live.events import CloseEvent


_SCHEMA = '''
CREATE TABLE IF NOT EXISTS trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    setup        TEXT    NOT NULL,
    symbol       TEXT    NOT NULL,
    side         TEXT    NOT NULL,
    entry_ts     TEXT    NOT NULL,
    exit_ts      TEXT    NOT NULL,
    entry_px     REAL    NOT NULL,
    exit_px      REAL    NOT NULL,
    stop_px      REAL    NOT NULL,
    target_px    REAL    NOT NULL,
    qty          REAL    NOT NULL,
    exit_reason  TEXT    NOT NULL,
    r_multiple   REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_setup   ON trades(setup);
CREATE INDEX IF NOT EXISTS idx_trades_symbol  ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_entry_ts ON trades(entry_ts);
'''


class StatsStore:
    """Thin SQLite wrapper for trade persistence + roll-ups."""

    def __init__(self, path: Union[str, Path] = ':memory:'):
        self._path = str(path)
        self._conn = sqlite3.connect(self._path)
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    def record(self, event: CloseEvent) -> int:
        """Insert a closed trade. Returns the row id."""
        cur = self._conn.execute(
            '''INSERT INTO trades
               (setup, symbol, side, entry_ts, exit_ts,
                entry_px, exit_px, stop_px, target_px, qty,
                exit_reason, r_multiple)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (event.setup, event.symbol, event.side,
             event.timestamp, event.timestamp,   # entry_ts is not on CloseEvent
             event.entry_px, event.exit_px, event.stop_px, event.target_px,
             event.qty, event.reason, event.r_multiple),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def record_bulk(self, events: Iterable[CloseEvent]) -> None:
        for e in events:
            self.record(e)

    def trades(self, setup: Optional[str] = None,
               symbol: Optional[str] = None,
               limit: Optional[int] = None) -> pd.DataFrame:
        """Return trades as a DataFrame, optionally filtered."""
        clauses = []
        params: List = []
        if setup is not None:
            clauses.append('setup = ?')
            params.append(setup)
        if symbol is not None:
            clauses.append('symbol = ?')
            params.append(symbol)
        where = f' WHERE {" AND ".join(clauses)}' if clauses else ''
        limit_sql = f' LIMIT {int(limit)}' if limit else ''
        q = f'SELECT * FROM trades{where} ORDER BY id DESC{limit_sql}'
        return pd.read_sql_query(q, self._conn, params=params)

    def summary(self, setup: Optional[str] = None,
                symbol: Optional[str] = None) -> dict:
        """Aggregate stats: n, wins, losses, win_rate, avg_r,
        expectancy_r, total_r."""
        df = self.trades(setup=setup, symbol=symbol)
        n = len(df)
        if n == 0:
            return {'n_trades': 0, 'n_wins': 0, 'n_losses': 0,
                    'win_rate': 0.0, 'avg_r': 0.0, 'expectancy_r': 0.0,
                    'total_r': 0.0}
        r = df['r_multiple'].to_numpy(dtype=float)
        wins = r[r > 0]
        losses = r[r < 0]
        win_rate = len(wins) / n
        loss_rate = len(losses) / n
        avg_win = float(wins.mean()) if len(wins) else 0.0
        avg_loss = float(losses.mean()) if len(losses) else 0.0
        return {
            'n_trades':     n,
            'n_wins':       int(len(wins)),
            'n_losses':     int(len(losses)),
            'win_rate':     float(win_rate),
            'avg_r':        float(r.mean()),
            'expectancy_r': win_rate * avg_win + loss_rate * avg_loss,
            'total_r':      float(r.sum()),
        }

    def rolling_expectancy(self, window: int,
                           setup: Optional[str] = None) -> pd.Series:
        """Rolling expectancy over the last `window` trades. Handy for
        detecting regime shifts (setup was working; now it isn't)."""
        df = self.trades(setup=setup).sort_values('id')
        r = df['r_multiple'].astype(float)
        wins = (r > 0).astype(int)
        losses = (r < 0).astype(int)
        # We can't easily express expectancy via rolling.mean() alone
        # (need per-window win_rate * avg_win + loss_rate * avg_loss)
        # so we compute it as: mean of r_multiple over the window.
        # Under a fixed setup, mean(r) IS expectancy. Simpler is truer.
        return r.rolling(window=window, min_periods=window).mean()
