"""Institutional-style backtest statistics — the numbers a professional
tearsheet reports, computed from the STORED trades of a finished run.

Why a separate module: `backtest.py::_summary` computes what the runner needs
while it runs (and must stay cheap, because it runs inside the request). This
computes what a READER needs afterwards, from rows already persisted, so it can
be extended without touching the engine and re-run on any past backtest.

Every metric here is derived from the account P&L when the run was sized
against a real balance, and from per-unit percent returns otherwise. Which one
was used is stated in the output (`basis`) rather than left to be guessed —
a profit factor computed on unit-size percentages is a different number from
one computed on dollars, and reporting them under the same name is how a
tearsheet lies.

Conventions:
  · trades are ordered by ENTRY time, the order a trader took them in
  · a "win" is P&L > 0 after fees; exactly 0 is counted as breakeven, not a win
  · ratios that need a sample this run does not have are still computed, and
    flagged in `warnings` — hiding them invites the reader to assume they were
    fine
"""
from __future__ import annotations

import math

import pandas as pd

from tools import compare_server as cs

_ET = cs._ET
_MIN_TRADES = 30          # below this, ratio estimates are noise
_MIN_SESSIONS = 20        # below this, annualising anything is meaningless
_TRADING_DAYS = 252


def _et(ts) -> pd.Timestamp | None:
    if ts is None:
        return None
    return pd.Timestamp(int(ts), unit='s', tz='UTC').tz_convert(_ET)


def _hhmm(ts) -> str:
    t = _et(ts)
    return t.strftime('%H:%M') if t is not None else '—'


def _stop_of(t: dict) -> float | None:
    """The trade's stop PRICE.

    Stored runs keep `acct_stop` in ctx. Runs recorded before that field
    existed can still be reconstructed exactly: risk-based sizing means
    `acct_risk_usd = acct_shares x |entry - stop|`, so the stop follows from
    two numbers that were always written. Reconstructing beats showing '—' on
    every historical run, and beats re-running them.
    """
    c = t.get('ctx') or {}
    if c.get('acct_stop') is not None:
        return float(c['acct_stop'])
    sh, risk = c.get('acct_shares'), c.get('acct_risk_usd')
    if sh and risk:
        per_share = float(risk) / float(sh)
        return (float(t['entry']) - per_share if t['side'] == 'long'
                else float(t['entry']) + per_share)
    return None


def _pnl_of(t: dict, basis: str) -> float | None:
    """This trade's result in the report's unit."""
    if basis == 'usd':
        v = (t.get('ctx') or {}).get('acct_pnl_usd')
        return None if v is None else float(v)
    r = t.get('ret')
    return None if r is None else float(r) * 100.0


def _streaks(vals: list) -> tuple[int, int]:
    """Longest run of wins and of losses, in trade order."""
    best_w = best_l = cur_w = cur_l = 0
    for v in vals:
        if v > 0:
            cur_w += 1; cur_l = 0
        elif v < 0:
            cur_l += 1; cur_w = 0
        else:
            cur_w = cur_l = 0
        best_w = max(best_w, cur_w); best_l = max(best_l, cur_l)
    return best_w, best_l


def _drawdown(curve: list) -> tuple[float, float, int]:
    """(depth in units, depth as % of the running peak, longest duration in
    points below the peak) over a cumulative series."""
    peak = curve[0] if curve else 0.0
    depth = pct = 0.0
    run = worst_run = 0
    for v in curve:
        if v >= peak:
            peak = v; run = 0
        else:
            run += 1; worst_run = max(worst_run, run)
        d = peak - v
        if d > depth:
            depth = d
        if peak > 0 and (d / peak) > pct:
            pct = d / peak
    return depth, pct * 100.0, worst_run


def _ratios(daily: list, ann_factor: int = _TRADING_DAYS) -> dict:
    """Sharpe / Sortino from a DAILY return series (fractions, rf = 0).

    Sortino divides by the downside deviation only, so a strategy is not
    punished for the size of its winning days — the distinction matters here
    because these setups are deliberately right-skewed (2R targets).
    """
    n = len(daily)
    if n < 2:
        return {'sharpe': None, 'sortino': None, 'daily_vol_pct': None}
    mean = sum(daily) / n
    var = sum((x - mean) ** 2 for x in daily) / (n - 1)
    sd = math.sqrt(var)
    downs = [x for x in daily if x < 0]
    dsd = math.sqrt(sum(x * x for x in downs) / len(downs)) if downs else 0.0
    k = math.sqrt(ann_factor)
    return {
        'sharpe': round(mean / sd * k, 2) if sd > 0 else None,
        'sortino': round(mean / dsd * k, 2) if dsd > 0 else None,
        'daily_vol_pct': round(sd * 100.0, 3),
    }


