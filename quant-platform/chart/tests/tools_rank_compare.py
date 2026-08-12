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
    python3 chart/tests/tools_rank_compare.py 239 --top 2 4 6 8
    python3 chart/tests/tools_rank_compare.py 239 --top 4 --cap keep
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
import math
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


def wait_for_server(host, seconds=90):
    """Block until qp answers, instead of dying on the first refused connection.

    This script is almost always run right after `systemctl restart qp-chart`,
    and the service takes a few seconds to bind its port. A run that dies there
    dies AFTER being launched with nohup, so the failure is silent until you
    come back an hour later to an empty file — which is exactly how the first
    attempt at this sweep was lost. Waiting costs seconds; not waiting costs
    the whole run.
    """
    deadline = time.time() + seconds
    first = True
    while True:
        try:
            api(host, '/api/backtests', timeout=5)
            if not first:
                print('  qp is up.')
            return
        except (urllib.error.URLError, OSError, ValueError) as e:
            if time.time() >= deadline:
                raise SystemExit(
                    f'qp never answered on {host} within {seconds}s ({e}). '
                    f'Check: systemctl status qp-chart')
            if first:
                print(f'waiting for qp on {host} to come up...')
                first = False
            time.sleep(2)


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
        # A carriage return overwrites a line on a terminal. Redirected to a
        # file — which is how this is always run, because a 17-backtest sweep
        # outlives an SSH session — it appends every single update instead, and
        # the run that matters ends up as megabytes of counter with the table
        # buried at the bottom. So the live counter is for a TTY only; a file
        # gets one line per finished backtest, which is all it can use.
        if sys.stdout.isatty():
            print(f'  #{bid} {name}: {g.get("progress", 0)}%   ', end='\r', flush=True)
        time.sleep(poll)


def cap_for(top_n, mode, spec_cap):
    """The per-position cap that lets ALL `top_n` names actually be funded.

    Without this the comparison measures two things at once. The account holds
    about 100/cap positions, so asking for the top 8 at a 25% cap funds four of
    them and starves the rest in arrival order — and a run where half the picks
    never happened cannot say whether the picking was any good. Dividing the
    same capital into N slices keeps the ONLY difference between runs the
    number of names taken.

    100/N rounded DOWN to the cent, never up. round(100/6, 4) is 16.6667, and
    six of those is 100.0002% of the account — the sixth position does not fit,
    so a run asking for the top 6 quietly funds five and a half of them. The
    same figure typed into the live panel promised six positions and delivered
    five. Floored, 16.66 x 6 = 99.96 and all six fit.
    """
    if mode == 'keep' or not top_n:
        return spec_cap
    if mode != 'auto':
        return float(mode)
    return math.floor(10000.0 / top_n) / 100.0


