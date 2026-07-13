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
  {"kind":"trade","field":"entry|bars|pnl_pct"}  # THE OPEN POSITION (exit rules
                        # only): entry price / bars held / unrealized P&L% —
                        # evaluated per trade, each trade sees its own entry
rule:
  {"left": operand, "op": OP, "right": operand, "op_params": {...},
   "for_bars": N,       # true only if it held on ALL of the last N bars
   "within_bars": N,    # true if it held on ANY of the last N bars
   "offset": N}         # SIGNAL shift: the condition was true N bars AGO
                        # (applied after for/within; operand offsets shift
                        # values, this shifts the rule's own result)
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

_OPS = ('gt', 'lt', 'ge', 'le', 'eq', 'neq', 'gt_pct', 'lt_pct',
        'cross_above', 'cross_below', 'rising', 'falling',
        'bounce_up', 'bounce_down')
_UNARY = ('rising', 'falling')          # right operand ignored
_BOUNCE = ('bounce_up', 'bounce_down')  # left = price bar, right = reference level
_PRICE_FIELDS = ('close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume')

# Defaults for the configurable operators (overridable per rule via op_params).
_SLOPE_LOOKBACK = 12      # bars in the regression window
_SLOPE_MIN_STRENGTH = 2.0 # min |net move ÷ residual noise| to count as a trend
                          # (pure noise reads |strength|≈0.9, so 2.0 ≈ "clearly a trend":
                          # chop false-fires ~3-4%, real trends score 5-50+)
_BOUNCE_TOL_PCT = 0.15    # how close (in %) the wick must come to the level to "touch"
_BOUNCE_CLOSE_POS = 0.6   # bounce bar must close in the top 60% of its own range
                          # (bottom 60% for bounce_down) — touch-and-GO, not a doji
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
def _operand_array(operand: dict, bars, ctx, trade: dict | None = None) -> np.ndarray:
    if not isinstance(operand, dict):
        raise ValueError('operand must be an object')
    kind = operand.get('kind', 'primitive')
    n = len(bars)
    if kind == 'trade':
        # THE POSITION ITSELF as an operand — exit rules only. Evaluated per
        # trade inside the pairing loop, so each trade sees its OWN entry.
        #   entry   → the trade's entry price (flat line)
        #   bars    → bars held so far (0 on the entry bar) — time stops
        #   pnl_pct → unrealized P&L % since entry, signed by side
        if not trade:
            raise ValueError('Trade fields (entry/bars/P&L) only exist inside '
                             'a position — use them in EXIT rules, not entry')
        field = operand.get('field', 'pnl_pct')
        close = bars['close'].to_numpy(float)
        if field == 'entry':
            base = np.full(n, float(trade['entry']))
        elif field == 'bars':
            base = np.arange(n, dtype=float) - float(trade['ei'])
        elif field == 'pnl_pct':
            sgn = -1.0 if trade.get('side') == 'short' else 1.0
            base = sgn * (close - float(trade['entry'])) / float(trade['entry']) * 100.0
        else:
            raise ValueError(f'unknown trade field {field!r}')
        return _shift(base, operand.get('offset', 0))
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
        a = _operand_array(operand.get('a'), bars, ctx, trade)
        b = _operand_array(operand.get('b'), bars, ctx, trade)
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
def _apply_op(op: str, L: np.ndarray, R: np.ndarray, p: dict | None = None) -> np.ndarray:
    p = p or {}
    prevL = np.concatenate(([np.nan], L[:-1]))
    prevR = np.concatenate(([np.nan], R[:-1]))
    with np.errstate(invalid='ignore'):
        if op == 'gt':   out = L > R
        elif op == 'lt': out = L < R
        elif op == 'ge': out = L >= R
        elif op == 'le': out = L <= R
        elif op == 'eq': out = np.isclose(L, R)
        elif op == 'neq': out = ~np.isclose(L, R)
        elif op == 'gt_pct':
            # above by AT LEAST pct% of the reference's MAGNITUDE:
            # L ≥ R + |R|·pct/100. 'gt' answers "is it above?"; this answers
            # "is it MEANINGFULLY above?". |R| (not R) keeps the margin on the
            # correct side when the reference is NEGATIVE (slope, expr diffs).
            out = L >= R + np.abs(R) * float(p.get('pct', 0.0)) / 100.0
        elif op == 'lt_pct':
            out = L <= R - np.abs(R) * float(p.get('pct', 0.0)) / 100.0
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
    # how decisively the bar must close AWAY from the level: the close must sit
    # in the top `close_pos` fraction of the bar's range for bounce_up (bottom
    # for bounce_down). Kills the doji/long-wick case — a bar that merely
    # TOUCHED and closed mid-range is not a bounce.
    cpos = float(p.get('close_pos', _BOUNCE_CLOSE_POS))
    low = bars['low'].to_numpy(float);   high = bars['high'].to_numpy(float)
    close = bars['close'].to_numpy(float)
    opn = bars['open'].to_numpy(float)
    prev_close = np.concatenate(([np.nan], close[:-1]))
    prev_R = np.concatenate(([np.nan], R[:-1]))
    rng = high - low
    with np.errstate(invalid='ignore', divide='ignore'):
        pos = np.where(rng > 0, (close - low) / rng, 0.5)   # 1 = closed at the high
        if op == 'bounce_up':
            from_above = (prev_close >= prev_R) & (opn >= R)  # was above AND the bar
            #      STARTED above — a bar that opened below support and closed above
            #      it CROSSED the level, it didn't bounce off it.
            touched = low <= R * (1 + tol)              # wick dipped to it
            held = close > R                            # closed back above
            turning = (close > prev_close) & (pos >= cpos)  # closed strong, near
            #      the top of its own range — touch-and-GO, not touch-and-hover
            out = from_above & touched & held & turning
        else:
            from_below = (prev_close <= prev_R) & (opn <= R)
            touched = high >= R * (1 - tol)             # wick poked up to it
            held = close < R                            # closed back below
            turning = (close < prev_close) & (pos <= 1.0 - cpos)
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


