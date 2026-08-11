"""Run the same backtest under several rankings and print one comparison table.

Why this exists: the ranking question — "which 4 of this morning's 26 signals
should the account buy" — needs four runs that differ ONLY in the rank block.
Setting that up by hand in the panel is four rounds of typing on a phone, and
backtest #240 came back byte-identical to #239 because one dropdown was left
on "nothing". The comparison is a script's job.

It takes a BASELINE backtest id and copies that run's stored spec verbatim,
changing nothing but `rank_per_day`. Copied rather than retyped for the same
reason the backtest calls evaluate() instead of reimplementing it: a
comparison whose runs differ in some second, unnoticed way is not a comparison.

    python3 chart/tests/tools_rank_compare.py 239            (from quant-platform/)
    python3 chart/tests/tools_rank_compare.py 239 --top 4 6
    python3 chart/tests/tools_rank_compare.py 239 --host localhost:8765

Ranking happens BEFORE sizing, which is the point of asking at all: the top N
are chosen first and each then gets its full intended risk, instead of the
whole day being taken in arrival order until the balance runs out.

READ THE TRADE COUNT BEFORE THE PROFIT. With 7 sessions, top 4 is 28 trades —
under the 40 the sweep asks for before it will call a winner. Anything here is
a direction to test further, not a result.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# Every ordering worth asking about for a 09:35 opening-range setup, plus the
# unranked baseline it all has to beat. `direction` is left to the metric's
# own default (vwap_extension desc, tight_stop asc) — the same table the live
# decide path reads, so a pick here and a pick at 09:35 rank identically.
VARIANTS = [
    ('take everything', None),
    ('vwap_extension', 'vwap_extension'),
    ('tight_stop', 'tight_stop'),
    ('reg_score', 'reg_score'),
    ('rvol', 'rvol'),
]


def api(host, path, payload=None, timeout=60):
    url = f'http://{host}{path}'
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def run_one(host, spec, name, poll=5.0):
    """Start a backtest and block until it finishes. Returns its summary."""
    spec = dict(spec)
    spec['name'] = name
    started = api(host, '/api/backtest', spec)
    bid = started.get('id')
    if not bid:
        raise SystemExit(f'could not start {name!r}: {started}')
    while True:
        g = api(host, f'/api/backtest/{bid}?trades=0').get('backtest') or {}
        status = g.get('status')
        if status == 'done':
            return bid, (g.get('summary') or {})
        if status == 'error':
            raise SystemExit(f'{name} failed: {g.get("error")}')
        print(f'  #{bid} {name}: {g.get("progress", 0)}%   ', end='\r', flush=True)
        time.sleep(poll)


def row(bid, label, top_n, s):
    """One line of the table, read straight off the stored summary.

    Only fields the account block actually reports — profit factor and average
    R are computed by the report page, not stored, and inventing them here from
    a second formula would put two numbers for one thing in circulation.
    """
    s = s or {}
    a = s.get('account') or {}
    rk = (s.get('coverage') or {}).get('rank_per_day') or {}
    # The check that catches the #240 mistake: a run whose rank block never
    # arrived reports no ranking, and is the baseline again under a new name.
    applied = 'yes' if rk else ('—' if top_n is None else 'NO — never applied')
    return {
        'id': bid, 'rank': label, 'top_n': top_n or '',
        'signals': s.get('trades'),            # survived ranking
        'sized': a.get('trades_sized'),        # the account could afford
        'net$': a.get('net_pnl_usd'),
        'ret%': a.get('return_pct'),
        'win%': a.get('win_rate_pct'),
        'avg$': a.get('avg_pnl_usd'),
        'maxdd%': a.get('max_drawdown_pct'),
        'starved': a.get('skipped_no_capital'),
        'applied': applied,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('baseline', type=int, help='backtest id to copy the spec from')
    ap.add_argument('--top', type=int, nargs='+', default=[4],
                    help='how many per day to keep (default 4)')
    ap.add_argument('--host', default='localhost:8765')
    a = ap.parse_args(argv)

    base = api(a.host, f'/api/backtest/{a.baseline}?trades=0').get('backtest')
    if not base:
        raise SystemExit(f'no backtest #{a.baseline}')
    spec = base['spec']
    print(f'copying the spec of #{a.baseline} — {spec.get("start")} → {spec.get("end")}, '
          f'risk {spec.get("risk_pct")}%, max position {spec.get("max_position_pct")}%\n')

    rows = []
    for label, metric in VARIANTS:
        tops = [None] if metric is None else a.top
        for n in tops:
            s = dict(spec)
            s['rank_per_day'] = {'metric': metric, 'top_n': n} if metric else None
            name = f'rank {label}' + (f' top{n}' if n else '')
            bid, summary = run_one(a.host, s, name)
            rows.append(row(bid, label, n, summary))
            print(' ' * 60, end='\r')
            print(f'  #{bid} {name}: done')

    cols = ['id', 'rank', 'top_n', 'signals', 'sized', 'net$', 'ret%', 'win%',
            'avg$', 'maxdd%', 'starved', 'applied']
    w = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
    print('\n' + '  '.join(c.ljust(w[c]) for c in cols))
    print('  '.join('-' * w[c] for c in cols))
    for r in rows:
        print('  '.join(str(r[c]).ljust(w[c]) for c in cols))
    print('\ntrades first: under 40 per variant, differences here are direction, '
          'not evidence. "starved" is how many signals the balance could not fund.')


if __name__ == '__main__':
    sys.exit(main())