def row(bid, label, top_n, cap, s):
    """One line of the table, read straight off the stored summary.

    Only fields the account block actually reports — profit factor and average
    R are computed by the report page, not stored, and inventing them here from
    a second formula would put two numbers for one thing in circulation.
    """
    s = s or {}
    a = s.get('account') or {}
    rk = (s.get('coverage') or {}).get('rank_per_day') or {}
    ch = a.get('challenge') or {}
    # The check that catches the #240 mistake: a run whose rank block never
    # arrived reports no ranking, and is the baseline again under a new name.
    applied = 'yes' if rk else ('—' if top_n is None else 'NO — never applied')
    return {
        'id': bid, 'rank': label, 'top_n': top_n or '', 'cap%': cap or '',
        'signals': s.get('trades'),            # survived ranking
        'sized': a.get('trades_sized'),        # the account could afford
        'net$': a.get('net_pnl_usd'),
        'ret%': a.get('return_pct'),
        'win%': a.get('win_rate_pct'),
        'avg$': a.get('avg_pnl_usd'),
        'maxdd%': a.get('max_drawdown_pct'),
        'starved': a.get('skipped_no_capital'),
        # the funded-account verdict, when the baseline spec asked for one
        'first': {'target': 'PASS', 'drawdown': 'FAIL',
                  'neither': 'neither'}.get(ch.get('result'), ''),
        'wcDD%': ch.get('worst_case_dd_pct', ''),
        'applied': applied,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('baseline', type=int, help='backtest id to copy the spec from')
    ap.add_argument('--top', type=int, nargs='+', default=[4],
                    help='how many per day to keep (default 4)')
    ap.add_argument('--challenge', nargs=2, type=float, metavar=('TARGET', 'MAXDD'),
                    help='funded-account rule, e.g. --challenge 6 3: did each '
                         'variant reach +6%% before ever touching -3%%? Judged '
                         'on the worst case, with open risk counted.')
    ap.add_argument('--dd-basis', default='start', choices=('start', 'peak'),
                    help="measure the drawdown from the opening balance "
                         "(start, a static max loss) or the highest balance "
                         "reached (peak, a trailing drawdown)")
    ap.add_argument('--cap', default='auto',
                    help="per-position cap: 'auto' (100/N, so every pick gets "
                         "funded and the runs differ only in how many names "
                         "they take), 'keep' (whatever the baseline used), or "
                         "a number to pin one cap across all of them")
    ap.add_argument('--host', default='localhost:8765')
    a = ap.parse_args(argv)

    wait_for_server(a.host)
    base = api(a.host, f'/api/backtest/{a.baseline}?trades=0').get('backtest')
    if not base:
        raise SystemExit(f'no backtest #{a.baseline}')
    spec = base['spec']
    print(f'copying the spec of #{a.baseline} — {spec.get("start")} → {spec.get("end")}, '
          f'risk {spec.get("risk_pct")}%, max position {spec.get("max_position_pct")}%')
    print('cap per position: ' + ('100/N, so all N picks get funded'
                                  if a.cap == 'auto' else str(a.cap)) + '\n')

    if a.challenge:
        spec = dict(spec)
        spec['challenge'] = {'target_pct': a.challenge[0],
                             'max_dd_pct': a.challenge[1],
                             'basis': a.dd_basis}
        print(f'challenge: reach +{a.challenge[0]}% before touching '
              f'-{a.challenge[1]}% from the {a.dd_basis}\n')

    rows = []
    for label, metric in VARIANTS:
        tops = [None] if metric is None else a.top
        for n in tops:
            s = dict(spec)
            s['rank_per_day'] = {'metric': metric, 'top_n': n} if metric else None
            cap = cap_for(n, a.cap, spec.get('max_position_pct'))
            if cap:
                s['max_position_pct'] = cap
            name = f'rank {label}' + (f' top{n} cap{cap}%' if n else '')
            bid, summary = run_one(a.host, s, name)
            rows.append(row(bid, label, n, cap, summary))
            if sys.stdout.isatty():
                print(' ' * 60, end='\r')
            print(f'  #{bid} {name}: done', flush=True)

    cols = ['id', 'rank', 'top_n', 'cap%', 'signals', 'sized', 'net$', 'ret%', 'win%',
            'avg$', 'maxdd%', 'wcDD%', 'first', 'starved', 'applied']
    w = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
    print('\n' + '  '.join(c.ljust(w[c]) for c in cols))
    print('  '.join('-' * w[c] for c in cols))
    for r in rows:
        print('  '.join(str(r[c]).ljust(w[c]) for c in cols))
    print('\nread avg$, not net$: taking more names raises the total by '
          'arithmetic, so only the average says whether the extra names were '
          'worth adding. A real ranking makes it fall in ORDER as top_n grows.')
    print('trades first: under 40 per variant, differences here are direction, '
          'not evidence. "starved" should be 0 — anything else means the run '
          'measured the ranking AND the account running dry, mixed together.')


if __name__ == '__main__':
    sys.exit(main())