def _eval_rule(rule: dict, bars, ctx, trade: dict | None = None) -> np.ndarray:
    op = rule.get('op', 'gt')
    if op not in _OPS:
        raise ValueError(f'unknown operator {op!r}')
    p = rule.get('op_params') or {}
    L = _operand_array(rule.get('left'), bars, ctx, trade)
    R = None
    if op in _UNARY:
        out = _slope_flag(L, op, p)
    else:
        R = _operand_array(rule.get('right'), bars, ctx, trade)
        out = _bounce_flag(op, bars, R, p) if op in _BOUNCE else _apply_op(op, L, R, p)
    # sustained modifiers: held for the last N bars / true within the last N.
    fb = int(rule.get('for_bars', 0) or 0)
    wb = int(rule.get('within_bars', 0) or 0)
    if fb > 1:
        if op in ('cross_above', 'cross_below') and R is not None:
            # A cross is a ONE-bar event — "held for N" of the event itself can
            # never be true. What "cross + hold N" MEANS is: it crossed, and the
            # crossed STATE (above / below) then held on every bar since. Fires
            # once, N-1 bars after the cross, only if the state survived.
            state = _apply_op('gt' if op == 'cross_above' else 'lt', L, R)
            held = _rolling(state, fb, 'all')
            shifted = np.concatenate((np.zeros(fb - 1, dtype=bool), out[:-(fb - 1)])) \
                if fb - 1 < len(out) else np.zeros(len(out), dtype=bool)
            out = held & shifted
        else:
            out = _rolling(out, fb, 'all')
    elif wb > 1:
        out = _rolling(out, wb, 'any')
    # rule-level SIGNAL offset: "this condition was true N bars AGO" — shifts
    # the whole signal to the RIGHT on the chart. (Operand [n] shifts a VALUE;
    # this shifts the RESULT — the only way to displace e.g. a bounce, whose
    # operands are the price bar itself.) Left/future shift would be look-ahead
    # into bars that haven't happened — not expressible, by design.
    roff = int(rule.get('offset', 0) or 0)
    if roff > 0:
        n = len(out)
        out = (np.concatenate((np.zeros(roff, dtype=bool), out[:-roff]))
               if roff < n else np.zeros(n, dtype=bool))
    return out


