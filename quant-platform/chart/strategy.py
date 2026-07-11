"""
Strategy engine — Phase 3.

Declarative, visually-buildable trading rules evaluated over the SAME verified
qp primitive math the chart draws (via compare_server.overlay_arrays), so a
signal on the chart is computed from the identical numbers everywhere. This is
also the exact series the Phase 4 backtest will replay day-by-day.

Schema (JSON)
-------------
operand:                                    (any operand may add "offset": n = n bars ago)
  {"kind":"primitive","key":"ma.ema","source":"close","params":{"length":9},"sub":null}
  {"kind":"price","field":"close|open|high|low|hl2|hlc3|ohlc4|volume"}
  {"kind":"time","field":"minutes|hhmm|hour|minute"}   # ET bar time-of-day
  {"kind":"const","value": <number>}
rule:
  {"left": operand, "op": OP, "right": operand, "op_params": {...},
   "for_bars": N,       # true only if it held on ALL of the last N bars
   "within_bars": N}    # true if it held on ANY of the last N bars
  OP ∈ gt lt ge le eq neq cross_above cross_below rising falling bounce_up bounce_down
    rising/falling  — regression slope of `left` over op_params.lookback bars,
                      measured as net move ÷ window volatility, is ≥ / ≤
                      op_params.min_strength. A flat/choppy series is NEITHER
                      (strength ~0). right ignored.
    bounce_up/down  — the price bar bounces off `right` (an MA/level): a wick comes
                      within op_params.tol_pct of it and the bar closes back on the
                      right side (support held / resistance held).
group:
  {"logic":"AND"|"OR"|"THEN", "window": N, "rules":[rule|group, ...]}
    AND all match · OR any match · THEN steps happen IN ORDER, each within
    `window` bars of the previous (sequence logic).
strategy:
  {"name","description","side":"long"|"short","entry": group, "exit": group}

evaluate() returns entry/exit signal times + chart markers + a quick preview
stat. Full P/L simulation is Phase 4.
"""

from __future__ import annotations

import json

import numpy as np

import tools.compare_server as cs

_IND_PALETTE = ['#3b82f6', '#f5a623', '#a855f7', '#ec4899', '#06b6d4',
                '#eab308', '#14b8a6', '#f97316', '#e879f9', '#84cc16']

_OPS = ('gt', 'lt', 'ge', 'le', 'eq', 'neq',
        'cross_above', 'cross_below', 'rising', 'falling',
        'bounce_up', 'bounce_down')
_UNARY = ('rising', 'falling')          # right operand ignored
_BOUNCE = ('bounce_up', 'bounce_down')  # left = price bar, right = reference level
_PRICE_FIELDS = ('close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume')

# Defaults for the configurable operators (overridable per rule via op_params).
_SLOPE_LOOKBACK = 8       # bars in the regression window
_SLOPE_MIN_STRENGTH = 1.5 # min |net move ÷ window volatility| to count as a trend
_BOUNCE_TOL_PCT = 0.15    # how close (in %) the wick must come to the level to "touch"
_SEQ_WINDOW = 10          # max bars between consecutive steps of a THEN sequence


def _merge_defaults(key: str, params: dict) -> dict:
    """Return the primitive's params with registry defaults filled in AND any
    unknown keys dropped — the builder only exposes the length-like param, so
    others (e.g. BB's `mult`) must fall back to defaults, and a stale/extra key
    from an old saved strategy must not crash the primitive call."""
    src = dict(params or {})
    m = cs.REGISTRY.get(key)
    if not m:
        return src
    names = {p.name for p in m.params}
    out = {p.name: src.get(p.name, p.default) for p in m.params}
    # keep only known params (drops anything not in the signature)
    return {k: v for k, v in out.items() if k in names}


def _shift(arr: np.ndarray, offset: int) -> np.ndarray:
    """Value `offset` bars ago (Pine's series[offset]); NaN for the first
    `offset` bars. offset<=0 → unchanged. If offset ≥ length, the whole series
    is 'before the start' → all-NaN (same length), never a wrong-length array."""
    off = int(offset or 0)
    if off <= 0:
        return arr
    n = len(arr)
    if off >= n:
        return np.full(n, np.nan)
    return np.concatenate((np.full(off, np.nan), arr[:-off]))