def compute(trades: list, summary: dict, spec: dict) -> dict:
    """The full statistics block for one finished backtest."""
    acct = (summary or {}).get('account') or None
    basis = 'usd' if acct else 'pct'
    unit = '$' if basis == 'usd' else '%'

    rows = sorted([t for t in (trades or []) if t.get('reason') != 'open'],
                  key=lambda t: (t.get('entry_ts') or 0))
    pnl = [(t, _pnl_of(t, basis)) for t in rows]
    pnl = [(t, v) for t, v in pnl if v is not None]
    vals = [v for _, v in pnl]

    out: dict = {'basis': basis, 'unit': unit, 'n_trades': len(vals),
                 'warnings': [], 'excluded_unsized': len(rows) - len(vals)}
    if not vals:
        out['warnings'].append(('no trade produced a result in this basis', None))
        return out

    wins = [v for v in vals if v > 0]
    losses = [v for v in vals if v < 0]
    flat = [v for v in vals if v == 0]
    gross_p, gross_l = sum(wins), abs(sum(losses))
    net = sum(vals)

    out.update({
        'wins': len(wins), 'losses': len(losses), 'breakeven': len(flat),
        'win_rate_pct': round(100.0 * len(wins) / len(vals), 2),
        'gross_profit': round(gross_p, 2),
        'gross_loss': round(-gross_l, 2),
        'net_profit': round(net, 2),
        # Profit factor is the single most-quoted robustness number: gross won
        # per unit lost. Undefined with no losing trade — say so instead of
        # printing infinity, which reads as a spectacular result.
        'profit_factor': (round(gross_p / gross_l, 2) if gross_l > 0 else None),
        'expectancy': round(net / len(vals), 2),
        'avg_win': round(gross_p / len(wins), 2) if wins else None,
        'avg_loss': round(-gross_l / len(losses), 2) if losses else None,
        'payoff_ratio': (round((gross_p / len(wins)) / (gross_l / len(losses)), 2)
                         if wins and losses else None),
        'largest_win': round(max(vals), 2),
        'largest_loss': round(min(vals), 2),
    })
    out['max_consec_wins'], out['max_consec_losses'] = _streaks(vals)

    # ── R-multiples: the size-independent view of the same trades ──────────
    rs = [float((t.get('ctx') or {}).get('acct_r_multiple'))
          for t, _ in pnl if (t.get('ctx') or {}).get('acct_r_multiple') is not None]
    if rs:
        out['r'] = {
            'n': len(rs), 'total': round(sum(rs), 2),
            'avg': round(sum(rs) / len(rs), 3),
            'best': round(max(rs), 2), 'worst': round(min(rs), 2),
            # the shape of the distribution, not just its mean
            'buckets': _r_buckets(rs),
        }

    # ── holding time ───────────────────────────────────────────────────────
    mins = [(int(t['exit_ts']) - int(t['entry_ts'])) / 60.0
            for t, _ in pnl if t.get('exit_ts') and t.get('entry_ts')]
    if mins:
        w_mins = [(int(t['exit_ts']) - int(t['entry_ts'])) / 60.0
                  for t, v in pnl if v > 0 and t.get('exit_ts')]
        l_mins = [(int(t['exit_ts']) - int(t['entry_ts'])) / 60.0
                  for t, v in pnl if v < 0 and t.get('exit_ts')]
        out['hold'] = {
            'avg_min': round(sum(mins) / len(mins), 1),
            'max_min': round(max(mins), 1), 'min_min': round(min(mins), 1),
            'avg_win_min': round(sum(w_mins) / len(w_mins), 1) if w_mins else None,
            'avg_loss_min': round(sum(l_mins) / len(l_mins), 1) if l_mins else None,
            'total_position_min': round(sum(mins), 1),
        }

    # ── split by side, by exit reason, by symbol, by day ───────────────────
    out['by_side'] = _group(pnl, lambda t: t['side'])
    out['by_reason'] = _group(pnl, lambda t: t.get('reason') or '—')
    out['by_symbol'] = _group(pnl, lambda t: t['symbol'])
    out['by_day'] = _group(pnl, lambda t: t['date'], keep_order=True)

    # ── equity path and risk ──────────────────────────────────────────────
    # Marked at EXIT: money is only at risk until the position closes, and a
    # curve marked at entry would show a drawdown before the loss happened.
    seq = sorted(pnl, key=lambda tv: (tv[0].get('exit_ts') or tv[0]['entry_ts']))
    start = float(acct['account_equity_start']) if acct else 0.0
    cum, curve = start, [start]
    for _, v in seq:
        cum += v
        curve.append(round(cum, 4))
    out['equity_curve'] = curve
    depth, dd_pct, dd_len = _drawdown(curve)
    out['max_dd_abs'] = round(depth, 2)
    out['max_dd_pct'] = round(dd_pct, 2)
    out['max_dd_trades'] = dd_len
    out['recovery_factor'] = (round(net / depth, 2) if depth > 0 else None)

    # ── daily returns → Sharpe / Sortino / Calmar ─────────────────────────
    # Every SESSION IN THE RANGE, not only the days that traded: flat days are
    # real days for a strategy that could have traded and did not, and dropping
    # them inflates every ratio.
    sessions = list((summary or {}).get('dates') or [])
    day_pnl = {d: e['net'] for d, e in out['by_day'].items()}
    if not sessions:
        sessions = sorted(day_pnl)
    eq = start
    daily_ret, daily_eq = [], []
    for d in sessions:
        p = day_pnl.get(d, 0.0)
        if basis == 'usd':
            daily_ret.append(p / eq if eq > 0 else 0.0)
            eq += p
        else:
            daily_ret.append(p / 100.0)
        daily_eq.append(round(eq, 2))
    out['sessions'] = len(sessions)
    out['days_traded'] = len(day_pnl)
    out['daily_equity'] = daily_eq
    out.update(_ratios(daily_ret))
    out['best_day'] = round(max(day_pnl.values()), 2) if day_pnl else None
    out['worst_day'] = round(min(day_pnl.values()), 2) if day_pnl else None
    out['winning_days'] = sum(1 for v in day_pnl.values() if v > 0)
    out['losing_days'] = sum(1 for v in day_pnl.values() if v < 0)

    # Annualised figures. Reported because a professional report reports them,
    # and flagged because over this many sessions they are extrapolation, not
    # measurement.
    if sessions and start > 0 and basis == 'usd':
        total = net / start
        yrs = len(sessions) / _TRADING_DAYS
        if yrs > 0:
            try:
                out['cagr_pct'] = round(((1.0 + total) ** (1.0 / yrs) - 1.0) * 100.0, 2)
            except (OverflowError, ValueError):
                out['cagr_pct'] = None
            if out.get('cagr_pct') is not None and dd_pct > 0:
                out['calmar'] = round(out['cagr_pct'] / dd_pct, 2)

    # ── exposure ──────────────────────────────────────────────────────────
    if mins and sessions:
        out['exposure_pct'] = round(
            100.0 * sum(mins) / (len(sessions) * 390.0), 2)   # 390 RTH minutes

    # ── sample adequacy, stated rather than implied ───────────────────────
    # (fact, why): the fact stays on screen, the reasoning folds away. Written
    # as pairs so a reader scanning for numbers is not made to read an essay,
    # while the reason a number is untrustworthy is still one tap away.
    if len(vals) < _MIN_TRADES:
        out['warnings'].append(
            (f'{len(vals)} trades — below {_MIN_TRADES}',
             'Win rate, profit factor and every ratio below carry an error bar '
             'wider than the numbers themselves. A smoke test, not evidence.'))
    if len(sessions) < _MIN_SESSIONS:
        out['warnings'].append(
            (f'{len(sessions)} sessions — Sharpe, Sortino, CAGR and Calmar are '
             f'annualised from this window',
             'Annualising 8 sessions is arithmetic, not a forecast.'))
    if out.get('excluded_unsized'):
        out['warnings'].append(
            (f"{out['excluded_unsized']} trades excluded — no result in this basis",
             'They had no stop to size from, or the account could not fund '
             'them. Excluded from every number above.'))
    if not spec.get('cost_bps'):
        out['warnings'].append(
            ('cost_bps = 0 — commissions charged, spread and slippage not',
             'On 1-minute momentum names that is optimistic.'))
    return out


