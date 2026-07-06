"""
Volatility primitives — all Pine `ta.<name>` bar-for-bar parity.

- true_range: max(high-low, |high-prev_close|, |low-prev_close|).
              Matches `ta.tr(handle_na=true)` — first bar = high-low.
- atr:        Wilder ATR = rma(true_range, length). `ta.atr(length)`.
              First value at bar (length-1), same as Pine.
- stdev:      population std (ddof=0) of `source` over `length` bars.
              Matches `ta.stdev(source, length)`.
- bb:         Bollinger Bands. Returns a dict {middle, upper, lower} so
              the compare tool can plot all three lines. mult=2 by
              default. Matches `ta.bb(source, length, mult)`.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from qp.registry import primitive, Param
from qp.primitives.bars import Bars
from qp.primitives.ma import rma as _rma


@primitive(
    name='true_range',
    group='volatility',
    description=('True range, `max(H-L, |H-prev_close|, |L-prev_close|)`. '
                 'Matches TradingView `ta.tr(handle_na=true)`: the first '
                 'bar (no prior close) falls back to high-low. This is '
                 'the variant `ta.atr` builds on.'),
    params=(),
    inputs=('bars',),
)
def true_range(bars: Bars):
    df = bars.df
    high = df['high'].to_numpy(dtype=float)
    low  = df['low'].to_numpy(dtype=float)
    close = df['close'].to_numpy(dtype=float)
    prev_close = np.concatenate(([np.nan], close[:-1]))
    tr = np.maximum.reduce([
        high - low,
        np.abs(high - prev_close),
        np.abs(low - prev_close),
    ])
    # handle_na=true: no prev close on bar 0 → the bar's own range.
    if len(tr):
        tr[0] = high[0] - low[0]
    return tr


@primitive(
    name='atr',
    group='volatility',
    description=('Average True Range (Wilder). Matches TradingView '
                 '`ta.atr(length)` — rma(true_range, length).'),
    params=(Param('length', 'int', default=14, min=1),),
    inputs=('bars',),
)
def atr(bars: Bars, length: int):
    # ta.atr(len) is literally rma(tr(handle_na=true), len). TR is valid
    # from bar 0 (H-L fallback), so rma seeds at bar (length-1) — Pine's
    # exact warmup.
    return _rma(true_range(bars), int(length))


@primitive(
    name='stdev',
    group='volatility',
    description=('Population standard deviation (ddof=0) of `source` over '
                 '`length` bars. Matches TradingView `ta.stdev(source, '
                 'length)`.'),
    params=(Param('length', 'int', default=20, min=2),),
    inputs=('source',),
)
def stdev(source, length: int):
    s = pd.Series(np.asarray(source, dtype=float))
    return s.rolling(int(length), min_periods=int(length)).std(ddof=0).to_numpy()


@primitive(
    name='bb',
    group='volatility',
    description=('Bollinger Bands. Returns {middle, upper, lower} — middle '
                 '= sma(source, length), upper/lower = middle ± mult * '
                 'stdev(source, length). Matches TradingView `ta.bb(source, '
                 'length, mult)`.'),
    params=(
        Param('length', 'int',   default=20, min=2),
        Param('mult',   'float', default=2.0, min=0.0),
    ),
    inputs=('source',),
)
def bb(source, length: int, mult: float):
    src = np.asarray(source, dtype=float)
    length = int(length)
    mult = float(mult)
    s = pd.Series(src)
    middle = s.rolling(length, min_periods=length).mean().to_numpy()
    dev    = s.rolling(length, min_periods=length).std(ddof=0).to_numpy()
    return {
        'middle': middle,
        'upper':  middle + mult * dev,
        'lower':  middle - mult * dev,
    }


@primitive(
    name='bb_ema',
    group='volatility',
    description=('Bollinger Bands with an EMA middle line — matches the L3 '
                 'script\'s `l3_bb_ema = ta.ema(close, length)` + '
                 '`ta.stdev(close, length)` bands. Returns {middle, upper, '
                 'lower}.'),
    params=(
        Param('length', 'int',   default=21, min=2),
        Param('mult',   'float', default=2.0, min=0.0),
    ),
    inputs=('source',),
)
def bb_ema(source, length: int, mult: float):
    from qp.primitives.ma import ema as _ema
    src = np.asarray(source, dtype=float)
    length = int(length)
    mult = float(mult)
    middle = _ema(src, length)
    dev    = pd.Series(src).rolling(length, min_periods=length).std(ddof=0).to_numpy()
    return {
        'middle': middle,
        'upper':  middle + mult * dev,
        'lower':  middle - mult * dev,
    }
