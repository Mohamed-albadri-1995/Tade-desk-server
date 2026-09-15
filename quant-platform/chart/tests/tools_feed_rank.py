"""Rank one morning on two feeds, side by side, and say where they disagree.

WHY THIS EXISTS. 2026-09-10: the live desk took SIG, LIFE and VRT. The backtest
of the same morning took JMKE where live took LIFE — one slot of three, on a
day where everything else matched.

Two explanations were possible and they need different fixes:

  the universe   the backtest ranked a name live never had on its list
  the ranking    both had both names, and the two sides scored them differently

The first is settled: the register for that day carried thirty cards and BOTH
JMKE and LIFE were on it. So the lists agreed and the ORDER did not.

Which leaves the ranking, and the ranking is `vwap_extension` — a number
computed from VWAP, which is computed from volume, which is a different series
on every feed. Live decides on yahoo; the backtests were run on polygon. That
is enough to swap two adjacent names, and swapping two adjacent names is
exactly the whole of this discrepancy.

So this asks the LIVE decide path — chart/decide.py, the same code 09:35 runs —
for one date, once per feed, and prints the two rankings beside each other. It
computes nothing itself: a comparison that reimplements the number it is
comparing cannot answer anything.

    python3 chart/tests/tools_feed_rank.py --date 2026-09-10
    python3 chart/tests/tools_feed_rank.py --date 2026-09-10 --top 3
    python3 chart/tests/tools_feed_rank.py --date 2026-09-10 --feeds yahoo alpaca
    python3 chart/tests/tools_feed_rank.py --date 2026-09-10 --symbols SIG LIFE JMKE VRT

READ THE ERRORS BEFORE THE TABLE. A feed that could not answer for a symbol
ranks it nowhere, which looks identical to a symbol that did not qualify — and
on the day this was written, every symbol erroring was the whole story. The
counts line says how many of each, per feed, before any of the rows.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_HOST = '127.0.0.1:8765'
# The two strategies behind `OR + VWAP 09:35` — long and short are ranked
# together, because the setup takes the top N of BOTH.
DEFAULT_STRATEGIES = [31, 30]

# What each feed will actually serve per minute, so the wait can be PREDICTED
# rather than discovered. Only the ones that throttle are listed; a feed absent
# here is assumed fast and no estimate is printed for it.
RATE_LIMITED = {'polygon': 5, 'hybrid': 5, 'hybrid_yahoo': 5}
# Seconds between batches for those feeds. 61 rather than 60 because a window
# that starts counting on the first request does not end when a wall clock says
# it should.
PACE_SECONDS = 61
# How much of the list a feed may fail before its column is thrown away rather
# than ranked. A fifth is already generous: the ranking decides three names out
# of thirty, so a handful of missing rows can move the cut on its own.
MAX_UNREAD = 0.2


def post(host, path, body, timeout):
    req = urllib.request.Request(
        f'http://{host}{path}', json.dumps(body).encode('utf-8'),
        {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get(host, path, timeout=30):
    with urllib.request.urlopen(f'http://{host}{path}', timeout=timeout) as r:
        return json.load(r)


def register_symbols(host, register, date):
    """The cards frozen for that day — the list the desk actually ranked.

    Read rather than typed. A comparison run against a hand-written symbol list
    is a comparison of something the desk never saw.
    """
    q = urllib.parse.urlencode({'register': register, 'date': date})
    d = get(host, f'/api/screener/register?{q}')
    return [str(r['ticker']).upper() for r in (d.get('rows') or []) if r.get('ticker')]


def rank_on(host, feed, symbols, date, strategies, metric, tf, view, timeout):
    """Every signal this feed produced, in the order the desk would take them.

    `top_n` is 0 on purpose: the cut is applied here, after both feeds have
    answered, so a name that fell one place short is visible rather than
    absent. Asking qp to cut would hide the very rows worth reading.
    """
    rows, errors, seen = [], [], 0
    # SENT IN BATCHES THE FEED WILL ACTUALLY SERVE.
    #
    # Thirty symbols in one request to polygon returned 429 for twenty-five of
    # them, and the run still printed a ranking — five names read as the whole
    # market. Every symbol is scored independently, so splitting the list
    # changes no number; it only stops the feed refusing most of it.
    rate = RATE_LIMITED.get(feed)
    batches = ([symbols[i:i + rate] for i in range(0, len(symbols), rate)]
               if rate else [symbols])
    for sid in strategies:
        for n, batch in enumerate(batches):
            if n:
                time.sleep(PACE_SECONDS)
            body = {'strategy_id': sid, 'symbols': batch, 'date': date, 'tf': tf,
                    'feed': feed, 'view': view, 'fill': 'live', 'top_n': 0,
                    'metric': metric, 'target_r': 2.0}
            try:
                d = post(host, '/api/setup/decide', body, timeout)
            except urllib.error.URLError as e:
                return None, [f'strategy {sid}: {e}'], 0
            if not d.get('ok'):
                return None, [f"strategy {sid}: {d.get('error')}"], 0
            for p in (d.get('picks') or []):
                rows.append({'symbol': p.get('symbol'), 'side': p.get('side'),
                             'metric': p.get('metric'), 'entry': p.get('entry'),
                             'at': p.get('entry_at'), 'strategy': sid})
            for e in (d.get('errors') or []):
                errors.append(
                    f"{e.get('symbol')}: {str(e.get('error') or '').strip()[:90]}")
            seen += int((d.get('counts') or {}).get('evaluated') or 0)
    # DESCENDING, which is vwap_extension's own default direction — the same
    # table the live path reads. A None metric sorts last rather than crashing:
    # "could not be scored" is a real outcome and decide.py reports it.
    rows.sort(key=lambda r: (r['metric'] is None,
                             -(r['metric'] if r['metric'] is not None else 0)))
    return rows, errors, seen


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', required=True, help='YYYY-MM-DD, ET')
    ap.add_argument('--feeds', nargs='+', default=['yahoo', 'polygon'])
    ap.add_argument('--strategies', nargs='+', type=int, default=DEFAULT_STRATEGIES)
    ap.add_argument('--symbols', nargs='+', default=None,
                    help='override the register (rarely what you want)')
    ap.add_argument('--register', default='*:R1', help="'*:R1' is every tool's cards")
    ap.add_argument('--metric', default='vwap_extension')
    ap.add_argument('--top', type=int, default=3, help='where the setup cuts')
    ap.add_argument('--tf', default='1m')
    ap.add_argument('--view', default='all')
    ap.add_argument('--host', default=DEFAULT_HOST)
    # POLYGON'S FREE PLAN IS FIVE REQUESTS A MINUTE. Thirty symbols is six
    # minutes before qp has even finished fetching, so a four-minute timeout
    # killed the run every time and looked like the tool hanging.
    ap.add_argument('--timeout', type=float, default=1200.0)
    a = ap.parse_args()

    try:
        symbols = a.symbols or register_symbols(a.host, a.register, a.date)
    except Exception as e:                       # noqa: BLE001 — said, not raised
        # A TRACEBACK IS NOT AN ANSWER on a phone. The two ways this fails are
        # "qp is not running" and "that register has no such day", and they
        # send you to different places.
        print(f'Could not read the {a.register} register for {a.date} from '
              f'{a.host}: {e}')
        print('Is qp-chart up?  curl -s http://' + a.host + '/api/health')
        return 1
    if not symbols:
        print(f'No cards for {a.date} on {a.register} — nothing to rank.')
        return 1
    print(f'{a.date}  ·  {len(symbols)} card(s)  ·  rank by {a.metric}  ·  '
          f'setup takes the top {a.top}\n')

    table, order, unusable = {}, {}, {}
    for feed in a.feeds:
        # SAY IT BEFORE IT HAPPENS, not after.
        #
        # This printed nothing between feeds, so a run that was working
        # correctly showed one line and then a dead terminal for six minutes —
        # reported as "Hang". A tool that goes silent during the slow part is
        # the same failure as a check that logs nothing when it passes: the
        # working case and the broken case look identical.
        rate = RATE_LIMITED.get(feed)
        wait = (f' — {feed} allows about {rate} request(s) a minute on the free '
                f'plan, so up to ~{max(1, round(len(symbols) / rate))} min'
                if rate else '')
        print(f'{feed:<9} asking for {len(symbols)} symbol(s){wait} …',
              flush=True)
        t0 = time.time()
        rows, errors, seen = rank_on(a.host, feed, symbols, a.date, a.strategies,
                                     a.metric, a.tf, a.view, a.timeout)
        if rows is None:
            print(f'{feed:<9} DID NOT ANSWER after {time.time() - t0:.0f}s — '
                  f'{"; ".join(errors)}', flush=True)
            continue
        print(f'{feed:<9} {seen} evaluated · {len(rows)} signalled · '
              f'{len(errors)} could not be read  ({time.time() - t0:.0f}s)',
              flush=True)
        # NAMED, not counted. On 2026-09-14 every symbol errored for the same
        # reason and the count alone said nothing about which reason it was.
        for e in errors[:4]:
            print(f'          ! {e}')
        if len(errors) > 4:
            print(f'          ! +{len(errors) - 4} more')
        # UNREAD IS NOT UNQUALIFIED, and a ranking built from the difference
        # is worse than no ranking: on 2026-09-10 polygon answered for five of
        # thirty names and this printed "polygon takes BKNG, MXL, VRT" — a
        # confident sentence about twenty-five symbols nobody had seen.
        unread = len({e.split(':')[0] for e in errors})
        if unread and unread > len(symbols) * MAX_UNREAD:
            print(f'          → {unread} of {len(symbols)} could not be read. '
                  f'That is not a ranking, it is a gap. {feed} is EXCLUDED '
                  'from the comparison below.', flush=True)
            unusable[feed] = unread
            continue
        table[feed] = {r['symbol']: r for r in rows}
        order[feed] = [r['symbol'] for r in rows]

    live = [f for f in a.feeds if f in table]
    if len(live) < 2:
        print('\nFewer than two feeds answered well enough to compare.')
        for f, n in unusable.items():
            print(f'  {f}: {n} symbol(s) unread — try  --symbols A B C  on a '
                  'few names, or run it again when the feed is not throttled.')
        return 1

    print()
    head = f'{"":<8}' + ''.join(f'{f:>22}' for f in live)
    print(head)
    print('-' * len(head))
    names = []
    for f in live:
        for s in order[f]:
            if s not in names:
                names.append(s)
    for s in names:
        cells = ''
        for f in live:
            r = table[f].get(s)
            if not r:
                cells += f'{"—":>22}'
                continue
            pos = order[f].index(s) + 1
            mark = '*' if pos <= a.top else ' '
            m = 'n/a' if r['metric'] is None else f"{r['metric']:.4f}"
            # ONE CELL, PADDED ONCE. Padding the metric and then appending the
            # rank ran the columns together, which is how a table stops being
            # readable on a phone at exactly the width it matters.
            cells += f'{mark}#{pos} {str(r["side"])[:1].upper()} {m}'.rjust(22)
        print(f'{s:<8}{cells}')

    print(f'\n* = inside the top {a.top}, which is what the setup takes.\n')

    # THE ANSWER, IN ONE LINE. The table is the evidence; this is the finding.
    taken = {f: set(order[f][:a.top]) for f in live}
    base = live[0]
    for f in live[1:]:
        only_base = sorted(taken[base] - taken[f])
        only_f = sorted(taken[f] - taken[base])
        if not only_base and not only_f:
            print(f'{base} and {f} take the SAME {a.top} names. '
                  'The feed is not what separates them.')
        else:
            print(f'{base} takes {sorted(taken[base])}')
            print(f'{f} takes {sorted(taken[f])}')
            print(f'  → only on {base}: {only_base or "nothing"}')
            print(f'  → only on {f}: {only_f or "nothing"}')
            print('  The two feeds rank this morning differently, so live and a '
                  'backtest run on the other feed CANNOT take the same names.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
