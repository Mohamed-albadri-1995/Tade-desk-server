"""
Batch export bridge to the Trade Desk (Node) tool.

Writes per-symbol, per-day JSON files whose keys line up with the
`indicatorExtras` fields the Trade Desk's check evaluator already
consumes (`ma5day`, `vwap_2day`, `week_high`, `premarket_high`, …).
When the Trade Desk's session starts it reads these files and merges
them into every fire's context — the check library needs zero changes.

Right now this file just defines the JSON schema and a stub. Filling
each field in comes as later stages (VWAP library, level library, …)
land. For each field we mark:
    - src : stage that computes it (populated stages only)
    - key : same name the Trade Desk's `dailyLevels.computeLevels`
            publishes today, so drop-in replacement works
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional

import pandas as pd


# Schema — every key the Trade Desk expects. `None` values are omitted
# from the JSON so consumers know which levels haven't been produced yet.
DAILY_LEVELS_SCHEMA = {
    'ma5day':         None,   # STAGE 5 (SMA over 1950 1-min closes)
    'ma5day_slope':   None,   # STAGE 3 slope + STAGE 5 ma5day
    'vwap_2day':      None,   # STAGE 6
    'vwap_week':      None,   # STAGE 6
    'vwap_month':     None,   # STAGE 6
    'week_high':      None,   # STAGE 8
    'week_low':       None,
    'month_high':     None,
    'month_low':      None,
    'prev_day_high':  None,   # STAGE 8
    'prev_day_low':   None,
    'premarket_high': None,   # STAGE 8 + STAGE 2 session filter
    'premarket_low':  None,
}


def export_daily_levels(
    symbol: str,
    date: str,
    levels: Dict[str, Optional[float]],
    output_dir: Path,
) -> Path:
    """Write one JSON file for a symbol / date.

    Filename pattern: `{output_dir}/{date}/{symbol}.json`. Trade Desk
    reads all files in `{output_dir}/{today}/` on session start.
    """
    payload = {k: v for k, v in levels.items() if v is not None}
    day_dir = output_dir / date
    day_dir.mkdir(parents=True, exist_ok=True)
    path = day_dir / f'{symbol}.json'
    with open(path, 'w') as f:
        json.dump(payload, f, indent=2)
    return path