# ── operand → aligned float array ──────────────────────────────────────────
def _operand_array(operand: dict, bars, ctx) -> np.ndarray:
    if not isinstance(operand, dict):
        raise ValueError('operand must be an object')
    kind = operand.get('kind', 'primitive')
    n = len(bars)
    if kind == 'const':
        try:
            base = np.full(n, float(operand.get('value')), dtype=float)
        except (TypeError, ValueError):
            raise ValueError(f'bad const value {operand.get("value")!r}')
    elif kind == 'time':
        # Bar time-of-day in ET, for session windows. field: minutes (since
        # midnight, default), hhmm (930, 1300…), hour, minute.
        et = bars.index.tz_convert(cs._ET)
        hh = np.asarray(et.hour, dtype=float); mm = np.asarray(et.minute, dtype=float)
        field = operand.get('field', 'minutes')
        base = ({'hour': hh, 'minute': mm, 'hhmm': hh * 100 + mm}
                .get(field, hh * 60 + mm))
    elif kind == 'price':
        field = operand.get('field', 'close')
        if field not in _PRICE_FIELDS:
            raise ValueError(f'unknown price field {field!r}')
        base = cs._source_series(bars, field)
    elif kind == 'expr':
        # Arithmetic combining — the general tool. a <op> b, recursive, so any
        # derived quantity is composed, not hard-coded as a primitive:
        #   body% = candle.body ÷ candle.bar_range × 100
        #   move in ATR = (close − day_open) ÷ atr_daily
        #   distance to R1 = close − floor·R1
        a = _operand_array(operand.get('a'), bars, ctx)
        b = _operand_array(operand.get('b'), bars, ctx)
        eop = operand.get('op', 'sub')
        with np.errstate(invalid='ignore', divide='ignore'):
            if eop == 'add':   base = a + b
            elif eop == 'sub': base = a - b
            elif eop == 'mul': base = a * b
            elif eop == 'div': base = np.where(b != 0, a / b, np.nan)
            else:
                raise ValueError(f'unknown expr op {eop!r}')
    elif kind == 'primitive':
        key = operand.get('key')
        _, _, lines = cs.overlay_arrays(
            bars, {'key': key, 'source': operand.get('source', 'close'),
                   'params': _merge_defaults(key, operand.get('params'))}, ctx)
        sub = operand.get('sub')
        if sub:                                   # dict-output primitive line
            base = next((arr for s, arr in lines if s == sub), None)
            if base is None:
                raise ValueError(f'{key} has no output {sub!r}')
        else:
            base = lines[0][1]
    else:
        raise ValueError(f'unknown operand kind {kind!r}')
    return _shift(np.asarray(base, dtype=float), operand.get('offset', 0))


# ── comparison / cross operators → boolean array ───────────────────────────
def _apply_op(op: str, L: np.ndarray, R: np.ndarray) -> np.ndarray:
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
        else:
            raise ValueError(f'unknown operator {op!r}')
    out = np.asarray(out, dtype=bool)
    out[np.isnan(L) | np.isnan(R)] = False   # any NaN operand → False
    return out


def _slope_flag(L: np.ndarray, op: str, p: dict) -> np.ndarray:
    # Same math as the plottable `trend.slope` primitive — one source of truth,
    # so what you SEE when you plot slope is exactly what rising/falling tests.
    from qp.primitives.trend import slope_strength
    lookback = int(p.get('lookback', _SLOPE_LOOKBACK))
    thr = float(p.get('min_strength', _SLOPE_MIN_STRENGTH))
    s = slope_strength(L, lookback)
    with np.errstate(invalid='ignore'):
        out = (s >= thr) if op == 'rising' else (s <= -thr)
    out = np.asarray(out, dtype=bool)
    out[np.isnan(s)] = False
    return out


def _bounce_flag(op: str, bars, R: np.ndarray, p: dict) -> np.ndarray:
    """Price bounces off a reference level R (an MA / level, the right operand).
    A real bounce isn't just 'near the level' — it must (1) come FROM the right
    side (so it's a pullback to support/resistance, not a breakout through it),
    (2) TOUCH within `tol_pct` of R with its wick, and (3) TURN back, closing on
    the original side with momentum. bounce_up = support held; bounce_down =
    resistance held. Guarding on 'from above/below' is what stops it from firing
    every bar when price is hugging the level."""
    tol = float(p.get('tol_pct', _BOUNCE_TOL_PCT)) / 100.0
    low = bars['low'].to_numpy(float);   high = bars['high'].to_numpy(float)
    close = bars['close'].to_numpy(float)
    prev_close = np.concatenate(([np.nan], close[:-1]))
    prev_R = np.concatenate(([np.nan], R[:-1]))
    with np.errstate(invalid='ignore'):
        if op == 'bounce_up':
            from_above = prev_close >= prev_R           # was on/above support
            touched = low <= R * (1 + tol)              # wick dipped to it
            held = close > R                            # closed back above
            turning = close > prev_close                # bounced up
            out = from_above & touched & held & turning
        else:
            from_below = prev_close <= prev_R           # was on/below resistance
            touched = high >= R * (1 - tol)             # wick poked up to it
            held = close < R                            # closed back below
            turning = close < prev_close                # rejected down
            out = from_below & touched & held & turning
    out = np.asarray(out, dtype=bool)
    out[np.isnan(R) | np.isnan(prev_R) | np.isnan(prev_close)] = False
    return out


