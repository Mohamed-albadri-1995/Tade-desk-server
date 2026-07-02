"""
STAGE 17 — Live Engine.

Streaming counterpart to Stage 16's backtest. Consumes closed bars,
maintains per-(symbol, setup) position state, and emits OpenEvent /
CloseEvent through a callback whenever positions change.

Position sizing lives here (Stage 16 measures in R multiples; here we
map R to whole shares via fixed-risk sizing).

    engine = LiveEngine(setups=[my_setup], on_event=handle,
                        risk_per_trade=100.0, lot_size=1)
    engine.on_new_bar(symbol='SPY', bar=<pd.Series>)
    engine.close_all(reason='eod')

Emits:
    OpenEvent (setup, symbol, side, bar_index, timestamp, entry_px,
              stop_px, target_px, qty)
    CloseEvent (setup, symbol, side, entry_bar, exit_bar, timestamp,
                entry_px, exit_px, stop_px, target_px, qty, reason,
                r_multiple)

The engine does NOT know about brokers. It emits events. Callers
subscribe callbacks and route them to Alpaca / paper / journal / UI.
"""

from qp.live.engine import LiveEngine
from qp.live.events import OpenEvent, CloseEvent
from qp.live.sizer import fixed_risk_qty

__all__ = ['LiveEngine', 'OpenEvent', 'CloseEvent', 'fixed_risk_qty']
