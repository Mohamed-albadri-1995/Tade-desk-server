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
  {"left": operand, "op": OP, "right": operand, "op_params": {...}}
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

import numpy as np

import tools.compare_server as cs

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


def _slope_strength(L: np.ndarray, lookback: int) -> np.ndarray:
    """The 'clear slope method'. Fit a least-squares line to a trailing
    `lookback`-bar window; the net modelled move across the window is
    `slope × (lookback-1)`. Divide that by the window's own standard deviation
    to get a scale-free STRENGTH in 'volatility units':

        strength = (net directional move) ÷ (bar-to-bar scatter of the window)

    In a choppy tape the net move is tiny next to the scatter → strength ≈ 0 →
    neither rising nor falling. In a genuine trend the move dominates the
    scatter → large |strength|. Works on price or any indicator, any symbol,
    any timeframe, because it's normalized by the series' own noise."""
    n = len(L)
    out = np.full(n, np.nan)
    w = max(2, int(lookback))
    if n < w:
        return out
    from numpy.lib.stride_tricks import sliding_window_view
    win = sliding_window_view(L, w)                 # (n-w+1, w), aligned to window END
    x = np.arange(w, dtype=float)
    xm = x.mean()
    sxx = ((x - xm) ** 2).sum()
    with np.errstate(invalid='ignore', divide='ignore'):
        ym = win.mean(axis=1, keepdims=True)
        slope = ((x - xm) * (win - ym)).sum(axis=1) / sxx     # value per bar
        move = slope * (w - 1)                                # net move over window
        sd = win.std(axis=1)                                  # window volatility
        strength = np.zeros(len(slope))
        nz = sd > 1e-12
        strength[nz] = move[nz] / sd[nz]
        ramp = (~nz) & (np.abs(move) > 1e-9)                  # smooth ramp, ~no scatter
        strength[ramp] = np.sign(move[ramp]) * 1e9
        out[w - 1:] = strength
    return out


def _slope_flag(L: np.ndarray, op: str, p: dict) -> np.ndarray:
    lookback = int(p.get('lookback', _SLOPE_LOOKBACK))
    thr = float(p.get('min_strength', _SLOPE_MIN_STRENGTH))
    s = _slope_strength(L, lookback)
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


def _eval_rule(rule: dict, bars, ctx) -> np.ndarray:
    op = rule.get('op', 'gt')
    if op not in _OPS:
        raise ValueError(f'unknown operator {op!r}')
    p = rule.get('op_params') or {}
    L = _operand_array(rule.get('left'), bars, ctx)
    if op in _UNARY:
        return _slope_flag(L, op, p)
    R = _operand_array(rule.get('right'), bars, ctx)
    if op in _BOUNCE:
        return _bounce_flag(op, bars, R, p)
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
    if logic == 'THEN':
        return _sequence(parts, int((group or {}).get('window', _SEQ_WINDOW)))
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
