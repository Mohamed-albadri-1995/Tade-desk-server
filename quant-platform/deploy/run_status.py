#!/usr/bin/env python3
"""What the CANSLIM chain actually has, and what it is missing.

    cd quant-platform && set -a && . ./.env && set +a && python3 -u deploy/run_status.py

WHY THIS EXISTS. Every letter is fed by a different file written by a
different step on a different clock, and a card cannot tell you which of them
is empty — it only shows the hole. Working out whether "L: group ranks not
built yet" meant the nightly job had not run, or had run and failed, or had
run and succeeded but this stock is not in the map, took reading three files
by hand every time.

So this prints one line per link: what is there, how old it is, how much of
the universe it covers, and — when something is missing — the exact command
that fixes it. Nothing here fetches or builds. It only looks.

READ-ONLY, AND SAFE TO RUN ANY TIME, including while the nightly job is
running: it opens files and counts, and a file being rewritten underneath it
shows as unreadable rather than as an error.
"""

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'data'

OK, WARN, GONE = 'OK      ', 'THIN    ', 'MISSING '


def age(path: Path) -> str:
    try:
        d = (time.time() - path.stat().st_mtime) / 86400
        if d < 1:
            return f'{d * 24:.0f}h old'
        return f'{d:.0f}d old'
    except Exception:                                     # noqa: BLE001
        return '—'


def load(path: Path):
    """None if absent OR mid-rewrite. A half-written file is not a failure to
    report; the nightly job writes through a temp and renames."""
    try:
        return json.loads(path.read_text())
    except Exception:                                     # noqa: BLE001
        return None


def line(letter, name, status, detail, fix=''):
    print(f'  {status}{letter:<3} {name:<22} {detail}')
    if fix:
        print(f'          {"":<3} {"":<22} → {fix}')