def _sequence(parts: list, window: int) -> np.ndarray:
    """THEN logic: the steps must occur IN ORDER, each within `window` bars of
    the previous one. Fires on the bar the final step completes. e.g.
    'close > ma13' THEN 'close bounce_up ma13' = was above, dipped, bounced."""
    n = len(parts[0]); k = len(parts)
    fire = np.zeros(n, dtype=bool)
    if k == 1:
        return parts[0].copy()
    last = [-10 ** 9] * k        # most recent in-sequence completion bar per step
    for i in range(n):
        prev = last.copy()       # state BEFORE this bar → enforces t_{j-1} < t_j
        if parts[0][i]:
            last[0] = i
        for j in range(1, k):
            if parts[j][i] and prev[j - 1] >= 0 and 0 < (i - prev[j - 1]) <= window:
                last[j] = i
        if last[k - 1] == i and parts[k - 1][i]:
            fire[i] = True
    return fire


def _rolling(mask: np.ndarray, n: int, mode: str) -> np.ndarray:
    """`for_bars`: true only if the condition held on ALL of the last n bars
    (sustained). `within_bars`: true if it held on ANY of the last n bars."""
    if n <= 1:
        return mask
    from numpy.lib.stride_tricks import sliding_window_view
    out = np.zeros(len(mask), dtype=bool)
    if len(mask) < n:
        return out
    sums = sliding_window_view(mask.astype(int), n).sum(axis=1)
    out[n - 1:] = (sums == n) if mode == 'all' else (sums > 0)
    return out


def _eval_rule(rule: dict, bars, ctx) -> np.ndarray:
    op = rule.get('op', 'gt')
    if op not in _OPS:
        raise ValueError(f'unknown operator {op!r}')
    p = rule.get('op_params') or {}
    L = _operand_array(rule.get('left'), bars, ctx)
    if op in _UNARY:
        out = _slope_flag(L, op, p)
    else:
        R = _operand_array(rule.get('right'), bars, ctx)
        out = _bounce_flag(op, bars, R, p) if op in _BOUNCE else _apply_op(op, L, R)
    # sustained modifiers: held for the last N bars / true within the last N.
    fb = int(rule.get('for_bars', 0) or 0)
    wb = int(rule.get('within_bars', 0) or 0)
    if fb > 1:
        out = _rolling(out, fb, 'all')
    elif wb > 1:
        out = _rolling(out, wb, 'any')
    return out


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
    if logic == 'THEN':
        return _sequence(parts, int((group or {}).get('window', _SEQ_WINDOW)))
    stacked = np.vstack(parts)
    if logic == 'ATLEAST':                        # K-of-N scoring
        k = int((group or {}).get('k', 1))
        return stacked.sum(axis=0) >= k
    return stacked.any(axis=0) if logic == 'OR' else stacked.all(axis=0)


def _edges(mask: np.ndarray) -> np.ndarray:
    """True only on the bar a condition FLIPS false→true (so a condition that
    stays true for 20 bars fires once, not 20 times)."""
    prev = np.concatenate(([False], mask[:-1]))
    return mask & ~prev


# ── collect referenced primitives (for warm-up sizing AND for plotting) ─────
def referenced_overlays(strategy: dict) -> list:
    out = []

    def walk_operand(o):
        if not isinstance(o, dict):
            return
        if o.get('kind') == 'expr':
            walk_operand(o.get('a')); walk_operand(o.get('b')); return
        if o.get('kind', 'primitive') == 'primitive' and o.get('key'):
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


def _unique_indicators(strategy: dict) -> list:
    """Distinct primitive operands (key + source + params) referenced anywhere
    in the strategy, so the chart can DRAW the exact indicators the rules use."""
    seen, out = set(), []

    def add(o):
        if not isinstance(o, dict):
            return
        if o.get('kind') == 'expr':
            add(o.get('a')); add(o.get('b')); return
        if o.get('kind', 'primitive') == 'primitive' and o.get('key'):
            spec = {'key': o['key'], 'source': o.get('source', 'close'),
                    'params': o.get('params') or {}}
            k = json.dumps(spec, sort_keys=True)
            if k not in seen:
                seen.add(k); out.append(spec)

    def walk(g):
        for r in (g or {}).get('rules') or []:
            if 'rules' in r or 'logic' in r:
                walk(r)
            else:
                add(r.get('left')); add(r.get('right'))
    walk(strategy.get('entry')); walk(strategy.get('exit'))
    return out


