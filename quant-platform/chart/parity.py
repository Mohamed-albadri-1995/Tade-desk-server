"""Was the strategy that trades today the strategy that was backtested?

Reported as: "some strategies like Test and 935 ... even in backtesting they
state something but what really backtested is different."

A backtest keeps a frozen copy of every strategy it ran (`_strategy_docs`,
written by POST /api/backtest). The strategy itself keeps changing — a stop
tightened in the builder, a target moved, a window shifted — and nothing ever
put the two side by side. So a backtest from last week kept being read as
evidence about a strategy that no longer existed.

This module answers two questions for the desk:

  latest_for(ids)   the newest finished backtest that ran any of these
                    strategies, with its settings (spec) and headline numbers
  rules_diff(...)   every rule that differs between the copy that backtest
                    ran and the strategy as it is saved now

It reads; it never edits a strategy or a run. A run too old to carry a frozen
copy is reported as `frozen: False` — "cannot tell", never "unchanged".
"""
import json

from chart import store

# Bookkeeping, not rules: editing these changes nothing a trade does.
_IGNORE = {'id', 'name', 'updated_at', 'created_at', 'stage', 'tools',
           'exit_protocol', 'notes', 'description', 'tags', 'color'}

# How far back to look. A strategy's last run is almost always recent; this
# bounds the cost of a strategy that was never run at all.
_SCAN = 300


def _ids_in(spec: dict) -> set:
    """Every strategy id a run's spec refers to, however it named them."""
    out = set()

    def add(v):
        try:
            out.add(int(v))
        except (TypeError, ValueError):
            pass

    add(spec.get('strategy_id'))
    for v in spec.get('strategy_ids') or []:
        add(v)
    for v in spec.get('strategies') or []:
        add(v.get('id') if isinstance(v, dict) else v)
    s = spec.get('strategy')
    if isinstance(s, dict):
        add(s.get('id'))
    for d in spec.get('_strategy_docs') or []:
        if isinstance(d, dict):
            add(d.get('id'))
    return out


def latest_for(ids) -> dict | None:
    """The newest finished backtest that ran any of `ids`, or None."""
    want = set()
    for i in ids or []:
        try:
            want.add(int(i))
        except (TypeError, ValueError):
            pass
    if not want:
        return None
    with store._lock:
        rows = store._db().execute(
            "SELECT id, name, spec, summary, status, created_at FROM backtests "
            "WHERE status = 'done' ORDER BY id DESC LIMIT ?", (_SCAN,)).fetchall()
    for r in rows:
        try:
            spec = json.loads(r['spec'])
        except Exception:                       # a bad row is skipped, not fatal
            continue
        if _ids_in(spec) & want:
            try:
                summary = json.loads(r['summary']) if r['summary'] else None
            except Exception:
                summary = None
            return {'id': r['id'], 'name': r['name'], 'created_at': r['created_at'],
                    'spec': spec, 'summary': summary}
    return None


def _short(v, n=80) -> str:
    s = json.dumps(v, sort_keys=True, default=str)
    return s if len(s) <= n else s[:n - 1] + '…'


def _walk(a, b, path, out, limit):
    if len(out) >= limit:
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            # Top-level bookkeeping, and any private '_' flag the store adds
            # (`_user_edited` is set by pressing Save, which is not an edit).
            if not path and (k in _IGNORE or str(k).startswith('_')):
                continue
            _walk(a.get(k), b.get(k), f'{path}.{k}' if path else k, out, limit)
        return
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            _walk(x, y, f'{path}[{i}]', out, limit)
        return
    if a != b:
        out.append({'path': path, 'then': _short(a), 'now': _short(b)})


def rules_diff(spec: dict, strategies: list, limit: int = 25) -> list:
    """For each current strategy: what differs from the copy the run used."""
    docs = {}
    for d in (spec or {}).get('_strategy_docs') or []:
        if isinstance(d, dict) and d.get('id') is not None:
            docs[int(d['id'])] = d
    out = []
    for s in strategies or []:
        sid = s.get('id')
        then = docs.get(int(sid)) if sid is not None else None
        if then is None:
            out.append({'strategy_id': sid, 'name': s.get('name'),
                        'frozen': False, 'changed': [],
                        'note': 'this run kept no copy of the strategy '
                                '(older than the snapshot) — cannot tell '
                                'whether it changed since'})
            continue
        changed = []
        _walk(then, s, '', changed, limit)
        out.append({'strategy_id': sid, 'name': s.get('name'), 'frozen': True,
                    'changed': changed, 'truncated': len(changed) >= limit})
    return out


def report(ids) -> dict:
    """What the desk's parity check asks for, in one answer."""
    strategies = [s for s in (store.get_strategy(int(i)) for i in ids or [])
                  if s]
    bt = latest_for(ids)
    if not bt:
        return {'ok': True, 'backtest': None,
                'rules': [], 'note': 'no finished backtest has run this strategy'}
    rules = rules_diff(bt['spec'], strategies)
    spec = {k: v for k, v in bt['spec'].items() if k != '_strategy_docs'}
    return {'ok': True,
            'backtest': {'id': bt['id'], 'name': bt['name'],
                         'created_at': bt['created_at'], 'spec': spec,
                         'summary': bt['summary']},
            'rules': rules}
