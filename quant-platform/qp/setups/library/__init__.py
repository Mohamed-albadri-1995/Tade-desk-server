"""
Setup library — Pine-parity setups importable by the compare tool.

Each setup module exposes:
    NAME         : str          — human-readable name
    DESCRIPTION  : str          — short description
    SIDE         : str          — 'long', 'short', or 'both'
    CHART_SPECS  : list[dict]   — indicator specs the compare tool overlays
    evaluate(df) : np.ndarray   — bool array, True where the setup fires

REGISTRY maps a stable id → module. The compare tool's /qp-setups
endpoint iterates this to expose the setups in its dropdown.
"""

from __future__ import annotations

from qp.setups.library import (
    vwap_cluster_bounce,
    healthy_pullback_l3,
    bb_zone_ma_touch,
)


REGISTRY = {
    'vwap_cluster_bounce': vwap_cluster_bounce,
    'healthy_pullback_l3': healthy_pullback_l3,
    'bb_zone_ma_touch':    bb_zone_ma_touch,
}


def list_setups() -> list[dict]:
    """Return [{id, name, description, side, chart_specs}] for every
    registered setup — the payload the compare tool renders."""
    out = []
    for sid, mod in REGISTRY.items():
        out.append({
            'id':          sid,
            'name':        mod.NAME,
            'description': getattr(mod, 'DESCRIPTION', ''),
            'side':        mod.SIDE,
            'chart_specs': mod.CHART_SPECS,
        })
    return out


def get_setup(setup_id: str):
    return REGISTRY[setup_id]
