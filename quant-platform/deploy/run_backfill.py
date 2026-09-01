#!/usr/bin/env python3
"""Entry point for the qp-backfill service. Nothing but the call.

WHY THIS FILE EXISTS AT ALL.

The unit used to inline the whole thing as `python3 -c "...import sys;
sys.path.insert(0, \".\")..."`. That has to survive TWO parsers before Python
sees it — systemd's, then bash's — and systemd strips backslash escapes inside
single quotes, so `\".\"` reached Python as a bare `.` and it died with
`SyntaxError: invalid syntax` on every start.

A quoting bug in a service file is invisible until the service runs and reads
as though the program itself is broken. So there are no nested quotes any
more: the unit names a file, and the file is ordinary Python.

Run by hand the same way the service runs it:
    cd quant-platform && set -a && . ./.env && set +a && python3 -u deploy/run_backfill.py
"""

import sys
from pathlib import Path

# The service sets WorkingDirectory to quant-platform/, but a person running
# this by hand may not be standing there. Resolve from the file's own location
# so both work.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chart import relstrength as r        # noqa: E402

if __name__ == '__main__':
    print(r.backfill(), flush=True)
