#!/usr/bin/env python3
"""Keep the whole CANSLIM chain current. One job, run after every close.

NOTHING HERE IS BUILT ONCE.

Every link depends on the one above it, and each goes stale on its own clock:

    prices        one new session a day
    RS ratings    recomputed from those prices — a rank is only as fresh as
                  the last session in it
    SIC map       new listings appear constantly and companies reclassify;
                  a group that gains four members has a different median
    groups        ranked from RS over that map, and the 3-month rotation
                  compares against a moving point 63 sessions back
    market model  distribution days age out of a 25-session window, so it
                  changes even on a day the market does nothing
    C and A       a company files four times a year, but the UNIVERSE turns
                  over every morning: tomorrow's screener returns names
                  nobody has opened a card on, and their tables have to be
                  waiting or the card is blank on the only day it is looked at

Built once and left, the card would keep printing a rank from the day it was
first opened. The pieces do carry their own TTLs and rebuild when a page asks
for them — but that means the first person to open a tool in the morning pays
for the rebuild, and nothing at all happens on a day nobody opens one. This
runs after the close so the answers are already waiting.

Each step is independent: one failing must not stop the rest, because a stale
group rank costs a line on a card and a stale market model is the one number
where being a month old is worse than being absent.

    cd quant-platform && set -a && . ./.env && set +a && python3 -u deploy/run_daily.py
"""

import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def step(name, fn):
    """Run one link. Report what happened; never take the others down."""
    try:
        out = fn()
        print(f'[ok  ] {name}: {out}', flush=True)
        return out
    except Exception as e:                                # noqa: BLE001
        print(f'[FAIL] {name}: {e}', flush=True)
        traceback.print_exc()
        return None


def main():
    from chart import relstrength, oneil, groups, sic, f13, edgar

    # 1. PRICES. One session a day; the whole chain is built on this.
    step('rs universe top-up', lambda: relstrength.top_up())

    # 2. THE MARKET MODEL. Rebuilt even on a quiet day: distribution days age
    #    out of a 25-session window whether or not anything happened.
    def _market():
        m = oneil.build()
        if m.get('ok'):
            oneil.write_shared(m)
        return m.get('status')
    step('market model (M)', _market)

    # 3. THE INDUSTRY MAP. Only new tickers and entries older than the cache
    #    age are fetched, so this is a few requests on an ordinary day and a
    #    long walk only the first time — see sic.MAX_AGE_DAYS.
    def _sic():
        rs = relstrength.rs_rating()
        universe = list(rs.index) if rs is not None and not rs.empty else None
        # LOGS AS IT GOES, and it must. This step is the long one — one
        # request per filer, twenty minutes on its first pass — and it was
        # silenced here, so the journal showed three lines and then nothing
        # for twenty minutes. A job that prints nothing while it works is
        # indistinguishable from a job that has hung, which is exactly the
        # question the log exists to answer.
        out = sic.build(universe, log=lambda m: print(f'       {m}', flush=True))
        return (f"{out.get('tickers')} classified, {out.get('fetched')} fetched, "
                f"{out.get('total_in_map')} in map")
    step('industry map (SIC)', _sic)

    # 4. INSTITUTIONAL SPONSORSHIP. Quarterly data, so most nights this
    #    finds the same quarters already cached and does nothing — but it has
    #    to be asked, or a new quarter would land and never be picked up.
    def _f13():
        out = f13.build(log=lambda m: print(f'       {m}', flush=True))
        return (f"{out.get('tickers')} tickers over {out.get('quarters')}"
                if out.get('ok') else f"not built: {out.get('error')}")
    step('institutional sponsorship (I)', _f13)

    # 5. THE GROUPS. Last, because it reads everything above it.
    def _groups():
        g = groups.build()
        # BUILD DOES NOT WRITE. groups.build() computes and returns; the qp
        # endpoint is what publishes the file the nine tools read. Calling
        # build() alone ranked 229 groups every night and threw them away, and
        # the market tab kept saying "not built yet" while the job's own log
        # said it had built them. Anything computed here must be persisted
        # here — see the same pairing on the market model above.
        wrote = groups.write_shared(g) if g.get('ok') else None
        return (f"{g.get('total_groups')} groups over "
                f"{g.get('mapped_symbols')} symbols, as of {g.get('as_of')}"
                f" → {wrote}"
                if g.get('ok') else f"not built: {g.get('error')}")
    step('group ranks (L)', _groups)

    # 6. THE EARNINGS TABLES. Last, because it is by far the longest step and
    #    nothing above it waits on the result — the market model and the group
    #    ranks must be published even on a night this runs out of time.
    #
    #    OVER THE UNIVERSE, NOT OVER TODAY'S PICKS. Warming the cache with the
    #    names a scan returned only helps the second time that name is
    #    scanned, and a screener that returns the same names two days running
    #    is a screener that has stopped working. Tomorrow's card is a name
    #    nobody has looked at yet, so the answer has to already be there.
    def _fundamentals():
        rs = relstrength.rs_rating()
        universe = list(rs.index) if rs is not None and not rs.empty else []
        if not universe:
            return 'no RS universe yet — nothing to walk'
        out = edgar.walk(universe, log=lambda m: print(f'       {m}', flush=True))
        if not out.get('ok'):
            return f"not walked: {out.get('error')}"
        return (f"{out['built']} built, {out['no_filings']} have no filings, "
                f"{out['failed']} failed, {out['remaining']} left for tomorrow "
                f"({out['seconds']}s)")
    step('earnings tables (C, A)', _fundamentals)


if __name__ == '__main__':
    main()