def _indicator_series(strategy: dict, bars, ts, ctx) -> list:
    series = []
    for i, spec in enumerate(_unique_indicators(strategy)):
        try:
            series.extend(cs._one_overlay(
                bars, ts, {**spec, 'params': _merge_defaults(spec['key'], spec['params']),
                           'id': f'strat{i}',
                           'color': _IND_PALETTE[i % len(_IND_PALETTE)]}, ctx))
        except Exception:  # noqa: BLE001 — a missing-history indicator just won't draw
            pass
    return series


def _risk_dist(spec: dict, entry: float, atr: float):
    """Absolute price distance for a stop/target spec {type,value}. type:
    pct (% of entry), atr (× ATR at entry), points (absolute). None = unset."""
    if not spec:
        return None
    try:
        v = float(spec.get('value'))
    except (TypeError, ValueError):
        return None
    t = spec.get('type', 'pct')
    if t == 'pct':
        return entry * v / 100.0
    if t == 'atr':
        return (atr if atr == atr else 0.0) * v      # NaN-safe
    if t == 'points':
        return v
    return None


def _pair_trades(bars, ts, entry_ev, exit_ev, side, risk, ctx):
    """Preview pairing with STOP-LOSS and TAKE-PROFIT. Enter on an entry edge
    while flat; then exit at whichever comes first, intrabar: SL hit, TP hit, or
    an exit-condition edge. SL is checked before TP (conservative when both fall
    in one bar). Returns trades with entry/exit price + reason. The full
    day-by-day sim is Phase 4; this makes the preview honest about stops."""
    close = bars['close'].to_numpy(float)
    high = bars['high'].to_numpy(float)
    low = bars['low'].to_numpy(float)
    n = len(close)
    risk = risk or {}
    atr = np.full(n, np.nan)
    if (risk.get('sl') or {}).get('type') == 'atr' or (risk.get('tp') or {}).get('type') == 'atr':
        try:
            _, _, lines = cs.overlay_arrays(
                bars, {'key': 'volatility.atr', 'source': 'close', 'params': {'length': 14}}, ctx)
            atr = lines[0][1]
        except Exception:
            pass
    trades = []
    in_pos = False; ei = 0; sl = tp = None
    for j in range(n):
        if not in_pos:
            if entry_ev[j]:
                in_pos = True; ei = j
                ep = close[j]
                sd = _risk_dist(risk.get('sl'), ep, atr[j])
                td = _risk_dist(risk.get('tp'), ep, atr[j])
                if side == 'long':
                    sl = ep - sd if sd else None; tp = ep + td if td else None
                else:
                    sl = ep + sd if sd else None; tp = ep - td if td else None
            continue
        px = reason = None
        if sl is not None and ((side == 'long' and low[j] <= sl) or (side == 'short' and high[j] >= sl)):
            px, reason = sl, 'SL'
        elif tp is not None and ((side == 'long' and high[j] >= tp) or (side == 'short' and low[j] <= tp)):
            px, reason = tp, 'TP'
        elif exit_ev[j]:
            px, reason = close[j], 'exit'
        if px is not None:
            r = (px - close[ei]) / close[ei]
            if side == 'short':
                r = -r
            trades.append({'ei': ei, 'xi': j, 'ret': float(r), 'reason': reason,
                           'entry': float(close[ei]), 'exit': float(px)})
            in_pos = False
    return trades


