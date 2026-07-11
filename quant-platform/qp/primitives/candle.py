"""
Candle-anatomy primitives — the bar-geometry building blocks every one of
the source Pine scripts uses for its quality checks:

  Cluster script:  body %, upper/lower wick % of range
  L3 script:       c1_lower_wick / c1_range, rejection candles
  BBZ script:      bar_body vs ATR, wick/body ratios

All exact Pine equivalents:
  body        = |close - open|            (bz_bar_body)
  upper_wick  = high - max(close, open)   (bz_upper_wick)
  lower_wick  = min(close, open) - low    (bz_lower_wick)
  bar_range   = high - low                (c1_range)

Ratios (body %, wick %, wick/body) are one division away and stay in the
setup/condition scripts — they're parameters of a setup, not math.
"""

from __future__ import annotations

import numpy as np

from qp.registry import primitive
from qp.primitives.bars import Bars


def _range(df):
    return df['high'].to_numpy(dtype=float) - df['low'].to_numpy(dtype=float)


@primitive(name='body', group='candle',
           description='Absolute candle body, |close - open|.',
           params=(), inputs=('bars',))
def body(bars: Bars):
    df = bars.df
    return np.abs(df['close'].to_numpy(dtype=float) -
                  df['open'].to_numpy(dtype=float))


@primitive(name='upper_wick', group='candle',
           description='Upper wick, high - max(close, open).',
           params=(), inputs=('bars',))
def upper_wick(bars: Bars):
    df = bars.df
    o = df['open'].to_numpy(dtype=float)
    c = df['close'].to_numpy(dtype=float)
    return df['high'].to_numpy(dtype=float) - np.maximum(o, c)


@primitive(name='lower_wick', group='candle',
           description='Lower wick, min(close, open) - low.',
           params=(), inputs=('bars',))
def lower_wick(bars: Bars):
    df = bars.df
    o = df['open'].to_numpy(dtype=float)
    c = df['close'].to_numpy(dtype=float)
    return np.minimum(o, c) - df['low'].to_numpy(dtype=float)


@primitive(name='bar_range', group='candle',
           description='Full bar range, high - low.',
           params=(), inputs=('bars',))
def bar_range(bars: Bars):
    df = bars.df
    return (df['high'].to_numpy(dtype=float) -
            df['low'].to_numpy(dtype=float))


# ── ratios: plottable "candle quality" numbers (judge them on their own) ────
@primitive(name='body_pct', group='candle',
           description='Body as % of range: |close-open| / (high-low) × 100. '
                       'NaN on zero-range bars. "Candle Quality → Min Body %".',
           params=(), inputs=('bars',))
def body_pct(bars: Bars):
    df = bars.df
    o = df['open'].to_numpy(dtype=float); c = df['close'].to_numpy(dtype=float)
    rng = _range(df)
    with np.errstate(invalid='ignore', divide='ignore'):
        out = np.abs(c - o) / rng * 100.0
    out[rng <= 0] = np.nan
    return out


@primitive(name='upper_wick_pct', group='candle',
           description='Upper wick as % of range: (high-max(o,c)) / (high-low) '
                       '× 100. NaN on zero-range bars. "Max Upper Wick %".',
           params=(), inputs=('bars',))
def upper_wick_pct(bars: Bars):
    df = bars.df
    o = df['open'].to_numpy(dtype=float); c = df['close'].to_numpy(dtype=float)
    rng = _range(df)
    with np.errstate(invalid='ignore', divide='ignore'):
        out = (df['high'].to_numpy(dtype=float) - np.maximum(o, c)) / rng * 100.0
    out[rng <= 0] = np.nan
    return out


@primitive(name='lower_wick_pct', group='candle',
           description='Lower wick as % of range: (min(o,c)-low) / (high-low) '
                       '× 100. NaN on zero-range bars. "c1_lwick_pct" in L3.',
           params=(), inputs=('bars',))
def lower_wick_pct(bars: Bars):
    df = bars.df
    o = df['open'].to_numpy(dtype=float); c = df['close'].to_numpy(dtype=float)
    rng = _range(df)
    with np.errstate(invalid='ignore', divide='ignore'):
        out = (np.minimum(o, c) - df['low'].to_numpy(dtype=float)) / rng * 100.0
    out[rng <= 0] = np.nan
    return out
