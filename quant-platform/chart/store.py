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
    payload.pop('id', None)
    data = json.dumps(payload)
    now = time.time()
    with _lock:
        db = _db()
        if sid:
            db.execute('UPDATE strategies SET name=?, data=?, updated_at=? WHERE id=?',
                       (name, data, now, sid))
            db.commit()
            if db.total_changes == 0:
                sid = None  # id didn't exist → fall through to insert
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
