"""Which ranking metric is right for THIS strategy — measured, not chosen.

WHY THIS EXISTS.

Extension from VWAP is the right ranking for T2, whose stop IS session VWAP:
the further price has run from it, the more the setup has to work with. For the
09:35 opening-range strategy the same number may well have the opposite sign —
more volume is in the tape by then, and a name that extended while VWAP failed
to follow is a name that reverts. Nobody can settle that by reasoning about it,
and the previous answer — assume T2's metric everywhere — was settling it by
accident.

THE EXPERIMENT.

One backtest, run with NO ranking, so every signal the strategy produced is in
the sample. Then each candidate ranking is applied to that SAME set of trades.
Same universe, same entries, same exits; the only thing that varies is which
of each day's signals you would have taken.

That matters more than it sounds. Running a separate backtest per metric would
also re-fetch bars, re-evaluate rules and re-resolve fills, and any difference
in those would land in the comparison as if it were a difference in ranking.
Here the trades are identical objects — only the selection differs — so a gap
between two rows can only come from the ranking.

WHAT IT WILL NOT DO.

It will not tell you a winner when the sample cannot support one. Two picks a
day over four weeks is eighty trades split across five metrics, and win rates
from sixteen trades wander by ten points on noise alone. Every row carries its
standard error, and the verdict is explicit about whether the best row is
outside the baseline's — usually it is not, and saying so is the entire value.

    python3 -m chart.rank_sweep --backtest 231 --top-n 2
    python3 -m chart.rank_sweep --trades trades.json --top-n 2
"""

from __future__ import annotations

import json
import math

from chart.backtest import RANK_METRICS, select_by_rank

# Two of the metrics are ONE number under two names: tight_stop is
# vwap_extension ascending, which the platform declares in as many words. Both
# directions of both would put the same ordering in the table twice — and it
# showed up immediately, as "tight_stop (desc)" and "vwap_extension (desc)"
# tying to three decimal places and the verdict naming whichever sorted first.
#
# That is not cosmetic. Every duplicate raises the multiple-comparison bar for
# no information, and a table where two rows are secretly the same row invites
# reading agreement between them as corroboration.
ALIAS_OF = {'tight_stop': 'vwap_extension'}


def variants() -> list:
    """Each DISTINCT ordering once, under the name whose default it is.

    Two passes, and the order matters. Claiming defaults first is what makes
    the ascending ordering come out as `tight_stop` rather than as
    `vwap_extension (asc)` — the platform named it tight_stop precisely so the
    setup it suits can be talked about, and a single alphabetical pass gave
    tight_stop both directions and vwap_extension none.
    """
    seen = set()
    out = []
    for name, (_score, default_dir) in sorted(RANK_METRICS.items()):
        key = (ALIAS_OF.get(name, name), default_dir)
        if key in seen:
            continue
        seen.add(key)
        out.append((name, default_dir))

    for name, (_score, default_dir) in sorted(RANK_METRICS.items()):
        other = 'asc' if default_dir == 'desc' else 'desc'
        key = (ALIAS_OF.get(name, name), other)
        if key in seen:
            continue
        seen.add(key)
        out.append((name, other))
    return out


def _r_multiple(t: dict):
    """The trade's return in units of its own initial risk.

    Percent returns cannot be compared across trades whose stops are different
    distances away — a 1% gain on a 0.3% stop and a 1% gain on a 3% stop are
    three R and a third of an R. R is the only unit in which "did ranking help"
    is a meaningful question.
    """
    try:
        entry = float(t['entry'])
        stop = float(t.get('stop') or (t.get('ctx') or {}).get('stop') or 0.0)
        ret = float(t['ret'])
    except (TypeError, ValueError, KeyError):
        return None
    if not entry or not stop:
        return None
    risk_fraction = abs(entry - stop) / entry
    if risk_fraction <= 0:
        return None
    return ret / risk_fraction


