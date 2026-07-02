"""
Export bridges — write validated platform output into a shape the
downstream Trade Desk (or any other consumer) can pick up.

Batch export first: per-symbol, per-day JSON. Live subscription API to
come later.
"""

from qp.export.to_trade_desk import export_daily_levels

__all__ = ['export_daily_levels']