def test_condition(node: dict, symbol: str, tf: str, days: int,
                   feed: str = 'polygon', view: str = 'all',
                   asof: str | None = None) -> dict:
    """Evaluate a SINGLE rule (or group) and mark EVERY bar where it holds —
    for validating a condition ('slope of 13-MA', 'bounce off 5-DMA', 'break of
    resistance') before wiring it into a strategy. Returns a dot marker on each
    true bar, the count, the % of bars true, and whether it's true right now."""
    from chart import data_manager as dm
    strat_like = {'entry': node if ('rules' in node or 'logic' in node)
                  else {'logic': 'AND', 'rules': [node]}}
    days = dm.required_days(referenced_overlays(strat_like), tf, days)
    bars, ts, ctx = cs.prepare_bars(symbol, tf, days, feed, view, asof)
    n = len(bars)
    if n == 0:
        return {'ok': True, 'bars': 0, 'true': 0, 'markers': [], 'now': False}
    is_group = ('rules' in node or 'logic' in node)
    mask = _eval_group(node, bars, ctx) if is_group else _eval_rule(node, bars, ctx)
    idx = np.nonzero(mask)[0]
    markers = [{'time': int(ts[i]), 'position': 'aboveBar', 'shape': 'circle',
                'color': '#3b82f6', 'text': ''} for i in idx]
    # Draw the exact indicators this condition reads (so you SEE the values, not
    # just the fire dots) + the current value of the left operand.
    series = _indicator_series(strat_like, bars, ts, ctx)
    left_now = right_now = None
    if not is_group and isinstance(node.get('left'), dict):
        try:
            la = _operand_array(node['left'], bars, ctx)
            if la[-1] == la[-1]:
                left_now = round(float(la[-1]), 4)
            # a composed (expr) left value isn't a registry primitive, so draw
            # it explicitly — otherwise you couldn't SEE the computed number.
            if node['left'].get('kind') == 'expr':
                vals = [{'time': int(t), 'value': float(v)} for t, v in zip(ts, la) if v == v]
                if vals:
                    series = list(series) + [{'name': 'expr', 'color': '#eab308',
                                              'style': 0, 'step': False, 'values': vals}]
        except Exception:
            pass
    if not is_group and isinstance(node.get('right'), dict) and node.get('op') not in _UNARY:
        try:
            ra = _operand_array(node['right'], bars, ctx)
            if ra[-1] == ra[-1]:
                right_now = round(float(ra[-1]), 4)
        except Exception:
            pass
    et = bars.index.tz_convert(cs._ET)
    return {'ok': True, 'bars': n, 'true': int(mask.sum()),
            'pct': round(100.0 * mask.sum() / n, 1), 'now': bool(mask[-1]),
            'markers': markers, 'series': series,
            'left_now': left_now, 'right_now': right_now,
            'first': et[0].strftime('%Y-%m-%d %H:%M ET'),
            'last': et[-1].strftime('%Y-%m-%d %H:%M ET')}


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
    entry_mask = _eval_group(strategy.get('entry'), bars, ctx)
    exit_mask = _eval_group(strategy.get('exit'), bars, ctx)
    entry_ev = _edges(entry_mask)
    exit_ev = _edges(exit_mask)

    trades = _pair_trades(bars, ts, entry_ev, exit_ev, side, strategy.get('risk'), ctx)

    up_shape = 'arrowUp' if side == 'long' else 'arrowDown'
    up_pos = 'belowBar' if side == 'long' else 'aboveBar'
    markers = []
    # Every bar the ENTRY condition fires (clean arrow, no repeated text label —
    # keeps a dense chart readable). Shown even if nothing "closes".
    for i in np.nonzero(entry_ev)[0]:
        markers.append({'time': int(ts[i]), 'position': up_pos,
                        'shape': up_shape, 'color': '#22c55e', 'text': ''})
    # ...plus the exit of each taken trade — THIS carries the reason label.
    for t in trades:
        col = {'SL': '#ef5350', 'TP': '#22c55e', 'exit': '#94a3b8'}.get(t['reason'], '#ef5350')
        markers.append({'time': int(ts[t['xi']]),
                        'position': 'aboveBar' if side == 'long' else 'belowBar',
                        'shape': 'arrowDown' if side == 'long' else 'arrowUp',
                        'color': col, 'text': t['reason']})
    markers.sort(key=lambda x: x['time'])

    stats = None
    if trades:
        rets = np.array([t['ret'] for t in trades], float)
        wins = int((rets > 0).sum())
        by = {}
        for t in trades:
            by[t['reason']] = by.get(t['reason'], 0) + 1
        stats = {'trades': len(trades), 'wins': wins,
                 'win_rate': round(100.0 * wins / len(trades), 1),
                 'avg_return_pct': round(100.0 * float(rets.mean()), 3),
                 'total_return_pct': round(100.0 * float(rets.sum()), 3),
                 'exits_by': by, 'preview': True}

    et = bars.index.tz_convert(cs._ET)
    return {
        'ok': True, 'bars': n, 'side': side,
        'entries': [{'time': int(ts[i])} for i in np.nonzero(entry_ev)[0]],
        'exits':   [{'time': int(ts[i])} for i in np.nonzero(exit_ev)[0]],
        'markers': markers,
        'series':  _indicator_series(strategy, bars, ts, ctx),
        'entry_now': bool(entry_mask[-1]),
        'exit_now':  bool(exit_mask[-1]),
        'stats': stats,
        'first': et[0].strftime('%Y-%m-%d %H:%M ET'),
        'last':  et[-1].strftime('%Y-%m-%d %H:%M ET'),
    }
