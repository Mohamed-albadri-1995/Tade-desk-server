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


# Keys that _row_to_strategy ADDS to a stored row and that an AUTHORED
# document (a seed file, a Save from the UI) does not contain.
#
# This tuple is the single place that knowledge lives, because forgetting it
# has now broken the same thing twice. Anything derived on read but compared
# on write makes `seed_strategies` see every seed as changed on every startup:
# a perpetual rewrite that also resets whatever the user had set. `tools` did
# it first; `exit_protocol` did it again the moment it was added.
#
# ADD A DERIVED FIELD → ADD IT HERE, in the same edit. logic_audit33 asserts
# that this tuple covers everything a read actually injects, so a future field
# that skips this line fails the suite instead of the box.
# `name` is deliberately NOT here: a read restates it from the row column, but
# it is genuinely part of the authored document and round-trips unchanged.
DERIVED_KEYS = ('id', 'created_at', 'updated_at', 'exit_protocol')


def _row_to_strategy(row: sqlite3.Row) -> dict:
    obj = json.loads(row['data'])
    # Setups saved before tools existed have no key at all. Defaulting here
    # rather than at each call site means a reader never has to distinguish
    # "old setup" from "assigned to nothing" — they are the same thing.
    obj.setdefault('tools', [])
    # The exit contract, on EVERY strategy, declared or derived. Reported here
    # rather than left to each reader: the screener used to infer it, and an
    # inference that is right for some strategies and wrong for others does not
    # fail — it places a real order of the wrong size with the wrong stop.
    try:
        from chart import exit_protocol as _xp
        obj['exit_protocol'] = _xp.normalise(obj)
    except Exception as e:                       # never break a read over it
        obj['exit_protocol'] = {'version': 0, 'ok': False,
                                'errors': [f'could not read the exit: {e}'],
                                'warnings': [], 'legs': [], 'shape': 'unknown'}
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


