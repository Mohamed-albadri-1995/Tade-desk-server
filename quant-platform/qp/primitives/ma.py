"""
Moving-average primitives — all Pine `ta.<name>` bar-for-bar parity.

- sma:  simple mean of trailing `length` bars.
- ema:  Wilder-style seeded EMA (α=2/(len+1), first value = SMA(len)).
- wma:  linear weights 1..len.
- rma:  Wilder's smoothed (α=1/len, first value = SMA(len)). Used by
        RSI / ATR internally.
- vwma: volume-weighted mean, `sum(src*vol) / sum(vol)` over `length`.
- hma:  Hull MA — WMA composition, matches `ta.hma`.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from qp.registry import primitive, Param
from qp.primitives.bars import Bars


@primitive(
    name='sma',
    group='ma',
    description=('Simple moving average of `source` over `length` bars. '
                 'Matches TradingView `ta.sma(source, length)` — NaN for '
                 'the first (length-1) bars, mean of the trailing window '
                 'afterwards.'),
    params=(Param('length', 'int', default=9, min=1,
                  description='Number of bars in the average.'),),
    inputs=('source',),
)
def sma(source, length: int):
    s = pd.Series(np.asarray(source, dtype=float))
    return s.rolling(int(length), min_periods=int(length)).mean().to_numpy()


@primitive(
    name='ema',
    group='ma',
    description=('Exponential MA. Matches TradingView `ta.ema(source, '
                 'length)` — SMA-seeded, α=2/(length+1). NaN for first '
                 '(length-1) bars, seed = SMA(length) at bar (length-1), '
                 'then α-recurrence forward.'),
    params=(Param('length', 'int', default=9, min=1),),
    inputs=('source',),
)
def ema(source, length: int):
    src = np.asarray(source, dtype=float)
    length = int(length)
    n = len(src)
    out = np.full(n, np.nan)
    if n < length:
        return out
    out[length - 1] = src[:length].mean()
    alpha = 2.0 / (length + 1.0)
    for i in range(length, n):
        out[i] = alpha * src[i] + (1.0 - alpha) * out[i - 1]
    return out


@primitive(
    name='wma',
    group='ma',
    description=('Weighted MA — linear weights 1..length. Matches '
                 'TradingView `ta.wma(source, length)`.'),
    params=(Param('length', 'int', default=9, min=1),),
    inputs=('source',),
)
def wma(source, length: int):
    src = np.asarray(source, dtype=float)
    length = int(length)
    n = len(src)
    out = np.full(n, np.nan)
    if n < length:
        return out
    weights = np.arange(1, length + 1, dtype=float)
    denom = weights.sum()
    for i in range(length - 1, n):
        out[i] = float((src[i - length + 1: i + 1] * weights).sum() / denom)
    return out


@primitive(
    name='rma',
    group='ma',
    description=('Wilder\'s smoothed MA. Matches TradingView `ta.rma('
                 'source, length)` — α=1/length, seeded with SMA(length). '
                 'Basis for `ta.rsi` and `ta.atr`.'),
    params=(Param('length', 'int', default=14, min=1),),
    inputs=('source',),
)
def rma(source, length: int):
    src = np.asarray(source, dtype=float)
    length = int(length)
    n = len(src)
    out = np.full(n, np.nan)
    if n < length:
        return out
    # Seed with mean of the first `length` values, ignoring leading NaNs
    # so callers can prepend a NaN (like `rsi` does for the diff step).
    first_valid = 0
    while first_valid < n and np.isnan(src[first_valid]):
        first_valid += 1
    if n - first_valid < length:
        return out
    seed_end = first_valid + length
    out[seed_end - 1] = src[first_valid:seed_end].mean()
    alpha = 1.0 / length
    for i in range(seed_end, n):
        prev = out[i - 1]
        cur  = src[i]
        if np.isnan(cur):
            out[i] = prev
        else:
            out[i] = alpha * cur + (1.0 - alpha) * prev
    return out


@primitive(
    name='vwma',
    group='ma',
    description=('Volume-weighted MA, `sum(source*volume)/sum(volume)` over '
                 '`length` bars. Matches TradingView `ta.vwma(source, '
                 'length)`. Source picked via `source` param (default close).'),
    params=(
        Param('length', 'int', default=20, min=1),
        Param('source', 'str', default='close',
              description='close | open | high | low | hl2 | hlc3 | ohlc4'),
    ),
    inputs=('bars',),
)
def vwma(bars: Bars, length: int, source: str = 'close'):
    df = bars.df
    length = int(length)
    if   source == 'close': src = df['close'].to_numpy(dtype=float)
    elif source == 'open':  src = df['open'].to_numpy(dtype=float)
    elif source == 'high':  src = df['high'].to_numpy(dtype=float)
    elif source == 'low':   src = df['low'].to_numpy(dtype=float)
    elif source == 'hl2':   src = ((df['high'] + df['low']) / 2.0).to_numpy(dtype=float)
    elif source == 'hlc3':  src = ((df['high'] + df['low'] + df['close']) / 3.0).to_numpy(dtype=float)
    elif source == 'ohlc4': src = ((df['open'] + df['high'] + df['low'] + df['close']) / 4.0).to_numpy(dtype=float)
    else: raise ValueError(f'unknown source {source!r}')
    vol = df['volume'].to_numpy(dtype=float)
    pv  = src * vol
    s_pv  = pd.Series(pv).rolling(length, min_periods=length).sum().to_numpy()
    s_vol = pd.Series(vol).rolling(length, min_periods=length).sum().to_numpy()
    out = np.divide(s_pv, s_vol, out=np.full_like(s_pv, np.nan), where=(s_vol != 0))
    return out


@primitive(
    name='hma',
    group='ma',
    description=('Hull MA. Matches TradingView `ta.hma(source, length)` — '
                 'wma(2*wma(src, len/2) - wma(src, len), sqrt(len)).'),
    params=(Param('length', 'int', default=20, min=2),),
    inputs=('source',),
)
def hma(source, length: int):
    length = int(length)
    half = max(1, length // 2)
    sq   = max(1, int(math.floor(math.sqrt(length))))
    a = wma(source, half)
    b = wma(source, length)
    diff = 2.0 * a - b
    return wma(diff, sq)
