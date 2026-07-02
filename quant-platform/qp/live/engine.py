"""
Live engine — streaming counterpart to Stage 16's backtest.

Streams bars into a rolling buffer, re-evaluates its Setups, and emits
OpenEvent / CloseEvent through a callback whenever positions change.

Model:
    - one position per (symbol, setup) at a time.
    - trigger evaluation happens on bar close. A newly-closed bar is
      appended to the buffer, then triggers run against the full
      buffer. If the last bar fires and there's no open position,
      an OpenEvent fires.
    - stop / target checks run on every new bar (intra-bar highs/lows).
    - exit rule matches backtest: simultaneous stop+target on the same
      bar → stop first.

The engine does NOT know about brokers. It emits events. Callers
subscribe callbacks and route them to Alpaca / paper / journal / UI.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from qp.setups import Setup, evaluate
from qp.live.events import OpenEvent, CloseEvent
from qp.live.sizer import fixed_risk_qty


EventHandler = Callable[[object], None]  # receives OpenEvent or CloseEvent


@dataclass
class _Position:
    setup:     str
    symbol:    str
    side:      str
    entry_bar: int
    entry_px:  float
    stop_px:   float
    target_px: float
    qty:       float


@dataclass
class LiveEngine:
    setups: List[Setup]
    on_event: EventHandler
    risk_per_trade: float = 100.0    # dollars
    lot_size: float = 1.0
    context_provider: Optional[Callable[[str, pd.DataFrame], Dict[str, np.ndarray]]] = None

    _bars_by_symbol: Dict[str, pd.DataFrame] = field(default_factory=dict)
    _positions:      Dict[Tuple[str, str], _Position] = field(default_factory=dict)

    def on_new_bar(self, symbol: str, bar: pd.Series) -> None:
        """Called by the caller once per closed bar.

        `bar` is a Series with an index that includes the timestamp
        (a bar's timestamp is its close time) and columns
        [open, high, low, close, volume].
        """
        df = self._bars_by_symbol.get(symbol)
        row = pd.DataFrame([bar.drop(labels=['timestamp'], errors='ignore')],
                           index=[bar.name])
        row.columns = row.columns.astype(str)
        if df is None:
            self._bars_by_symbol[symbol] = row
        else:
            self._bars_by_symbol[symbol] = pd.concat([df, row])

        bars = self._bars_by_symbol[symbol]
        i = len(bars) - 1
        high  = float(bars['high'].iloc[i])
        low   = float(bars['low'].iloc[i])
        close = float(bars['close'].iloc[i])
        ts    = bars.index[i]

        # First: check existing positions for exits on THIS bar.
        for setup in self.setups:
            key = (symbol, setup.name)
            pos = self._positions.get(key)
            if pos is None:
                continue
            reason = self._check_exit(pos, high, low)
            if reason is None:
                continue
            exit_px = pos.stop_px if reason == 'stop' else pos.target_px
            self._emit_close(pos, exit_bar=i, exit_ts=ts, exit_px=exit_px,
                              reason=reason)
            del self._positions[key]

        # Then: check for new entries.
        ctx = (self.context_provider(symbol, bars)
               if self.context_provider else None)
        for setup in self.setups:
            key = (symbol, setup.name)
            if key in self._positions:
                continue
            r = evaluate(setup, bars, context=ctx)
            if not bool(r.entries[i]):
                continue
            qty = fixed_risk_qty(self.risk_per_trade,
                                 close, float(r.stop_px[i]),
                                 lot_size=self.lot_size)
            if qty == 0:
                continue
            pos = _Position(setup=setup.name, symbol=symbol, side=setup.side,
                            entry_bar=i, entry_px=close,
                            stop_px=float(r.stop_px[i]),
                            target_px=float(r.target_px[i]),
                            qty=qty)
            self._positions[key] = pos
            self.on_event(OpenEvent(
                setup=pos.setup, symbol=pos.symbol, side=pos.side,
                bar_index=i, timestamp=self._iso(ts),
                entry_px=pos.entry_px, stop_px=pos.stop_px,
                target_px=pos.target_px, qty=pos.qty,
            ))

    def close_all(self, reason: str = 'manual') -> None:
        """Close every open position at last known close (e.g. EOD hook)."""
        for key, pos in list(self._positions.items()):
            bars = self._bars_by_symbol.get(pos.symbol)
            if bars is None or bars.empty:
                continue
            i = len(bars) - 1
            close = float(bars['close'].iloc[i])
            self._emit_close(pos, exit_bar=i, exit_ts=bars.index[i],
                             exit_px=close, reason=reason)
            del self._positions[key]

    def _check_exit(self, pos: _Position, high: float, low: float) -> Optional[str]:
        if pos.side == 'long':
            hit_stop   = low  <= pos.stop_px
            hit_target = high >= pos.target_px
        else:
            hit_stop   = high >= pos.stop_px
            hit_target = low  <= pos.target_px
        if hit_stop and hit_target:
            return 'stop'         # conservative
        if hit_stop:
            return 'stop'
        if hit_target:
            return 'target'
        return None

    def _emit_close(self, pos: _Position, exit_bar: int, exit_ts,
                    exit_px: float, reason: str) -> None:
        risk = abs(pos.entry_px - pos.stop_px)
        direction = 1.0 if pos.side == 'long' else -1.0
        r_mult = 0.0 if risk == 0 else direction * (exit_px - pos.entry_px) / risk
        self.on_event(CloseEvent(
            setup=pos.setup, symbol=pos.symbol, side=pos.side,
            entry_bar=pos.entry_bar, exit_bar=exit_bar,
            timestamp=self._iso(exit_ts),
            entry_px=pos.entry_px, exit_px=exit_px,
            stop_px=pos.stop_px, target_px=pos.target_px,
            qty=pos.qty, reason=reason,
            r_multiple=float(r_mult),
        ))

    @staticmethod
    def _iso(ts) -> str:
        if hasattr(ts, 'isoformat'):
            return ts.isoformat()
        return str(ts)
