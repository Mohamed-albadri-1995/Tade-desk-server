"""Audit the 09:35 backtests you actually ran: what did they really do?

    cd ~/Tade-desk-server/quant-platform
    python3 tools/audit_0935.py              # the 3 newest runs of 09:35
    python3 tools/audit_0935.py --bt 412     # one run
    python3 tools/audit_0935.py --name "Test"   # another strategy, same checks

Read-only. It opens qp's own database and, for each run:

  1. THE STRATEGY THAT RAN — from the frozen copy the run kept, not from what
     the strategy is today: its targets, whether its exit waits for a target
     (`scope: runner`), its stop.
  2. WHAT CHANGED SINCE — every rule that differs between that copy and the
     strategy as it is saved now.
  3. EVERY TRADE — did the half bank at its target, and then how did the rest
     leave? A trade that left on the exit rule with NO target banked is the
     thing the claim forbids, and is listed by symbol and date.
  4. WHERE THE MONEY CAME FROM — the target halves, the runners and the stops,
     summed separately.
  5. THE ARITHMETIC — each stored return re-added from its own prices: the
     target leg's share plus the rest at its exit, less the run's costs.

A run saved before legs were stored cannot be checked leg by leg, and says so.
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from chart import store                                             # noqa: E402
from chart import parity                                            # noqa: E402


def _docs_matching(spec, name):
    out = []
    for d in spec.get('_strategy_docs') or []:
        if isinstance(d, dict) and name.lower() in str(d.get('name', '')).lower():
            out.append(d)
    return out


def runs_for(name, limit=3):
    """Newest finished runs that kept a copy of a strategy called `name`."""
    with store._lock:
        rows = store._db().execute(
            "SELECT id, spec FROM backtests WHERE status = 'done' "
            "ORDER BY id DESC LIMIT 400").fetchall()
    out = []
    for r in rows:
        try:
            spec = json.loads(r['spec'])
        except Exception:
            continue
        if _docs_matching(spec, name):
            out.append(r['id'])
        if len(out) >= limit:
            break
    return out


def shape(doc):
    """The exit, in words, from the document itself."""
    risk = doc.get('risk') or {}
    tg = risk.get('targets') or []
    ex = doc.get('exit') or {}
    sl = risk.get('sl') or {}
    return {
        'name': doc.get('name'),
        'targets': [f"{t.get('fraction')} at {t.get('r_multiple')}R" if t.get('r_multiple')
                    else f"{t.get('fraction')} at {t.get('tp')}" for t in tg],
        'exit_rule': bool(ex.get('rules')),
        'exit_scope': ex.get('scope') or 'whole position',
        'stop': f"{sl.get('type')}{' frozen' if sl.get('freeze') else ' moving'}",
        'min_target_usd': risk.get('min_target_usd'),
    }


def audit(bt_id, name):
    bt = store.get_backtest(bt_id, with_trades=True)
    if not bt:
        return {'ok': False, 'error': f'no backtest #{bt_id}'}
    spec = bt['spec'] or {}
    docs = _docs_matching(spec, name)
    ids = {d.get('id') for d in docs}
    names = {d.get('name') for d in docs}
    cost = float(spec.get('cost_bps', 0) or 0) / 10000.0

    current = [s for s in (store.get_strategy(int(i)) for i in ids if i is not None) if s]
    changed = parity.rules_diff(spec, current)

    g = {'trades': 0, 'open': 0, 'no_legs_stored': 0, 'banked': 0,
         'banked_then_rule': 0, 'banked_then_stop': 0, 'banked_then_other': 0,
         'stop_before_target': 0, 'rule_without_target': 0, 'eod_before_target': 0,
         'other': 0}
    money = {'target halves': 0.0, 'runners after target': 0.0,
             'stopped before target': 0.0, 'other': 0.0}
    bad_rule, bad_ret = [], []
    for t in bt.get('trades') or []:
        if t.get('side') and docs and not any(
                (d.get('side') or 'long') == t['side'] for d in docs):
            continue
        # A run can carry other strategies; keep only this one's trades when
        # the row names it.
        sname = (t.get('ctx') or {}).get('strategy') or (t.get('ctx') or {}).get('strategy_name')
        if sname and names and sname not in names:
            continue
        if t.get('exit_ts') is None or t.get('reason') == 'open':
            g['open'] += 1
            continue
        g['trades'] += 1
        legs = t.get('legs') or (t.get('ctx') or {}).get('legs')
        reason = t.get('reason')
        entry, exitp, ret = t.get('entry'), t.get('exit'), t.get('ret')
        sgn = 1 if t.get('side') == 'long' else -1
        legs = legs or []
        leg_part = sum(float(x['fraction']) * sgn * (float(x['price']) / entry - 1) for x in legs)
        rest = 1 - sum(float(x['fraction']) for x in legs)
        rest_part = rest * sgn * (exitp / entry - 1) if exitp else 0.0
        # Only a trade that ended on its LAST target has no "rest".
        if reason and reason.startswith('T') and rest <= 1e-9:
            rest_part = 0.0
        gross = leg_part + rest_part
        if ret is not None and abs((gross - 2 * cost) - ret) > 1e-6:
            bad_ret.append((t['date'], t['symbol'], round(ret, 6), round(gross - 2 * cost, 6)))
        if legs:
            g['banked'] += 1
            money['target halves'] += leg_part
            money['runners after target'] += rest_part
            if reason == 'exit':
                g['banked_then_rule'] += 1
            elif reason in ('SL', 'trail'):
                g['banked_then_stop'] += 1
            else:
                g['banked_then_other'] += 1
        else:
            if reason in ('SL', 'trail'):
                g['stop_before_target'] += 1
                money['stopped before target'] += gross
            elif reason == 'exit':
                g['rule_without_target'] += 1
                money['other'] += gross
                bad_rule.append((t['date'], t['symbol'], t['side'], round(entry, 4),
                                 round(exitp, 4)))
            elif reason == 'eod':
                g['eod_before_target'] += 1
                money['other'] += gross
            else:
                g['other'] += 1
                money['other'] += gross
    # A run saved before the legs were stored has NO trade with a leg, however
    # many reached their target — and then every rule exit reads as "no
    # target", which would be a false alarm. Said instead of counted.
    if g['trades'] >= 10 and not g['banked'] and any(
            (d.get('risk') or {}).get('targets') for d in docs):
        g['no_legs_stored'] = g['trades']
    return {'ok': True, 'id': bt_id, 'name': bt.get('name'),
            'start': spec.get('start'), 'end': spec.get('end'), 'fill': spec.get('fill'),
            'cost_bps': spec.get('cost_bps', 0), 'created_at': bt.get('created_at'),
            'ran': [shape(d) for d in docs], 'changed': changed,
            'counts': g, 'money': money, 'bad_rule': bad_rule, 'bad_ret': bad_ret}


def render(a):
    if not a.get('ok'):
        return a.get('error', 'failed')
    L = []
    pct = lambda x: f'{100 * x:+.2f}%'                                # noqa: E731
    L.append(f"Backtest #{a['id']}  {a['name']}")
    L.append(f"  period {a['start']} → {a['end']} · fill {a['fill']} · costs {a['cost_bps']} bps/side")
    L.append('  STRATEGY IT RAN (the frozen copy):')
    for s in a['ran']:
        L.append(f"    {s['name']}: targets {', '.join(s['targets']) or 'none'} · "
                 f"exit rule {'yes' if s['exit_rule'] else 'no'}, applies to {s['exit_scope']} · "
                 f"stop {s['stop']} · skips a target under ${s['min_target_usd']}")
    L.append('  CHANGED SINCE THIS RUN:')
    for r in a['changed']:
        if not r['frozen']:
            L.append(f"    {r['name']}: cannot tell — {r.get('note')}")
        elif not r['changed']:
            L.append(f"    {r['name']}: nothing — this run is the strategy as it is now")
        else:
            for c in r['changed']:
                L.append(f"    {r['name']}: {c['path']}  was {c['then']}  now {c['now']}")
    c = a['counts']
    n = c['trades'] or 1
    L.append(f"  TRADES: {c['trades']} closed, {c['open']} still open at the end")
    L.append(f"    target half banked         {c['banked']:5d}  ({100 * c['banked'] / n:.0f}%)")
    L.append(f"      then rest left on rule   {c['banked_then_rule']:5d}")
    L.append(f"      then rest hit the stop   {c['banked_then_stop']:5d}")
    L.append(f"      then other (eod/target)  {c['banked_then_other']:5d}")
    L.append(f"    stopped before the target  {c['stop_before_target']:5d}")
    L.append(f"    eod before the target      {c['eod_before_target']:5d}")
    L.append(f"    RULE EXIT WITH NO TARGET   {c['rule_without_target']:5d}   ← should be 0 for a 'runner' exit")
    if c['no_legs_stored']:
        L.append('    !! NO trade in this run has a target leg recorded. Either it was saved '
                 'before legs were stored (then the split cannot be checked and the '
                 'line above is not a fault) or no trade ever reached its target.')
    if a['bad_rule']:
        L.append('      The engine allows this in ONE case: the fill had already gapped past '
                 'the target, so no target order could exist and the rule manages the '
                 'whole position. Anything else is a fault — check each on a chart:')
    for b in a['bad_rule'][:8]:
        L.append(f"      check on a chart: {b[0]} {b[1]} {b[2]} entry {b[3]} exit {b[4]}")
    m = a['money']
    L.append('  WHERE THE RETURN CAME FROM (sum of per-trade %, before costs):')
    for k, v in m.items():
        L.append(f"    {k:24s} {pct(v)}")
    L.append(f"  ARITHMETIC: {c['trades'] - len(a['bad_ret'])}/{c['trades']} returns = "
             'target leg + rest at exit − costs')
    for b in a['bad_ret'][:5]:
        L.append(f"      differs: {b[0]} {b[1]} stored {b[2]} recomputed {b[3]}")
    return '\n'.join(L)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--bt', type=int)
    ap.add_argument('--name', default='09:35')
    ap.add_argument('--runs', type=int, default=3)
    a = ap.parse_args(argv)
    ids = [a.bt] if a.bt else runs_for(a.name, a.runs)
    if not ids:
        print(f'No finished backtest kept a copy of a strategy named like "{a.name}".')
        return 1
    for i in ids:
        print(render(audit(i, a.name)))
        print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
