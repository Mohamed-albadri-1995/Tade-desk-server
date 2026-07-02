"""
STAGE 14 — Chart Engine.

Pure data model — a `ChartFrame` describes what to draw. Nothing here
depends on a plotting library. Front-ends (React chart lib, matplotlib
notebook, TradingView export) all consume the same object.

Model:
    - ChartFrame(bars, series, markers, title)
    - Series(name, values, pane, color, style)
    - Marker(label, bar_index, price, kind, color)

Construction: `ChartBuilder(bars, title).add_series(...).add_marker(...).build()`
Serialisation: `chart.to_dict(frame)` → JSON-safe dict (NaN → None,
timestamps → ISO-8601).
"""

from qp.chart.spec import ChartFrame, Series, Marker, PaneRole
from qp.chart.builder import ChartBuilder
from qp.chart.serialise import to_dict

__all__ = [
    'ChartFrame', 'Series', 'Marker', 'PaneRole',
    'ChartBuilder',
    'to_dict',
]
