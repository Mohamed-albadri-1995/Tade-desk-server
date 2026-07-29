"""
card_lookup.py — print the complete frozen card for a ticker on a given date.

The warehouse freezes every scanned stock at 9:36 AM into the R1 register, and
R4A/R4B join that card to the end-of-day outcome (upR/downR). This reads those
registers over the screener's HTTP API and prints the whole card, field by
field — the same values the scorer saw that morning.

Usage (on the box, screener running):
    python3 scripts/card_lookup.py SUNE:2026-07-13
    python3 scripts/card_lookup.py SUNE:2026-07-13 LCID:2026-07-16 VEEE:2026-07-15
    python3 scripts/card_lookup.py --dates            # list dates that exist
    python3 scripts/card_lookup.py SUNE               # every date SUNE appears on
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

BASE = 'http://localhost:3000/api/warehouse'
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_CACHE = {}

# Printed in reading order, grouped like the card in the UI.
GROUPS = [
    ('IDENTITY',    ['ticker', 'date', 'capturedAt', 'inShortlist', 'bias', '_score']),
    ('PRICE',       ['price', 'prevClose', 'open', 'change', 'gapPct', 'vwap']),
    ('MOVING AVGS', ['sma5', 'ema9', 'ema13', 'ema20', 'ema50']),
    ('RANGE',       ['dayHigh', 'dayLow', 'monthHigh', 'monthLow', 'monthRangePos']),
    ('VOLUME/SIZE', ['rvol', 'mcap', 'floatShares', 'shortFloat']),
    ('VOLATILITY',  ['atr', 'adrPct']),
    ('PRE-MARKET',  ['pmHigh', 'pmLow', 'pmRange', 'pmAdrRatio']),
    ('CLASSIFY',    ['sector', 'industry', 'screenerKeys', 'themes', 'catalyst']),
    ('MARKET CTX',  ['regime', 'regimeLabel', 'longTerm', 'midTerm', 'shortTerm',
                     'broadResolved', 'secBias', 'secScore', 'secHot']),
    ('OUTCOME',     ['entryPriceA', 'hhA', 'llA', 'upR_A', 'downR_A',
                     'entryPriceB', 'hhB', 'llB', 'upR_B', 'downR_B', 'atr14']),
]


def get(path):
    if path in _CACHE:
        return _CACHE[path]
    try:
        with _OPENER.open(f'{BASE}{path}', timeout=10) as r:
            data = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        data = [] if e.code == 404 else None
        if data is None:
            raise
    except Exception:
        data = []
    _CACHE[path] = data
    return data


def available_dates():
    d = get('/available-dates?register=R1')
    return d if isinstance(d, list) else []


def rows_for(date):
    """R4A rows (card + outcome). Falls back to R1 if the day has no EOD yet."""
    rows = get(f'/R4A/{date}')
    if rows:
        b = {r['ticker']: r for r in (get(f'/R4B/{date}') or []) if r.get('ticker')}
        for r in rows:
            for k in ('entryPriceB', 'hhB', 'llB', 'upR_B', 'downR_B'):
                if k in b.get(r.get('ticker'), {}):
                    r[k] = b[r['ticker']][k]
        return rows, 'R4A+R4B'
    return (get(f'/R1/{date}') or []), 'R1'


def fmt(v):
    if v is None or v == '':
        return '—'
    if isinstance(v, bool):
        return 'yes' if v else 'no'
    if isinstance(v, list):
        return ', '.join(str(x) for x in v) if v else '—'
    if isinstance(v, float):
        return f'{v:,.4f}'.rstrip('0').rstrip('.') if abs(v) < 1e6 else f'{v:,.0f}'
    return str(v)


def show(row, source):
    print()
    print('=' * 62)
    print(f"  {row.get('ticker')}   ·   {row.get('date')}   ·   from {source}")
    print('=' * 62)
    shown = set()
    for title, keys in GROUPS:
        present = [k for k in keys if k in row and row[k] not in (None, '')]
        if not present:
            continue
        print(f'\n  {title}')
        for k in present:
            print(f'    {k:<16}{fmt(row[k])}')
            shown.add(k)
    extra = [k for k in row if k not in shown and row[k] not in (None, '')]
    if extra:
        print('\n  OTHER')
        for k in sorted(extra):
            print(f'    {k:<16}{fmt(row[k])}')


def find_dates_for(ticker):
    hits = []
    for d in available_dates():
        rows, _ = rows_for(d)
        if any(str(r.get('ticker', '')).upper() == ticker for r in rows):
            hits.append(d)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('targets', nargs='*', help='TICKER or TICKER:YYYY-MM-DD')
    ap.add_argument('--dates', action='store_true', help='list dates the warehouse holds')
    ap.add_argument('--url', default=None, help='screener base url')
    args = ap.parse_args()

    if args.url:
        global BASE
        BASE = args.url.rstrip('/') + '/api/warehouse'

    dates = available_dates()
    if args.dates or not args.targets:
        print('\nDates frozen in the R1 register:')
        print('  ' + (', '.join(dates) if dates else '(none — has the 9:36 capture ever run?)'))
        if not args.targets:
            return

    for target in args.targets:
        ticker, _, date = target.partition(':')
        ticker = ticker.upper()

        if not date:
            hits = find_dates_for(ticker)
            print(f"\n{ticker}: found on {', '.join(hits) if hits else 'no stored date'}")
            continue

        if date not in dates:
            print(f'\n{ticker} {date}: no register frozen for that date.')
            print(f"  Dates that do exist: {', '.join(dates) if dates else '(none)'}")
            continue

        rows, source = rows_for(date)
        row = next((r for r in rows if str(r.get('ticker', '')).upper() == ticker), None)
        if row is None:
            hits = find_dates_for(ticker)
            print(f'\n{ticker} {date}: that date exists, but {ticker} was not in the scan.')
            print(f"  {ticker} appears on: {', '.join(hits) if hits else 'no stored date'}")
            continue

        show(row, source)
    print()


if __name__ == '__main__':
    main()
