"""
Extract chart-indicator specs from a trade-desk `check_library` condition
JSON tree.

Given a check's condition (matching the grammar in `src/trading/checks.js`),
walk the tree and return the qp-compare-tool indicator specs needed to
render every referenced series on a chart.

Example:
    { "op": "gt",
      "left":  { "field": "close" },
      "right": { "field": "ema9"  } }
    → yields [{"ind":"ema","length":9}]   ('close' is already on the chart)

Field-name mapping (matches JS `fieldValue` in checks.js):
    close, open, high, low, volume  → intrinsic (skipped, chart already shows)
    vwap                            → Daily VWAP (session_vwap)
    ema9 / ema13 / ema20 / ema50    → EMA with matching length
    sma5 / sma20                    → SMA with matching length
    pmHigh / pmLow                  → premarket_high / premarket_low
    dayHigh / dayLow                → today_high / today_low
    prevClose                       → literal from prev-day close (skipped
                                      unless we add a "prev_day_close" line)
    rvol                            → not renderable as a price overlay
    atr                             → ATR in sub-pane
"""

from __future__ import annotations

from typing import Any, Iterable


# field name → indicator spec (matches the compare tool's `ind` values)
_FIELD_TO_SPEC = {
    'vwap':      {'ind': 'vwap',       'length': 0,  'label': 'Daily VWAP'},
    'ema9':      {'ind': 'ema',        'length': 9,  'label': 'EMA(9)'},
    'ema13':     {'ind': 'ema',        'length': 13, 'label': 'EMA(13)'},
    'ema20':     {'ind': 'ema',        'length': 20, 'label': 'EMA(20)'},
    'ema50':     {'ind': 'ema',        'length': 50, 'label': 'EMA(50)'},
    'sma5':      {'ind': 'sma',        'length': 5,  'label': 'SMA(5)'},
    'sma20':     {'ind': 'sma',        'length': 20, 'label': 'SMA(20)'},
    'pmHigh':    {'ind': 'pm_high',    'length': 0,  'label': 'Premarket High'},
    'pmLow':     {'ind': 'pm_low',     'length': 0,  'label': 'Premarket Low'},
    'dayHigh':   {'ind': 'day_high',   'length': 0,  'label': 'Today HH'},
    'dayLow':    {'ind': 'day_low',    'length': 0,  'label': 'Today LL'},
    'atr':       {'ind': 'atr',        'length': 14, 'label': 'ATR(14)'},
    'prevClose': {'ind': 'prev_close', 'length': 0,  'label': 'Prev Day Close'},
    'rvol':      {'ind': 'rvol',       'length': 10, 'label': 'rvol'},
}
# Fields that are already on the chart (OHLCV).
_SKIP_FIELDS = {'close', 'open', 'high', 'low', 'volume'}


def _walk(node: Any, out: set[str]) -> None:
    """Recurse and collect every 'field', 'history', 'slope' name in the tree."""
    if not isinstance(node, dict):
        if isinstance(node, list):
            for x in node:
                _walk(x, out)
        return
    for key in ('field', 'history', 'slope'):
        if key in node and isinstance(node[key], str):
            out.add(node[key])
    if 'series' in node and isinstance(node['series'], str):
        out.add(node['series'])
    # Recurse into every value in this dict.
    for v in node.values():
        if isinstance(v, (dict, list)):
            _walk(v, out)


def extract_field_names(condition: Any) -> set[str]:
    """Return every indicator/field name referenced anywhere in the tree."""
    out: set[str] = set()
    _walk(condition, out)
    return out


def specs_for_condition(condition: Any) -> list[dict]:
    """Return chart-indicator specs (deduplicated) for a condition tree."""
    fields = extract_field_names(condition)
    return specs_for_fields(fields)


def specs_for_fields(fields: Iterable[str]) -> list[dict]:
    """Turn a set of field names into indicator specs the compare-tool
    understands. Unknown/skipped fields are dropped silently."""
    seen: set[tuple] = set()
    specs = []
    for f in fields:
        if f in _SKIP_FIELDS:
            continue
        spec = _FIELD_TO_SPEC.get(f)
        if spec is None:
            continue
        key = (spec['ind'], spec['length'])
        if key in seen:
            continue
        seen.add(key)
        specs.append(dict(spec))
    return specs


def specs_for_checks(checks: Iterable[dict]) -> list[dict]:
    """Aggregate specs across many checks, deduplicated."""
    fields: set[str] = set()
    for check in checks:
        cond = check.get('condition') if isinstance(check, dict) else None
        if cond is None:
            continue
        # `condition` may be a JSON string or a parsed dict
        if isinstance(cond, str):
            import json as _json
            try:
                cond = _json.loads(cond)
            except Exception:
                continue
        fields.update(extract_field_names(cond))
    return specs_for_fields(fields)
