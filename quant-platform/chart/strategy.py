"""
Strategy engine — Phase 3.

Declarative, visually-buildable trading rules evaluated over the SAME verified
qp primitive math the chart draws (via compare_server.overlay_arrays), so a
signal on the chart is computed from the identical numbers everywhere. This is
also the exact series the Phase 4 backtest will replay day-by-day.

Schema (JSON)
-------------
operand:
  {"kind":"primitive","key":"ma.ema","source":"close","params":{"length":9},"sub":null}
  {"kind":"price","field":"close|open|high|low|hl2|hlc3|ohlc4|volume"}
  {"kind":"const","value": <number>}
rule:
  {"left": operand, "op": OP, "right": operand}     # right ignored for rising/falling
  OP ∈ gt lt ge le eq neq cross_above cross_below rising falling
group:
  {"logic":"AND"|"OR", "rules":[rule|group, ...]}
strategy:
  {"name","description","side":"long"|"short","entry": group, "exit": group}

evaluate() returns entry/exit signal times + chart markers + a quick preview
stat. Full P/L simulation is Phase 4.
"""

from __future__ import annotations

import numpy as np

import tools.compare_server as cs

_OPS = ('gt', 'lt', 'ge', 'le', 'eq', 'neq',
        'cross_above', 'cross_below', 'rising', 'falling')
_UNARY = ('rising', 'falling')
_PRICE_FIELDS = ('close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume')


# ── operand → aligned float array ──────────────────────────────────────────
def _operand_array(operand: dict, bars, ctx) -> np.ndarray:
    if not isinstance(operand, dict):
        raise ValueError('operand must be an object')
    kind = operand.get('kind', 'primitive')
    n = len(bars)
    if kind == 'const':
        try:
            return np.full(n, float(operand.get('value')), dtype=float)
        except (TypeError, ValueError):
            raise ValueError(f'bad const value {operand.get("value")!r}')
    if kind == 'price':
        field = operand.get('field', 'close')
        if field not in _PRICE_FIELDS:
            raise ValueError(f'unknown price field {field!r}')
        return cs._source_series(bars, field)
    if kind == 'primitive':
        key = operand.get('key')
        _, _, lines = cs.overlay_arrays(
            bars, {'key': key, 'source': operand.get('source', 'close'),
                   'params': operand.get('params') or {}}, ctx)
        sub = operand.get('sub')
        if sub:                                   # dict-output primitive line
            for s, arr in lines:
                if s == sub:
                    return arr
            raise ValueError(f'{key} has no output {sub!r}')
        return lines[0][1]
    raise ValueError(f'unknown operand kind {kind!r}')


# ── operator → boolean array ───────────────────────────────────────────────
def _apply_op(op: str, L: np.ndarray, R: np.ndarray) -> np.ndarray:
    if op not in _OPS:
        raise ValueError(f'unknown operator {op!r}')
    prevL = np.concatenate(([np.nan], L[:-1]))
    prevR = np.concatenate(([np.nan], R[:-1]))
    with np.errstate(invalid='ignore'):
        if op == 'gt':   out = L > R
        elif op == 'lt': out = L < R
        elif op == 'ge': out = L >= R
        elif op == 'le': out = L <= R
        elif op == 'eq': out = np.isclose(L, R)
        elif op == 'neq': out = ~np.isclose(L, R)
        elif op == 'cross_above':
            out = (~np.isnan(prevL) & ~np.isnan(prevR)) & (prevL <= prevR) & (L > R)
        elif op == 'cross_below':
            out = (~np.isnan(prevL) & ~np.isnan(prevR)) & (prevL >= prevR) & (L < R)
        elif op == 'rising':
            out = (~np.isnan(prevL)) & (L > prevL)
        elif op == 'falling':
            out = (~np.isnan(prevL)) & (L < prevL)
    out = np.asarray(out, dtype=bool)
    # NaN comparisons must be False (numpy already yields False, but eq/neq via
    # isclose treat NaN oddly — mask any bar with a NaN operand).
    invalid = np.isnan(L) | np.isnan(R)
    if op in _UNARY:
        invalid = np.isnan(L) | np.isnan(prevL)
    out[invalid] = False
    return out


def _eval_rule(rule: dict, bars, ctx) -> np.ndarray:
    op = rule.get('op', 'gt')
    L = _operand_array(rule.get('left'), bars, ctx)
    R = L if op in _UNARY else _operand_array(rule.get('right'), bars, ctx)
    return _apply_op(op, L, R)