def _r_buckets(rs: list) -> list:
    """R-multiple histogram. Fixed edges so two runs are comparable."""
    edges = [(-99, -1.0, '≤ -1R'), (-1.0, -0.5, '-1R…-0.5R'),
             (-0.5, 0.0, '-0.5R…0'), (0.0, 1.0, '0…1R'),
             (1.0, 2.0, '1R…2R'), (2.0, 99, '≥ 2R')]
    out = []
    for lo, hi, label in edges:
        n = sum(1 for r in rs if (lo < r <= hi) or (lo == -99 and r <= hi))
        out.append({'label': label, 'n': n,
                    'pct': round(100.0 * n / len(rs), 1) if rs else 0.0})
    return out


def _group(pnl: list, key, keep_order: bool = False) -> dict:
    """{key: {n, wins, net, avg, win_rate_pct}} — the same cut applied to
    sides, exit reasons, symbols and days so they read identically."""
    g: dict = {}
    for t, v in pnl:
        e = g.setdefault(key(t), {'n': 0, 'wins': 0, 'net': 0.0})
        e['n'] += 1
        e['net'] += v
        if v > 0:
            e['wins'] += 1
    for e in g.values():
        e['net'] = round(e['net'], 2)
        e['avg'] = round(e['net'] / e['n'], 2)
        e['win_rate_pct'] = round(100.0 * e['wins'] / e['n'], 1)
    if keep_order:
        return {k: g[k] for k in sorted(g)}
    return {k: v for k, v in sorted(g.items(), key=lambda kv: -kv[1]['net'])}