def normalise_tools(raw) -> list:
    """The scanning tools a setup belongs to — ['T1', 'T2'] — cleaned.

    A setup carries its tools rather than each tool listing its setups, so a
    setup used by three tools is ONE object. The alternative was three copies
    that drift apart the first time one is edited.

    Validated against the live source list rather than a hardcoded T1..T9: the
    sources come from tools.config.json, so a tenth tool works the day it is
    added and a typo is rejected the moment it is typed. An unknown id raises —
    silently dropping it would produce a setup that backtests against a smaller
    universe than the one written down, and the result would look fine.

    An EMPTY list is legal and means "not assigned yet". That is a real state:
    a setup is usually built and backtested before anyone decides which tools it
    belongs to, and refusing to save one would put the decision before the
    evidence.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [x for x in raw.replace(',', ' ').split() if x]
    if not isinstance(raw, (list, tuple)):
        raise ValueError('tools must be a list of tool ids, e.g. ["T1","T2"]')

    from chart import screener as sc
    known = {str(x.get('id', '')).upper(): str(x.get('id')) for x in (sc.sources() or [])}

    out = []
    for item in raw:
        tid = str(item or '').strip().upper()
        if not tid:
            continue
        if tid not in known:
            raise ValueError(
                f'unknown tool {tid!r} — configured tools are '
                f'{", ".join(sorted(known.values())) or "(none)"}')
        real = known[tid]
        if real not in out:            # order kept, first mention wins
            out.append(real)
    return out


def save_strategy(obj: dict) -> dict:
    """Insert or update. `obj` is the full strategy JSON; if it carries an
    `id`, that row is updated, else a new row is created. Returns the saved
    strategy (with id)."""
    name = (obj.get('name') or 'Untitled strategy').strip()[:120]
    sid = obj.get('id')
    payload = dict(obj)
    # Normalised on the way IN, so every reader — backtest, alerts, the UI —
    # sees the same cleaned list and none of them has to defend against 't1 '
    # or a duplicate. Raises on an unknown id; the route reports it.
    payload['tools'] = normalise_tools(obj.get('tools'))
    # strip store metadata so a load→edit→save cycle doesn't embed stale
    # copies of it inside the strategy document itself
    # `exit_protocol` is DERIVED on every read. Storing it would freeze a copy
    # that stops matching the risk block the moment either is edited — the
    # two-copies problem this whole design exists to avoid.
    for meta in DERIVED_KEYS:
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


def set_tools(sid: int, raw) -> dict | None:
    """Assign a strategy's tools, and touch nothing else about it.

    Saving means writing the whole document back, which is right for the
    builder and wrong for assignment: another process would have to round-trip
    every rule to change one field, and a bug in that round trip rewrites the
    logic that was backtested without saying so. This reads the stored
    document, replaces one key and writes it back.

    Returns None when there is no such strategy — a missing one must be
    reported, not created, or a typo in an id silently produces a second
    strategy that nothing runs. Raises on an unknown tool id, same as saving.
    """
    s = get_strategy(sid)
    if not s:
        return None
    s['tools'] = normalise_tools(raw)
    return save_strategy(s)


def delete_strategy(sid: int) -> bool:
    with _lock:
        db = _db()
        cur = db.execute('DELETE FROM strategies WHERE id = ?', (sid,))
        db.commit()
    return cur.rowcount > 0


def seed_strategies() -> int:
    """Sync the bundled seed strategies (chart/seeds/*.json) into the DB on
    every startup. These 5 are OUR canonical, maintained strategies: a stored
    copy is REFRESHED to the current bundled definition (same id kept) whenever
    it differs, so engine/exit/scale-out updates actually reach them. Insert if
    missing. To customize, Save-As under a NEW name — that name is never a
    bundled seed, so it is never touched.

    A seed carrying `"_keep_user_edits": true` is RESTORE-ONLY: inserted when
    absent (so a fresh box gets it back) but never overwritten afterwards, so
    edits made in the browser survive a restart. Returns how many were
    inserted/updated.
    """
    seeds_dir = Path(__file__).resolve().parent / 'seeds'
    if not seeds_dir.is_dir():
        return 0
    by_name = {s['name']: s for s in list_strategies()}
    changed = 0
    for f in sorted(seeds_dir.glob('*.json')):
        try:
            docs = json.loads(f.read_text())
        except Exception:
            continue
        for obj in (docs if isinstance(docs, list) else [docs]):
            name = (obj.get('name') or '').strip()
            if not name:
                continue
            payload = {k: v for k, v in obj.items() if k != 'id'}
            payload['_seed'] = True                # mark as a bundled seed
            cur = by_name.get(name)
            if cur is None:
                save_strategy(payload); changed += 1
                continue
            # `_keep_user_edits`: RESTORE-ONLY seed. It is bundled so a fresh
            # box (or a wiped platform.db) gets it back, but once it exists the
            # stored copy WINS — edits made in the browser survive restarts.
            # Use it for the user's own strategies; leave it off for OUR
            # canonical scalps, which must track the bundle.
            if obj.get('_keep_user_edits'):
                continue
            # compare the AUTHORED document only — never a field a read derived
            stored = {k: v for k, v in cur.items() if k not in DERIVED_KEYS}
            # WHICH TOOLS run a setup is decided in the UI, not in the bundle:
            # the seed files carry no `tools`, while every stored row reports at
            # least [] (see _row_to_strategy). Comparing those two directly made
            # EVERY seed differ on EVERY startup — a perpetual "refresh" that
            # also overwrote the assignment made on the alerts page, so a setup
            # assigned to T2 came back unassigned after each deploy and its
            # tools-universe backtest then failed with "not assigned to any
            # tool yet". The stored assignment wins; the bundle's only seeds a
            # row that does not exist yet (the insert path above).
            payload['tools'] = cur.get('tools') or []
            if stored != payload:                  # bundle changed → refresh in place
                payload['id'] = cur['id']
                save_strategy(payload); changed += 1
    return changed


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