def _eval_group(group: dict, bars, ctx, trade: dict | None = None) -> np.ndarray:
    n = len(bars)
    rules = (group or {}).get('rules') or []
    if not rules:
        return np.zeros(n, dtype=bool)
    logic = ((group or {}).get('logic') or 'AND').upper()
    parts = []
    for r in rules:
        if 'rules' in r or 'logic' in r:          # nested group
            parts.append(_eval_group(r, bars, ctx, trade))
        else:
            parts.append(_eval_rule(r, bars, ctx, trade))
    if logic == 'THEN':
        return _sequence(parts, int((group or {}).get('window', _SEQ_WINDOW)))
    stacked = np.vstack(parts)
    if logic == 'ATLEAST':                        # K-of-N scoring
        # clamp: k ≤ 0 would make the group TRUE ON EVERY BAR (sum ≥ 0)
        k = max(1, int((group or {}).get('k', 1) or 1))
        return stacked.sum(axis=0) >= k
    return stacked.any(axis=0) if logic == 'OR' else stacked.all(axis=0)


def _uses_trade(node) -> bool:
    """Does this rule/group tree reference the Trade operand anywhere? If so,
    the exit condition depends on the POSITION (entry price, bars held, P&L)
    and must be re-evaluated per trade instead of once globally."""
    if not isinstance(node, dict):
        return False
    if node.get('kind') == 'trade':
        return True
    if 'rules' in node or 'logic' in node:
        return any(_uses_trade(r) for r in node.get('rules') or [])
    return any(_uses_trade(node.get(k)) for k in ('left', 'right', 'a', 'b'))


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
    for spec in (strategy.get('risk') or {}).values():        # anchored SL/TP lines
        if isinstance(spec, dict):
            walk_operand(spec.get('anchor'))
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
    for spec in (strategy.get('risk') or {}).values():        # draw anchored SL/TP lines too
        if isinstance(spec, dict):
            add(spec.get('anchor'))
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


def _anchor_levels(spec: dict, side: str, bars, ctx) -> np.ndarray | None:
    """Per-bar level array for a primitive-ANCHORED stop/target:
    {type:'prim', anchor:<any operand>, value:<pct beyond>}. The level TRAILS
    the anchor line bar by bar (below the 9-EMA moves with the 9-EMA).
    `value` (%) shifts the level in the PROTECTIVE direction for the position:
    long → below the line (SL under support / TP short of resistance),
    short → above the line. NaN bars (warm-up) simply don't trigger."""
    if not spec or spec.get('type') != 'prim':
        return None
    try:
        arr = _operand_array(spec.get('anchor'), bars, ctx)
    except Exception:
        return None
    try:
        pct = float(spec.get('value') or 0.0)
    except (TypeError, ValueError):
        pct = 0.0
    shift = (1.0 - pct / 100.0) if side == 'long' else (1.0 + pct / 100.0)
    return np.asarray(arr, dtype=float) * shift