# ── the per-trade journal ─────────────────────────────────────────────────
# One row per trade with every field a trading journal is expected to carry, so
# a losing run can be audited trade by trade without opening the database.
JOURNAL_COLUMNS = [
    ('n', '#'), ('date', 'date'), ('symbol', 'symbol'), ('side', 'side'),
    ('entry_time', 'entry'), ('entry_price', 'entry $'),
    ('stop_price', 'stop $'), ('risk_per_share', 'risk/sh'),
    ('exit_time', 'exit'), ('exit_price', 'exit $'), ('exit_reason', 'why'),
    ('hold_min', 'held (min)'),
    ('shares', 'shares'), ('position_usd', 'position $'),
    ('risk_usd', 'risk $'), ('gross_usd', 'gross $'), ('fees_usd', 'fees $'),
    ('net_usd', 'net $'), ('r_multiple', 'R'), ('return_pct', 'move %'),
    ('equity_before', 'equity before'), ('equity_after', 'equity after'),
    ('open_notional_usd', 'exposure at entry $'),
    ('scale_out_legs', 'legs'),
    ('pnl_per_share', '$/share'), ('counts_toward_target', 'counts?'),
    ('rvol_day', 'rvol'), ('reg_score', 'score'), ('reg_gap_pct', 'gap %'),
    ('reg_sector', 'sector'), ('source', 'tool'), ('note', 'note'),
]