def stats(trades: list) -> dict:
    """Descriptive only. Nothing here decides anything; it reports."""
    rs = [r for r in (_r_multiple(t) for t in trades) if r is not None]
    n = len(rs)
    days = len({t.get('date') for t in trades})
    if not n:
        return {'trades': len(trades), 'days': days, 'scorable': 0,
                'win_rate': None, 'expectancy_r': None, 'total_r': None,
                'se_win_rate': None, 'se_expectancy_r': None}

    wins = sum(1 for r in rs if r > 0)
    mean = sum(rs) / n
    var = sum((r - mean) ** 2 for r in rs) / (n - 1) if n > 1 else 0.0
    p = wins / n
    return {
        'trades': len(trades),
        'days': days,
        'scorable': n,
        'win_rate': round(100.0 * p, 1),
        'expectancy_r': round(mean, 3),
        'total_r': round(sum(rs), 2),
        # The honest half of every number above it. A win rate from sixteen
        # trades has a standard error near twelve points; without that beside
        # it, "62% vs 55%" reads as a finding.
        'se_win_rate': round(100.0 * math.sqrt(p * (1 - p) / n), 1),
        'se_expectancy_r': round(math.sqrt(var / n), 3) if n > 1 else None,
    }


def sweep(closed: list, top_n: int = 2) -> dict:
    """Every ranking applied to one set of trades, against the no-rank baseline.

    `closed` must come from a run with NO rank_per_day, or the sample is
    already a subset chosen by whichever metric that run used — and every row
    below would be a ranking of a ranking.
    """
    baseline = stats(closed)
    baseline['label'] = 'no ranking — every signal'

    rows = []
    for metric, direction in variants():
        # Deep-ish copy: select_by_rank writes rank_metric into ctx, and two
        # variants must not read each other's leftovers.
        trades = [dict(t, ctx=dict(t.get('ctx') or {})) for t in closed]
        try:
            kept, info = select_by_rank(trades, metric, direction, top_n)
        except ValueError as e:
            rows.append({'label': f'{metric} ({direction})', 'error': str(e)})
            continue
        row = stats(kept)
        row.update({'label': f'{metric} ({direction})',
                    'metric': metric, 'direction': direction,
                    'dropped_by_rank': info['dropped_by_rank'],
                    'dropped_unscorable': info['dropped_unscorable']})
        rows.append(row)

    rows.sort(key=lambda r: (r.get('expectancy_r') is None,
                             -(r.get('expectancy_r') or 0)))
    return {'top_n': top_n, 'baseline': baseline, 'rows': rows,
            'verdict': verdict(baseline, rows)}


def _z(p: float) -> float:
    """Inverse normal CDF, Acklam's rational approximation. No scipy on the box.

    Accurate to ~1e-9 over the range that matters here, which is far more than
    a verdict about eighty trades needs.
    """
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    pl, ph = 0.02425, 1 - 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > ph:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def threshold_z(n_variants: int, alpha: float = 0.05) -> float:
    """How far past the standard error a gap must be, given how many were tried.

    THE CORRECTION THAT MAKES THIS HONEST. Seven orderings are compared and the
    best is reported, so the best one clears any fixed bar by luck far more
    often than a single pre-chosen one would. Tested against pure noise, a
    one-standard-error bar declared a winner — 0.235R "above baseline" on data
    with no signal in it whatsoever.

    Bonferroni: spend alpha across the variants actually tried. It is
    conservative and it is arithmetic rather than judgement, which is the right
    trade for a number that decides whether to believe a backtest.
    """
    n = max(1, int(n_variants))
    return _z(1 - (alpha / n) / 2.0)


# Below this many trades, no ranking claim is worth making at all. A win rate
# from thirty trades has a standard error near nine points; the orderings this
# tool compares are routinely closer together than that.
MIN_TRADES = 40