def _pair_trades(bars, ts, entry_mask, exit_mask, side, risk, ctx,
                 exit_group: dict | None = None):
    """Preview pairing with STOP-LOSS and TAKE-PROFIT. Conditions are STATUS
    checks, not one-shot signals: while FLAT, enter on any bar the entry
    condition IS true (so after a stop-out it can re-enter while the setup
    still holds); while IN a position, exit on any bar the exit condition IS
    true — even if it was already true before the entry (a flip-edge would
    miss that). PROTOCOL (fixed priority, so the three exit paths never
    conflict): 1) SL — protection is checked first, and wins if SL and TP fall
    in the same bar (conservative); 2) TP; 3) the exit-rule status (at that
    bar's close). SL/TP are either a fixed distance from entry (pct / ATR× /
    points) or ANCHORED to an indicator line (type 'prim') that trails bar by
    bar. Full day-by-day sim is Phase 4; this makes the preview honest."""
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
    sl_arr = _anchor_levels(risk.get('sl'), side, bars, ctx)   # trailing line, or None
    tp_arr = _anchor_levels(risk.get('tp'), side, bars, ctx)
    # Is a stop CONFIGURED? (fixed types need a finite value; 'prim' is
    # configured by its anchor alone — the % is optional). If yes, an entry
    # whose stop can't be PRICED on that bar (ATR warm-up NaN, anchored line
    # not formed yet) is SKIPPED — live you would never send an entry without
    # knowing the stop, so the preview must not simulate one.
    def _configured(spec):
        spec = spec or {}
        if spec.get('type') == 'prim':
            return True
        if not spec.get('type'):
            return False
        try:
            return float(spec.get('value')) == float(spec.get('value'))
        except (TypeError, ValueError):
            return False
    sl_required = _configured(risk.get('sl'))
    # the ARMED level on every in-position bar (NaN while flat) — returned so
    # the chart can DRAW the stop/target exactly as the simulation used them
    # (a fixed stop plots flat, an anchored one visibly trails its line).
    sl_view = np.full(n, np.nan)
    tp_view = np.full(n, np.nan)
    trades = []
    open_trade = None
    in_pos = False; ei = 0; sl = tp = None
    em = exit_mask                       # per-trade exit mask when trade-aware
    for j in range(n):
        if not in_pos:
            if entry_mask[j]:
                ep = close[j]
                # fixed-distance stops: long → SL BELOW entry / TP above;
                # short → SL ABOVE entry / TP below. (Anchored ones use the array.)
                sd = _risk_dist(risk.get('sl'), ep, atr[j])
                td = _risk_dist(risk.get('tp'), ep, atr[j])
                if side == 'long':
                    sl = ep - sd if sd else None; tp = ep + td if td else None
                else:
                    sl = ep + sd if sd else None; tp = ep - td if td else None
                e_sl = sl_arr[j] if sl_arr is not None else sl
                e_tp = tp_arr[j] if tp_arr is not None else tp
                if sl_required and (e_sl is None or e_sl != e_sl):
                    continue                       # stop unpriceable → no trade
                in_pos = True; ei = j
                if exit_group is not None:
                    # exit rules reference the Trade operand → evaluate the
                    # exit condition FOR THIS TRADE (its own entry price/bar)
                    em = _eval_group(exit_group, bars, ctx,
                                     trade={'entry': ep, 'ei': ei, 'side': side})
                if e_sl is not None and e_sl == e_sl:
                    sl_view[j] = e_sl
                if e_tp is not None and e_tp == e_tp:
                    tp_view[j] = e_tp
            continue
        # effective level this bar: anchored (trailing, may be NaN in warm-up)
        # beats the fixed scalar; NaN disables the check for that bar.
        slv = sl_arr[j] if sl_arr is not None else sl
        tpv = tp_arr[j] if tp_arr is not None else tp
        if slv is not None and slv != slv:
            slv = None
        if tpv is not None and tpv != tpv:
            tpv = None
        if slv is not None:
            sl_view[j] = slv
        if tpv is not None:
            tp_view[j] = tpv
        px = reason = None
        if slv is not None and ((side == 'long' and low[j] <= slv) or (side == 'short' and high[j] >= slv)):
            px, reason = slv, 'SL'
        elif tpv is not None and ((side == 'long' and high[j] >= tpv) or (side == 'short' and low[j] <= tpv)):
            px, reason = tpv, 'TP'
        elif em is not None and em[j]:
            px, reason = close[j], 'exit'
        if px is not None:
            r = (px - close[ei]) / close[ei]
            if side == 'short':
                r = -r
            trades.append({'ei': ei, 'xi': j, 'ret': float(r), 'reason': reason,
                           'entry': float(close[ei]), 'exit': float(px)})
            in_pos = False
    if in_pos:
        # still holding at the window's end — report it instead of hiding it
        r = (close[-1] - close[ei]) / close[ei]
        if side == 'short':
            r = -r
        open_trade = {'ei': ei, 'entry': float(close[ei]),
                      'last': float(close[-1]), 'ret': float(r)}
    return trades, sl_view, tp_view, open_trade


def _exit_now(exit_mask, trade_aware, exit_group, open_trade, side, bars, ctx) -> bool:
    """'Is the exit condition true right now?' — for a trade-aware exit that
    only means anything relative to the OPEN position, if there is one."""
    if not trade_aware:
        return bool(exit_mask[-1])
    if not open_trade:
        return False
    try:
        em = _eval_group(exit_group, bars, ctx,
                         trade={'entry': open_trade['entry'],
                                'ei': open_trade['ei'], 'side': side})
        return bool(em[-1])
    except Exception:
        return False


