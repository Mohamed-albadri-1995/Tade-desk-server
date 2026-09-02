#!/usr/bin/env python3
"""Build I — institutional sponsorship — on its own, off the phone.

    cd quant-platform && set -a && . ./.env && set +a && python3 -u deploy/run_13f.py

WHY SEPARATE FROM run_daily.py. The nightly job builds this as step 4 and that
stays true. But a first build downloads a few hundred megabytes PER QUARTER —
338MB for one of them — and the nightly job's step 6 walks EDGAR straight
afterwards, so running the whole job to fill 13F means two large network jobs
at once against the same host.

This is the one step, so it can be started on its own while qp-edgar is
already running: they touch different endpoints and neither is waiting on the
other.

RUN IT AS THE SERVICE, NOT IN A TERMINAL. "I think it will stop before finish
if it's running on my phone" — correct, and it did. deploy/qp-13f.service.

RESUMABLE. Each quarter's INFOTABLE is cached as a .tsv once extracted, so an
interrupted run re-uses everything it already pulled. An EMPTY extract is
never cached — that bug cost a quarter which then answered "0 securities"
forever without re-fetching.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chart import f13                                # noqa: E402

if __name__ == '__main__':
    out = f13.build(log=lambda m: print(m, flush=True))
    print(out if not out.get('ok') else
          f"ok — {out['tickers']} tickers over {out['quarters']}"
          + (f" · {out['fell_back']}" if out.get('fell_back') else ''),
          flush=True)
    sys.exit(0 if out.get('ok') else 1)
