"""
Platform store — Phase 3.

A tiny SQLite store for user-built strategies (and, later, Phase 4 backtest
runs). Stdlib sqlite3, one file next to the chart package. Handlers are sync
(FastAPI runs them in a threadpool), so a module lock keeps writes safe.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

_DB = Path(__file__).resolve().parent / 'platform.db'
_lock = threading.Lock()
_conn = None


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(str(_DB), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS strategies (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                data       TEXT NOT NULL,           -- full strategy JSON
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS backtests (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL,
                spec       TEXT NOT NULL,           -- run spec JSON
                status     TEXT NOT NULL,           -- running | done | error
                progress   REAL NOT NULL DEFAULT 0, -- 0..1
                summary    TEXT,                    -- stats JSON when done
                error      TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS backtest_trades (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                bt_id    INTEGER NOT NULL,
                date     TEXT NOT NULL,             -- ET session date YYYY-MM-DD
                symbol   TEXT NOT NULL,
                side     TEXT NOT NULL,
                entry_ts INTEGER NOT NULL,          -- epoch s (UTC)
                exit_ts  INTEGER,                   -- NULL = still open at day end
                entry    REAL NOT NULL,
                exit     REAL,
                ret      REAL,                      -- fractional return (signed)
                reason   TEXT,                      -- SL | TP | exit | open
                ctx      TEXT                       -- frozen register card JSON
            )
        """)
        try:  # migration for DBs created before the ctx column existed
            _conn.execute('ALTER TABLE backtest_trades ADD COLUMN ctx TEXT')
        except sqlite3.OperationalError:
            pass
        _conn.execute("""CREATE INDEX IF NOT EXISTS idx_bt_trades
                         ON backtest_trades (bt_id, date)""")
        _conn.commit()
    return _conn


def _row_to_strategy(row: sqlite3.Row) -> dict:
    obj = json.loads(row['data'])
    obj['id'] = row['id']
    obj['name'] = row['name']
    obj['updated_at'] = row['updated_at']
    return obj


def list_strategies() -> list:
    with _lock:
        rows = _db().execute(
            'SELECT * FROM strategies ORDER BY updated_at DESC').fetchall()
    return [_row_to_strategy(r) for r in rows]


def get_strategy(sid: int) -> dict | None:
    with _lock:
        row = _db().execute('SELECT * FROM strategies WHERE id = ?', (sid,)).fetchone()
    return _row_to_strategy(row) if row else None


def save_strategy(obj: dict) -> dict:
    """Insert or update. `obj` is the full strategy JSON; if it carries an
    `id`, that row is updated, else a new row is created. Returns the saved
    strategy (with id)."""
    name = (obj.get('name') or 'Untitled strategy').strip()[:120]
    sid = obj.get('id')
    payload = dict(obj)
    # strip store metadata so a load→edit→save cycle doesn't embed stale
    # copies of it inside the strategy document itself
    for meta in ('id', 'updated_at', 'created_at'):
        payload.pop(meta, None)
    data = json.dumps(payload)
    now = time.time()
    with _lock:
        db = _db()
        if sid:
            cur = db.execute('UPDATE strategies SET name=?, data=?, updated_at=? WHERE id=?',
                             (name, data, now, sid))
            db.commit()
            if cur.rowcount == 0:      # this statement matched no row (stale id)
                sid = None             # → fall through to insert a fresh row
        if not sid:
            cur = db.execute(
                'INSERT INTO strategies (name, data, created_at, updated_at) VALUES (?,?,?,?)',
                (name, data, now, now))
            db.commit()
            sid = cur.lastrowid
    return get_strategy(sid)


def delete_strategy(sid: int) -> bool:
    with _lock:
        db = _db()
        cur = db.execute('DELETE FROM strategies WHERE id = ?', (sid,))
        db.commit()
    return cur.rowcount > 0


# ── Phase 4: backtest runs ──────────────────────────────────────────────────
def create_backtest(name: str, spec: dict) -> int:
    now = time.time()
    with _lock:
        cur = _db().execute(
            'INSERT INTO backtests (name, spec, status, progress, created_at, updated_at) '
            'VALUES (?,?,?,?,?,?)',
            ((name or 'Backtest').strip()[:120], json.dumps(spec), 'running', 0.0, now, now))
        _db().commit()
        return cur.lastrowid


def update_backtest(bt_id: int, status: str | None = None, progress: float | None = None,
                    summary: dict | None = None, error: str | None = None) -> None:
    sets, vals = ['updated_at=?'], [time.time()]
    if status is not None:
        sets.append('status=?'); vals.append(status)
    if progress is not None:
        sets.append('progress=?'); vals.append(float(progress))
    if summary is not None:
        sets.append('summary=?'); vals.append(json.dumps(summary))
    if error is not None:
        sets.append('error=?'); vals.append(str(error)[:500])
    vals.append(bt_id)
    with _lock:
        _db().execute(f'UPDATE backtests SET {", ".join(sets)} WHERE id=?', vals)
        _db().commit()


def add_bt_trades(bt_id: int, trades: list) -> None:
    """trades: [{date, symbol, side, entry_ts, exit_ts, entry, exit, ret, reason}]"""
    if not trades:
        return
    rows = [(bt_id, t['date'], t['symbol'], t['side'], int(t['entry_ts']),
             (int(t['exit_ts']) if t.get('exit_ts') is not None else None),
             float(t['entry']),
             (float(t['exit']) if t.get('exit') is not None else None),
             (float(t['ret']) if t.get('ret') is not None else None),
             t.get('reason'),
             (json.dumps(t['ctx']) if t.get('ctx') else None)) for t in trades]
    with _lock:
        _db().executemany(
            'INSERT INTO backtest_trades (bt_id, date, symbol, side, entry_ts, exit_ts, '
            'entry, exit, ret, reason, ctx) VALUES (?,?,?,?,?,?,?,?,?,?,?)', rows)
        _db().commit()


def get_backtest(bt_id: int, with_trades: bool = True) -> dict | None:
    with _lock:
        row = _db().execute('SELECT * FROM backtests WHERE id=?', (bt_id,)).fetchone()
        tr = (_db().execute('SELECT * FROM backtest_trades WHERE bt_id=? '
                            'ORDER BY entry_ts', (bt_id,)).fetchall()
              if (row and with_trades) else [])
    if not row:
        return None
    out = dict(row)
    out['spec'] = json.loads(out['spec'])
    out['summary'] = json.loads(out['summary']) if out.get('summary') else None
    if with_trades:
        out['trades'] = []
        for r in tr:
            d = dict(r)
            d['ctx'] = json.loads(d['ctx']) if d.get('ctx') else {}
            out['trades'].append(d)
    return out


def list_backtests() -> list:
    with _lock:
        rows = _db().execute(
            'SELECT id, name, status, progress, summary, created_at, updated_at '
            'FROM backtests ORDER BY id DESC LIMIT 100').fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d['summary'] = json.loads(d['summary']) if d.get('summary') else None
        out.append(d)
    return out


def delete_backtest(bt_id: int) -> bool:
    with _lock:
        db = _db()
        cur = db.execute('DELETE FROM backtests WHERE id=?', (bt_id,))
        db.execute('DELETE FROM backtest_trades WHERE bt_id=?', (bt_id,))
        db.commit()
    return cur.rowcount > 0