def test_condition(node: dict, symbol: str, tf: str, days: int,
                   feed: str = 'polygon', view: str = 'all',
                   asof: str | None = None) -> dict:
    """Evaluate a SINGLE rule (or group) and mark EVERY bar where it holds —
    for validating a condition ('slope of 13-MA', 'bounce off 5-DMA', 'break of
    resistance') before wiring it into a strategy. Returns a dot marker on each
    true bar, the count, the % of bars true, and whether it's true right now."""
    from chart import data_manager as dm
    if _uses_trade(node):
        return {'ok': False,
                'error': 'Trade fields (entry price / bars in trade / P&L%) '
                         'need a live position — put this rule in EXIT and '
                         'use Evaluate to see it per trade'}
    strat_like = {'entry': node if ('rules' in node or 'logic' in node)
                  else {'logic': 'AND', 'rules': [node]}}
    days = dm.required_days(referenced_overlays(strat_like), tf, days)
    bars, ts, ctx = cs.prepare_bars(symbol, tf, days, feed, view, asof)
    n = len(bars)
    if n == 0:
        return {'ok': True, 'bars': 0, 'true': 0, 'pct': 0.0, 'markers': [],
                'series': [], 'now': False, 'left_now': None, 'right_now': None}
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
        return {'ok': True, 'bars': 0, 'entries': [], 'exits': [], 'series': [],
                'markers': [], 'stats': None, 'open_trade': None,
                'entry_now': False, 'exit_now': False,
                'first': None, 'last': None}

    side = strategy.get('side', 'long')
    exit_group = strategy.get('exit')
    # Trade-operand exits (P&L %, bars held, entry price) depend on WHICH
    # position is open, so no single global exit mask exists — the pairing
    # loop evaluates the exit group per trade instead.
    trade_aware = _uses_trade(exit_group or {})
    entry_mask = _eval_group(strategy.get('entry'), bars, ctx)
    exit_mask = (np.zeros(n, dtype=bool) if trade_aware
                 else _eval_group(exit_group, bars, ctx))
    entry_ev = _edges(entry_mask)
    exit_ev = _edges(exit_mask)

    # STATUS pairing: enter while flat on any true entry bar; exit on any true
    # exit bar (or SL/TP) — see _pair_trades for the priority protocol.
    trades, sl_view, tp_view, open_trade = _pair_trades(
        bars, ts, entry_mask, exit_mask, side, strategy.get('risk'), ctx,
        exit_group=exit_group if trade_aware else None)

    up_shape = 'arrowUp' if side == 'long' else 'arrowDown'
    up_pos = 'belowBar' if side == 'long' else 'aboveBar'
    markers = []
    # Every bar the ENTRY condition first fires (clean arrow, no repeated text —
    # keeps a dense chart readable). Shown even if nothing "closes".
    edge_times = set()
    for i in np.nonzero(entry_ev)[0]:
        edge_times.add(int(ts[i]))
        markers.append({'time': int(ts[i]), 'position': up_pos,
                        'shape': up_shape, 'color': '#22c55e', 'text': ''})
    # ...plus RE-entries: a trade taken while the signal was still on (e.g.
    # right after a stop-out) isn't a fresh edge, but it IS an entry.
    for t in trades:
        if int(ts[t['ei']]) not in edge_times:
            markers.append({'time': int(ts[t['ei']]), 'position': up_pos,
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

    # the ARMED stop/target levels, drawn exactly as the simulation used them:
    # dashed red SL / dashed green TP segments spanning each trade's life —
    # fixed levels plot flat from the entry, anchored ones visibly trail.
    series = _indicator_series(strategy, bars, ts, ctx)
    for nm, arr, col in (('SL level', sl_view, '#ef5350'),
                         ('TP level', tp_view, '#22c55e')):
        vals = [{'time': int(t), 'value': float(v)}
                for t, v in zip(ts, arr) if v == v]
        if vals:
            series = list(series) + [{'name': nm, 'color': col, 'style': 2,
                                      'step': True, 'values': vals}]

    et = bars.index.tz_convert(cs._ET)
    return {
        'ok': True, 'bars': n, 'side': side,
        'entries': [{'time': int(ts[i])} for i in np.nonzero(entry_ev)[0]],
        'exits':   [{'time': int(ts[i])} for i in np.nonzero(exit_ev)[0]],
        'markers': markers,
        'series':  series,
        'entry_now': bool(entry_mask[-1]),
        'exit_now':  _exit_now(exit_mask, trade_aware, exit_group, open_trade,
                               side, bars, ctx),
        'stats': stats,
        'open_trade': ({'time': int(ts[open_trade['ei']]),
                        'entry': open_trade['entry'],
                        'ret_pct': round(100.0 * open_trade['ret'], 3)}
                       if open_trade else None),
        'first': et[0].strftime('%Y-%m-%d %H:%M ET'),
        'last':  et[-1].strftime('%Y-%m-%d %H:%M ET'),
    }
