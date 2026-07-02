"""
STAGE 9 — Market Structure Library.

Turns raw OHLC into the language of price action:

    - Pivots (`pivot_highs`, `pivot_lows`) — bar-aligned pivot arrays,
      TradingView `ta.pivothigh` / `ta.pivotlow` parity.
    - Sequence classifier (`label_pivots`) — walks the pivot chain and
      labels each as HH / HL / LH / LL.
    - Trend state (`trend_state`) — per-bar 'up' / 'down' / 'range'
      classifier from the labelled sequence.

Every function is deterministic and forward-lookahead-safe: a bar is
labelled as a pivot only after `right` future bars have confirmed it.
The trend classifier respects that latency — bars between pivots keep
the state of the most recently CONFIRMED pivot chain.
"""

from qp.structure.pivots import pivot_highs, pivot_lows
from qp.structure.sequence import label_pivots
from qp.structure.trend import trend_state

__all__ = [
    'pivot_highs', 'pivot_lows',
    'label_pivots',
    'trend_state',
]