def main():
    print()
    print('=' * 72)
    print('  CANSLIM data — what is here and what is not')
    print('=' * 72)
    print()

    # ── 1. PRICES. Everything below is built on these. ──────────────────
    universe = []
    try:
        from chart import relstrength
        cache = Path.home() / '.qp-cache' / 'grouped'
        days = sorted(p.stem for p in cache.glob('*.parquet')) if cache.exists() else []
        rs = relstrength.rs_rating()
        universe = list(rs.index) if rs is not None and not rs.empty else []
        if not days:
            line('', 'price history', GONE, 'no sessions cached',
                 'sudo systemctl start qp-backfill')
        else:
            line('', 'price history', OK if len(days) > 200 else WARN,
                 f'{len(days)} sessions, {days[0]} → {days[-1]} · '
                 f'{len(universe)} symbols rated',
                 '' if len(days) > 200 else 'still backfilling — a year is '
                 'needed for a 12-month RS rating')
    except Exception as e:                                # noqa: BLE001
        line('', 'price history', GONE, f'could not read: {str(e)[:60]}',
             'sudo systemctl start qp-backfill')

    n_uni = len(universe) or None

    # WITHOUT A UNIVERSE THERE IS NO COVERAGE, and saying "0%" for that is a
    # different claim from saying "0% covered" — the first is a fact about
    # this check, the second about the data. It read as an empty cache when
    # the cache was full and only the price history was missing.
    def coverage(n):
        return (f'{100 * n / n_uni:.0f}% of universe' if n_uni
                else 'coverage n/a (no price universe)')

    def covered(n, floor):
        return n_uni is None or (100 * n / n_uni) >= floor

    # ── 2. M — the market model ─────────────────────────────────────────
    p = Path(os.environ.get('ONEIL_MARKET_FILE') or (DATA / 'oneil-market.json'))
    d = load(p)
    if not d or not d.get('ok'):
        line('M', 'market direction', GONE, 'not built',
             'sudo systemctl start qp-daily')
    else:
        line('M', 'market direction', OK,
             f"{d.get('status')} · as of {d.get('as_of')} · {age(p)}")

    # ── 3. L — the industry map, then the ranks built on it ─────────────
    p = Path(os.environ.get('INDUSTRY_MAP_FILE') or (DATA / 'industry-map.json'))
    d = load(p)
    syms = (d or {}).get('symbols') or {}
    from_sic = sum(1 for v in syms.values()
                   if isinstance(v, dict) and v.get('src') == 'sic')
    if not syms:
        # NOT a qp-sic unit — there isn't one. The nightly job's step 3 is the
        # SIC walk, so the same command covers it, and naming a unit that does
        # not exist is worse than naming none.
        line('L', 'industry map', GONE, 'no symbols classified',
             'sudo systemctl start qp-daily   (its step 3 is the SIC walk)')
    else:
        line('L', 'industry map', OK if from_sic > 1000 else WARN,
             f'{len(syms)} symbols · {from_sic} from SEC SIC codes · '
             f'{coverage(len(syms))} · {age(p)}',
             '' if from_sic > 1000 else 'mostly screener labels — run '
             'deploy/run_sic.py so membership is the whole market')

    p = Path(os.environ.get('ONEIL_GROUPS_FILE') or (DATA / 'oneil-groups.json'))
    d = load(p)
    if not d or not d.get('ok'):
        line('L', 'group ranks', GONE, 'not built',
             'sudo systemctl start qp-daily')
    else:
        gs = d.get('groups') or []
        rolled = sum(1 for g in gs if g.get('level') == 'sector')
        line('L', 'group ranks', OK,
             f"{d.get('total_groups')} groups ({rolled} rolled up) over "
             f"{d.get('mapped_symbols')} symbols · as of {d.get('as_of')}")

    # ── 4. I — institutional sponsorship ────────────────────────────────
    p = Path(os.environ.get('ONEIL_13F_FILE') or (DATA / 'oneil-13f.json'))
    d = load(p)
    if not d or not d.get('ok'):
        line('I', 'institutions (13F)', GONE, 'not built',
             'sudo systemctl start qp-daily')
    else:
        st = d.get('stocks') or {}
        line('I', 'institutions (13F)', OK,
             f"{len(st)} tickers matched · quarters "
             f"{' '.join(d.get('quarters') or [])} · {coverage(len(st))} "
             f"· {age(p)}")

    # ── 5. C and A — the EDGAR earnings tables ──────────────────────────
    #
    # THE ONE THAT IS COUNTED, NOT JUST CHECKED FOR EXISTENCE. It is a file
    # per company rather than one shared file, so "it exists" says nothing —
    # the only useful number is how much of the universe is covered and how
    # much of that is still fresh enough for a card to accept.
    try:
        from chart import edgar
        cdir = edgar.CACHE
        files = list(cdir.glob('*.json')) if cdir.exists() else []
        files = [f for f in files if not f.name.startswith('_')]
        fresh = built = dead = 0
        for f in files:
            rec = load(f)
            if rec is None:
                continue
            if rec.get('ok'):
                built += 1
            else:
                dead += 1
            try:
                if (time.time() - f.stat().st_mtime) / 86400 <= edgar.REFRESH_DAYS:
                    fresh += 1
            except Exception:                             # noqa: BLE001
                pass
        if not files:
            line('C/A', 'earnings tables', GONE, 'nothing cached',
                 'sudo systemctl start qp-edgar   (hours — the first pass)')
        else:
            full = covered(len(files), 80)
            line('C/A', 'earnings tables', OK if full else WARN,
                 f'{built} with filings · {dead} have none (ETFs, ADRs) · '
                 f'{fresh} still fresh · {coverage(len(files))}',
                 '' if full else 'sudo systemctl start qp-edgar   '
                 '(the first pass takes hours; the nightly job tops it up)')
    except Exception as e:                                # noqa: BLE001
        line('C/A', 'earnings tables', GONE, f'could not read: {str(e)[:60]}')

    # ── 6. What is NOT a file, and never will be ────────────────────────
    #
    # N and S are computed per card from price bars at request time. There is
    # nothing to build and nothing that can be "missing" — but a blank N or S
    # on a card looks exactly like a missing file, so they are listed here to
    # say plainly that they are not one.
    print()
    line('N', 'the base (weekly)', OK,
         'computed per card from 560 days of bars — no file to build')
    print(f'          {"":<3} {"":<22} '
          'blank means the stock has under 7 weeks of history, not a missing job')
    line('S', 'supply / demand', OK,
         'U/D and A/D computed per card from bars — no file to build')
    print(f'          {"":<3} {"":<22} '
          'float is not published by any free source and is not estimated')

    print()
    print('  Nightly job:  systemctl list-timers qp-daily   ·   '
          'journalctl -u qp-daily -n 50')
    print()


if __name__ == '__main__':
    main()