def _eval_group(group: dict, bars, ctx) -> np.ndarray:
    n = len(bars)
    rules = (group or {}).get('rules') or []
    if not rules:
        return np.zeros(n, dtype=bool)
    logic = ((group or {}).get('logic') or 'AND').upper()
    parts = []
    for r in rules:
        if 'rules' in r or 'logic' in r:          # nested group
            parts.append(_eval_group(r, bars, ctx))
        else:
            parts.append(_eval_rule(r, bars, ctx))
    stacked = np.vstack(parts)
    return stacked.all(axis=0) if logic == 'AND' else stacked.any(axis=0)


def _edges(mask: np.ndarray) -> np.ndarray:
    """True only on the bar a condition FLIPS false→true (so a condition that
    stays true for 20 bars fires once, not 20 times)."""
    prev = np.concatenate(([False], mask[:-1]))
    return mask & ~prev


# ── collect referenced primitives so the fetch window has enough warm-up ────
def referenced_overlays(strategy: dict) -> list:
    out = []

    def walk_operand(o):
        if isinstance(o, dict) and o.get('kind', 'primitive') == 'primitive' and o.get('key'):
            out.append({'key': o['key'], 'params': o.get('params') or {}})

    def walk_group(g):
        for r in (g or {}).get('rules') or []:
            if 'rules' in r or 'logic' in r:
                walk_group(r)
            else:
                walk_operand(r.get('left'))
                walk_operand(r.get('right'))
    walk_group(strategy.get('entry'))
    walk_group(strategy.get('exit'))
    return out


def _pair_trades(ts, close, entry_ev, exit_ev, side):
    """Naive preview pairing: enter on an entry edge while flat, exit on the
    next exit edge. Return list of (entry_i, exit_i, ret). Directional. This is
    a quick sanity stat only — the real day-by-day sim is Phase 4."""
    trades = []
    in_pos = False
    ei = 0
    for i in range(len(ts)):
        if not in_pos and entry_ev[i]:
            in_pos = True; ei = i
        elif in_pos and exit_ev[i]:
            r = (close[i] - close[ei]) / close[ei]
            if side == 'short':
                r = -r
            trades.append((ei, i, float(r)))
            in_pos = False
    return trades


def evaluate(strategy: dict, symbol: str, tf: str, days: int,
             feed: str = 'polygon', view: str = 'all',
             asof: str | None = None) -> dict:
    from chart import data_manager as dm
    days = dm.required_days(referenced_overlays(strategy), tf, days)
    bars, ts, ctx = cs.prepare_bars(symbol, tf, days, feed, view, asof)
    n = len(bars)
    if n == 0:
        return {'ok': True, 'bars': 0, 'entries': [], 'exits': [],
                'markers': [], 'stats': None, 'first': None, 'last': None}

    side = strategy.get('side', 'long')
    entry_ev = _edges(_eval_group(strategy.get('entry'), bars, ctx))
    exit_ev = _edges(_eval_group(strategy.get('exit'), bars, ctx))
    close = bars['close'].to_numpy(float)

    entry_word = 'Long' if side == 'long' else 'Short'
    markers = []
    for i in np.nonzero(entry_ev)[0]:
        markers.append({'time': int(ts[i]), 'position': 'belowBar',
                        'shape': 'arrowUp', 'color': '#22c55e', 'text': entry_word})
    for i in np.nonzero(exit_ev)[0]:
        markers.append({'time': int(ts[i]), 'position': 'aboveBar',
                        'shape': 'arrowDown', 'color': '#ef5350', 'text': 'Exit'})
    markers.sort(key=lambda x: x['time'])

    trades = _pair_trades(ts, close, entry_ev, exit_ev, side)
    stats = None
    if trades:
        rets = np.array([t[2] for t in trades], float)
        wins = int((rets > 0).sum())
        stats = {'trades': len(trades), 'wins': wins,
                 'win_rate': round(100.0 * wins / len(trades), 1),
                 'avg_return_pct': round(100.0 * float(rets.mean()), 3),
                 'total_return_pct': round(100.0 * float(rets.sum()), 3),
                 'preview': True}

    et = bars.index.tz_convert(cs._ET)
    return {
        'ok': True, 'bars': n, 'side': side,
        'entries': [{'time': int(ts[i])} for i in np.nonzero(entry_ev)[0]],
        'exits':   [{'time': int(ts[i])} for i in np.nonzero(exit_ev)[0]],
        'markers': markers,
        'entry_now': bool(_eval_group(strategy.get('entry'), bars, ctx)[-1]),
        'exit_now':  bool(_eval_group(strategy.get('exit'), bars, ctx)[-1]),
        'stats': stats,
        'first': et[0].strftime('%Y-%m-%d %H:%M ET'),
        'last':  et[-1].strftime('%Y-%m-%d %H:%M ET'),
    }
