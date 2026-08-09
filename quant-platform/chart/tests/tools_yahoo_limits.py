"""Measure what Yahoo actually serves at each interval, and how fast.

    python3 chart/tests/tools_yahoo_limits.py          (from quant-platform/)

WHY MEASURE RATHER THAN READ. The 1-minute ceiling in tools/data/yahoo.py is
5 days, chosen from what Yahoo is documented to allow. Documented and actual
are not the same thing, and the cost of being wrong is not a slow response —
`interval=1m&range=3mo` returns HTTP 422 and no data at all, which is how every
1-minute request failed the first time this shipped. So the ceiling is worth
checking against the service rather than against a wiki.

It also answers the question the ceiling exists for: how far back can a
1-minute backtest go on this feed before it has to be polygon's job.

AND IT TIMES THE DECISION. The setup fires at 10:00 and the trade is entered at
market on sight, so a decision that arrives at 10:01 has missed. The second
half of this measures a realistic universe end to end and prints how long it
took — the only honest way to know whether the deadline is met, since it
depends on this box, this network and this many cards.

Nothing here is a unit test: it needs the network and its answers change with
Yahoo. It lives in tests/ because that is where the tools that check things
live, and it is named tools_ so pytest does not collect it.
"""

from __future__ import annotations

import sys
import pathlib
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pandas as pd                                        # noqa: E402

from tools.data import yahoo                               # noqa: E402


RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y']
INTERVALS = ['1m', '5m', '15m', '1h', '1d']

# A liquid name, so an empty answer means the RANGE was refused rather than the
# symbol being thin.
PROBE = 'AAPL'


def _raw(interval: str, rng: str):
    """Ask Yahoo directly, bypassing the loader's own ceiling.

    The point is to test the SERVICE, not this module's opinion of it — going
    through load() would only confirm the cap agrees with itself.
    """
    try:
        result = yahoo._fetch(PROBE, {
            'interval': interval, 'range': rng, 'includePrePost': 'false',
        })
    except Exception as e:                                  # noqa: BLE001
        return None, str(e).split(':')[-1].strip()
    stamps = result.get('timestamp') or []
    if not stamps:
        return 0, 'empty'
    first = pd.Timestamp(int(stamps[0]), unit='s', tz='UTC')
    last = pd.Timestamp(int(stamps[-1]), unit='s', tz='UTC')
    return len(stamps), f'{(last - first).days}d of history, {first.date()} → {last.date()}'


def limits():
    print(f'What Yahoo serves for {PROBE}\n')
    print(f'{"interval":9}{"range":7}{"bars":>8}  what came back')
    print('-' * 70)
    ceilings = {}
    for interval in INTERVALS:
        best = None
        for rng in RANGES:
            n, note = _raw(interval, rng)
            mark = ' ' if n else '!'
            print(f'{interval:9}{rng:7}{(n if n is not None else "err"):>8}{mark} {note}')
            if n:
                best = rng
            time.sleep(0.4)                 # do not hammer a free endpoint
        ceilings[interval] = best
        print()
    print('Largest range that returned data:')
    for k, v in ceilings.items():
        print(f'  {k:5} {v or "none"}')
    print('\nCompare with _RANGE_TOKENS in tools/data/yahoo.py. If a ceiling here')
    print('is SMALLER than the one in the code, the code will ask for a range')
    print('that 422s and every request at that interval returns nothing.')
    return ceilings


def timing(n_symbols: int = 40):
    """How long a realistic universe takes, which is the fire-at-time question."""
    # Liquid names, so the timing reflects the network rather than thin tapes.
    pool = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META', 'AMZN', 'GOOGL',
            'NFLX', 'INTC', 'MU', 'COIN', 'PLTR', 'SOFI', 'F', 'BAC', 'T',
            'PFE', 'XOM', 'WMT']
    symbols = (pool * ((n_symbols // len(pool)) + 1))[:n_symbols]

    print(f'\nFetching {n_symbols} symbols of 1m bars, one at a time')
    t0 = time.time()
    for s in symbols[:5]:
        try:
            yahoo.load(s, '1m', pd.Timestamp.utcnow() - pd.Timedelta(days=1),
                       pd.Timestamp.utcnow())
        except Exception as e:                              # noqa: BLE001
            print(f'  {s}: {e}')
    per = (time.time() - t0) / 5
    print(f'  {per:.2f}s per symbol')
    print(f'  → {n_symbols} sequential would be ~{per * n_symbols:.0f}s')
    print(f'  → at 8 in parallel, ~{per * n_symbols / 8:.0f}s')
    print('\nThe decision fires at 10:00 and the trade is entered on sight.')
    print('Anything over ~30s means the alert arrives after the move.')


if __name__ == '__main__':
    limits()
    timing()