def prop_firm_detail(trades: list, summary: dict) -> dict | None:
    """WHICH trades the prop-firm min-profit rule actually cost, by name.

    The TTP block reports "1 win below $0.10/share wasted" and stops there,
    which leaves the reader to work out which trade it was — on a low-priced
    stock a healthy-looking +2.7% can be five cents a share. Named here, with
    the per-share number that decided it, so the rule can be argued with.

    The per-share figure is the trade's AVERAGE across every fill, matching
    `backtest._ttp_block`: a scale-out is one position and the rule is tested
    on the position, not on each leg.
    """
    ttp = (summary or {}).get('ttp')
    if not ttp:
        return None
    from chart.backtest import _fills
    shares = float(ttp.get('shares') or 100)
    mps = float(ttp.get('min_profit_ps') or 0)
    rows = []
    for t in trades or []:
        fills = _fills(t, t.get('reason') != 'open')
        realized = sum(fr for fr, _ in fills)
        if realized <= 1e-9:
            continue
        gross_ps = sum(fr * pps for fr, pps in fills) / realized
        rows.append({
            'date': t.get('date'), 'symbol': t.get('symbol'),
            'side': t.get('side'), 'entry': t.get('entry'),
            'per_share': round(gross_ps, 4),
            'wasted': 0 < gross_ps < mps,
        })
    wasted = [r for r in rows if r['wasted']]
    return {
        'shares': shares, 'min_profit_ps': mps,
        'net_pnl_usd': ttp.get('net_pnl_usd'),
        'counted_pnl_usd': ttp.get('counted_pnl_usd'),
        'fees_usd': ttp.get('fees_usd'),
        'wasted': wasted,
        'wasted_credit_lost': round(
            (ttp.get('net_pnl_usd') or 0) - (ttp.get('counted_pnl_usd') or 0), 2),
        # Stated because its absence is invisible: the tool models the fee
        # schedule and the min-profit rule. It does NOT model any minimum
        # HOLDING TIME. If the firm requires one, these results assume it away.
        'not_modelled': ['minimum holding time (no such rule is applied)',
                         'daily loss limit / trailing drawdown',
                         'spread and slippage unless cost bps is set'],
    }


def journal(trades: list, summary: dict) -> list:
    """The journal rows, in the order the trades were taken."""
    acct = (summary or {}).get('account') or {}
    fps = float(acct.get('fee_per_share') or 0)
    fmin = float(acct.get('fee_min_per_order') or 0)
    rows = sorted(trades or [], key=lambda t: (t.get('entry_ts') or 0))
    out = []
    for i, t in enumerate(rows, 1):
        c = t.get('ctx') or {}
        stop = _stop_of(t)
        sh = c.get('acct_shares')
        net = c.get('acct_pnl_usd')
        fee = c.get('acct_fees_usd')
        gross = (round(net + fee, 2) if (net is not None and fee is not None) else None)
        eq_b = c.get('acct_equity_before')
        eq_a = (round(eq_b + net, 2) if (eq_b is not None and net is not None) else None)
        hold = ((int(t['exit_ts']) - int(t['entry_ts'])) / 60.0
                if t.get('exit_ts') and t.get('entry_ts') else None)
        per_share = (abs(float(t['entry']) - stop) if stop is not None else None)
        out.append({
            'n': i, 'date': t.get('date'), 'symbol': t.get('symbol'),
            'side': t.get('side'),
            'entry_time': _hhmm(t.get('entry_ts')),
            'entry_price': round(float(t['entry']), 4),
            'stop_price': (round(stop, 4) if stop is not None else None),
            'risk_per_share': (round(per_share, 4) if per_share is not None else None),
            'exit_time': _hhmm(t.get('exit_ts')),
            'exit_price': (round(float(t['exit']), 4) if t.get('exit') is not None else None),
            'exit_reason': t.get('reason'),
            'hold_min': (round(hold, 1) if hold is not None else None),
            'shares': (round(float(sh), 2) if sh is not None else None),
            'position_usd': c.get('acct_notional_usd'),
            'risk_usd': c.get('acct_risk_usd'),
            'gross_usd': gross, 'fees_usd': fee, 'net_usd': net,
            'r_multiple': c.get('acct_r_multiple'),
            # The prop-firm minimum is per SHARE, so this is the number that
            # decides whether the profit counts — and it is invisible in a
            # percent column: +2.70% on a $1.93 stock is five cents.
            'pnl_per_share': c.get('acct_pnl_per_share'),
            'counts_toward_target': ('NO — under the minimum'
                                     if c.get('acct_no_credit') else 'yes'),
            'return_pct': (round(float(t['ret']) * 100.0, 3)
                           if t.get('ret') is not None else None),
            'equity_before': eq_b, 'equity_after': eq_a,
            'open_notional_usd': c.get('acct_open_notional_usd'),
            'scale_out_legs': len(t.get('legs') or []) or None,
            'rvol_day': c.get('rvol_day'),
            'reg_score': c.get('score'), 'reg_gap_pct': c.get('gap_pct'),
            'reg_sector': c.get('sector') or c.get('sec'),
            'source': c.get('source_name') or c.get('source'),
            'note': c.get('acct_note'),
            '_fee_rule': (f'${fps}/share, min ${fmin}/order' if (fps or fmin) else 'none'),
        })
    return out