def verdict(baseline: dict, rows: list) -> dict:
    """Is the best row actually better than taking everything?

    The comparison that matters is against the BASELINE, not against the other
    metrics. A metric that beats the other metrics and not the baseline has
    discovered nothing except that ranking cost less than it might have.

    "Better" means the gap exceeds the combined standard error of the two. That
    is a deliberately low bar — one standard error, not two — and it still
    refuses most gaps this sample size can produce, which is the point.
    """
    scored = [r for r in rows if r.get('expectancy_r') is not None]
    if not scored or baseline.get('expectancy_r') is None:
        return {'call': 'no data', 'why': 'nothing scorable in the sample'}

    best = scored[0]
    gap = best['expectancy_r'] - baseline['expectancy_r']
    se_b = baseline.get('se_expectancy_r') or 0.0
    se_r = best.get('se_expectancy_r') or 0.0
    combined = math.sqrt(se_b ** 2 + se_r ** 2)
    z = threshold_z(len(scored))
    need = z * combined
    common = {'best': best['label'], 'gap_r': round(gap, 3),
              'combined_se_r': round(combined, 3),
              'needed_r': round(need, 3),
              'variants_tried': len(scored), 'z': round(z, 2)}

    if best['scorable'] < MIN_TRADES:
        return {**common, 'call': 'not enough trades',
                'why': f"the best row has {best['scorable']} trade(s), under "
                       f'{MIN_TRADES}. At this size the orderings differ by less '
                       'than the noise between them, whatever the table shows. '
                       'Collect more days.'}
    if gap <= need:
        return {**common, 'call': 'no ranking beats taking everything',
                'why': f"the best row ({best['label']}) is {round(gap, 3)}R above "
                       f'the baseline. Across {len(scored)} orderings the best of '
                       f'them has to clear {round(need, 3)}R '
                       f'({round(z, 2)}× the {round(combined, 3)}R standard error) '
                       'before it means anything — picking the winner of seven '
                       'tries is most of why it is ahead. Take every signal.'}
    return {**common, 'call': f"{best['label']}",
            'why': f"{round(gap, 3)}R per trade above taking everything, past the "
                   f'{round(need, 3)}R this many comparisons demand, over '
                   f"{best['scorable']} trades. Worth using — and worth "
                   're-running after another month, because that is the only '
                   'thing that separates a finding from a coincidence.'}


def render(out: dict) -> str:
    """The table, for a person reading it on a phone."""
    b = out['baseline']
    lines = [
        '',
        f"RANKING SWEEP — top {out['top_n']} per day",
        '=' * 74,
        f"{'selection':<26}{'trades':>7}{'win%':>7}{'±':>6}"
        f"{'exp R':>8}{'±':>7}{'total R':>9}",
        '-' * 74,
        f"{b['label']:<26}{b['trades']:>7}{_f(b['win_rate']):>7}"
        f"{_f(b['se_win_rate']):>6}{_f(b['expectancy_r']):>8}"
        f"{_f(b['se_expectancy_r']):>7}{_f(b['total_r']):>9}",
        '-' * 74,
    ]
    for r in out['rows']:
        if r.get('error'):
            lines.append(f"{r['label']:<26}  {r['error'][:44]}")
            continue
        lines.append(
            f"{r['label']:<26}{r['trades']:>7}{_f(r['win_rate']):>7}"
            f"{_f(r['se_win_rate']):>6}{_f(r['expectancy_r']):>8}"
            f"{_f(r['se_expectancy_r']):>7}{_f(r['total_r']):>9}")
    v = out['verdict']
    lines += ['=' * 74, f"VERDICT: {v['call']}", '', f"  {v['why']}", '']
    return '\n'.join(lines)


def _f(v):
    return '—' if v is None else f'{v}'


def _main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--backtest', type=int,
                    help='id of a stored backtest run with NO ranking')
    ap.add_argument('--trades', help='a JSON file of closed trades instead')
    ap.add_argument('--top-n', type=int, default=2)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)

    if a.trades:
        closed = json.load(open(a.trades))
        if isinstance(closed, dict):
            closed = closed.get('trades') or closed.get('closed') or []
    elif a.backtest:
        from chart import store
        closed = store.backtest_trades(a.backtest)
    else:
        ap.error('give --backtest or --trades')

    out = sweep(closed, top_n=a.top_n)
    print(json.dumps(out, indent=2) if a.json else render(out))
    return 0


if __name__ == '__main__':
    raise SystemExit(_main())
