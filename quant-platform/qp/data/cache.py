"""
Parquet-backed disk cache for Bars.

Layout under `cache_dir`:
    <source>/<symbol>/<timeframe>/<start>_<end>.parquet
plus a sibling `<...>.json` sidecar with metadata (adjusted, source).

Cache keys are the (symbol, timeframe, start, end) window we asked
for — not what the vendor actually returned — so re-requesting the
same window is a hit even if some bars are missing.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import List, Optional

import pandas as pd

from qp.data.sources.base import Bars


def _fmt_ts(ts: pd.Timestamp) -> str:
    t = pd.Timestamp(ts)
    if t.tz is None:
        t = t.tz_localize('UTC')
    return t.tz_convert('UTC').strftime('%Y%m%dT%H%M%SZ')


def _paths(cache_dir: Path, source: str, symbol: str, timeframe: str,
           start: pd.Timestamp, end: pd.Timestamp) -> tuple[Path, Path]:
    dir_ = Path(cache_dir) / source / symbol / timeframe
    stem = f'{_fmt_ts(start)}_{_fmt_ts(end)}'
    return dir_ / f'{stem}.parquet', dir_ / f'{stem}.json'


def read(cache_dir: Path, source: str, symbol: str, timeframe: str,
         start: pd.Timestamp, end: pd.Timestamp) -> Optional[Bars]:
    parquet, meta = _paths(cache_dir, source, symbol, timeframe, start, end)
    if not parquet.exists() or not meta.exists():
        return None
    df = pd.read_parquet(parquet)
    m = json.loads(meta.read_text())
    return Bars(df=df, symbol=symbol, timeframe=timeframe,
                adjusted=m.get('adjusted', True), source=m.get('source', source))


def write(cache_dir: Path, bars: Bars,
          start: pd.Timestamp, end: pd.Timestamp) -> None:
    parquet, meta = _paths(
        cache_dir, bars.source or 'unknown', bars.symbol, bars.timeframe, start, end,
    )
    parquet.parent.mkdir(parents=True, exist_ok=True)
    bars.df.to_parquet(parquet)
    meta.write_text(json.dumps({
        'source': bars.source, 'adjusted': bars.adjusted,
        'symbol': bars.symbol, 'timeframe': bars.timeframe,
        'start': _fmt_ts(start), 'end': _fmt_ts(end),
    }))


def list_cached(cache_dir: Path) -> List[dict]:
    root = Path(cache_dir)
    if not root.exists():
        return []
    out = []
    for meta_path in sorted(root.rglob('*.json')):
        try:
            out.append(json.loads(meta_path.read_text()))
        except (json.JSONDecodeError, OSError):
            continue
    return out


def clear_cache(cache_dir: Path) -> int:
    root = Path(cache_dir)
    if not root.exists():
        return 0
    n = sum(1 for _ in root.rglob('*.parquet'))
    shutil.rmtree(root)
    return n
