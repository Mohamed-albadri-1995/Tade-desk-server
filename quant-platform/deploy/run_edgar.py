#!/usr/bin/env python3
"""Fill the C and A earnings tables for the whole universe, in one pass.

The nightly job does this too, under a time budget. This is the FIRST pass —
the one that has thousands of companies to fetch rather than a few hundred —
and it runs with no ceiling, so the cache is complete before the first morning
that depends on it instead of filling in over a week of nights.

    cd quant-platform && set -a && . ./.env && set +a && python3 -u deploy/run_edgar.py

Hours, not minutes: one request per company, a payload of several megabytes
each, at EDGAR's published rate limit. Run it under systemd or nohup — a run
tied to a phone's terminal dies the moment the screen locks.

RESUMABLE, so being interrupted costs only the company in flight. Every
company is written the moment it is parsed, and the order is "nothing on disk
first, then the stalest", which means a stopped run has already done the part
that mattered most and the next one does not repeat it.

    QP_EDGAR_REFRESH_DAYS   how old a cached table may get (default 5)
    QP_EDGAR_WALK_SECONDS   the nightly ceiling — ignored here
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chart import relstrength, edgar                # noqa: E402

if __name__ == '__main__':
    # THE RS UNIVERSE. A name with no price history cannot be screened, so its
    # earnings tables would never be looked at — the same reasoning that
    # decides what run_sic.py classifies, and it must stay the same universe
    # or a stock would have a group and no tables.
    try:
        rs = relstrength.rs_rating()
        universe = list(rs.index)
        print(f'RS universe: {len(universe)} symbols', flush=True)
    except Exception as e:                                # noqa: BLE001
        print(f'no RS universe on disk ({e}) — run the backfill first',
              flush=True)
        sys.exit(1)

    # budget_s=0 removes the nightly ceiling. This run is meant to finish.
    print(edgar.walk(universe, budget_s=0), flush=True)
