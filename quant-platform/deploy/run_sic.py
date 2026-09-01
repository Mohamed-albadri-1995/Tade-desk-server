#!/usr/bin/env python3
"""Classify the whole market into SIC industries, then rank the groups.

O'Neil ranks EVERY industry group in the market and buys the leader of a top
one. That only works if a group is the whole industry, so membership cannot
come from what our own screeners happened to return — see chart/sic.py.

Run by hand, or as the qp-sic service:
    cd quant-platform && set -a && . ./.env && set +a && python3 -u deploy/run_sic.py

The first pass walks EDGAR once per filer at its published rate limit and
takes a while. Every company is cached as it is fetched, so an interrupted run
resumes rather than restarting, and later runs are file reads.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chart import relstrength, sic, groups        # noqa: E402

if __name__ == '__main__':
    # THE RS UNIVERSE, NOT EDGAR'S WHOLE INDEX. A filer with no price history
    # cannot be ranked, so fetching its classification buys nothing — and the
    # universe is already on disk from the backfill.
    try:
        rs = relstrength.rs_rating()
        universe = list(rs.index)
        print(f'RS universe: {len(universe)} symbols', flush=True)
    except Exception as e:                                # noqa: BLE001
        universe = None
        print(f'no RS universe yet ({e}); classifying every EDGAR ticker',
              flush=True)

    out = sic.build(universe)
    print(out, flush=True)

    # Rank immediately, so one command leaves the system in a usable state
    # rather than requiring a second one nobody remembers.
    print(groups.build(), flush=True)
