"""Why did a symbol not signal? Ask the strategy rule by rule.

    python3 chart/tests/tools_decide_debug.py LIFE 2026-08-06     (from quant-platform/)
    python3 chart/tests/tools_decide_debug.py LIFE 2026-08-06 --feed polygon

A decide() run that comes back `signalled: 0, errored: 0` is the hardest
answer to act on: the data arrived, nothing crashed, and no trade appeared.
That is either a correct "nothing qualified" or a silent mismatch somewhere in
the chain — the wrong bars, the wrong session, an entry window that never
lines up. From the outside those look identical.

So this opens the box. For one symbol on one date it prints:

  · how many bars came back, and the first and last of them
  · whether the decision minute is even present
  · each entry rule evaluated at that minute, true or false
  · what the risk block produced for the stop
  · the trades evaluate() returned, if any

The rule-by-rule part is the point. "No signal" tells you nothing; "rule 3 is
false because the close is at 41% of the morning range and the strategy wants
55" tells you whether the strategy is right, the data is wrong, or the day
simply did not qualify.

Not a unit test — it needs the network and a strategy in the store. Named
tools_ so pytest does not collect it.
"""

from __future__ import annotations

import sys
import pathlib
import json

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

import pandas as pd                                        # noqa: E402

from chart import store, strategy as strat                 # noqa: E402
import tools.compare_server as cs                          # noqa: E402

_ET = 'America/New_York'


def _strategies(prefix: str) -> list:
    got = [s for s in store.list_strategies()
           if str(s.get('name', '')).startswith(prefix)]
    if not got:
        names = [s.get('name') for s in store.list_strategies()]
        raise SystemExit(f'No strategy starting {prefix!r}. Have: {names}')
    return got


def _describe_node(node: dict) -> str:
    """A rule as a short phrase, so the truth table is readable."""
    if not isinstance(node, dict):
        return str(node)
    kind = node.get('kind')
    if kind == 'price':
        return f"price.{node.get('field')}"
    if kind == 'primitive':
        off = node.get('offset')
        p = node.get('params') or {}
        extra = f"[{off}]" if off else ''
        if p:
            extra += '(' + ','.join(f'{k}={v}' for k, v in p.items()) + ')'
        return f"{node.get('key')}{extra}"
    if kind == 'expr':
        return (f"({_describe_node(node.get('a'))} {node.get('op')} "
                f"{_describe_node(node.get('b'))})")
    if kind == 'const':
        return str(node.get('value'))
    if 'left' in node:
        return (f"{_describe_node(node['left'])} {node.get('op')} "
                f"{_describe_node(node.get('right'))}")
    return json.dumps(node)[:60]


def run(symbol: str, date: str, prefix: str, feed: str, tf: str, minute: str):
    print(f'{symbol} on {date} · feed={feed} tf={tf}\n')

    for s in _strategies(prefix):
        print('=' * 72)
        print(f"{s.get('name')}  ({s.get('side')})")
        print('=' * 72)

        # The same call decide() makes, so a difference here is a real one.
        res = strat.evaluate(s, symbol=symbol, tf=tf, days=2, feed=feed,
                             view='regular', asof=date)
        if not res.get('ok'):
            print('  evaluate failed:', res.get('error'))
            continue

        print(f"  bars: {res.get('bars')}   {res.get('first')} → {res.get('last')}")
        print(f"  entry_now={res.get('entry_now')}  trades={len(res.get('trades') or [])}"
              f"  open_trade={'yes' if res.get('open_trade') else 'no'}")

        # Is the decision minute even in the frame? A strategy whose entry
        # window is 10:00 can never fire on a day whose bars stop at 09:45,
        # and that is a data problem wearing a strategy's clothes.
        bars, ts, _ctx = cs.prepare_bars(symbol, tf, 2, feed, 'regular', date)
        if len(bars):
            et = pd.DatetimeIndex(
                pd.to_datetime(ts, unit='s', utc=True)).tz_convert(_ET)
            same_day = [t for t in et if t.strftime('%Y-%m-%d') == date]
            print(f"  bars ON {date}: {len(same_day)}"
                  + (f"  {same_day[0]:%H:%M} → {same_day[-1]:%H:%M}" if same_day else ''))
            has = any(t.strftime('%H:%M') == minute for t in same_day)
            print(f"  the {minute} bar is {'PRESENT' if has else 'MISSING'}"
                  + ('' if has else '  ← the entry window can never open'))

        # Each entry rule on its own, at the decision minute.
        entry = s.get('entry') or {}
        rules = entry.get('rules') or []
        print(f"\n  entry logic: {entry.get('logic', 'AND')} over {len(rules)} rule(s)")
        for i, node in enumerate(rules, 1):
            try:
                t = strat.test_condition(node, symbol=symbol, tf=tf, days=2,
                                         feed=feed, view='regular', asof=date)
                marks = t.get('markers') or t.get('true_bars') or []
                # Did it hold at the decision minute specifically?
                held = None
                if len(bars):
                    et = pd.DatetimeIndex(
                        pd.to_datetime(ts, unit='s', utc=True)).tz_convert(_ET)
                    want = [j for j, x in enumerate(et)
                            if x.strftime('%Y-%m-%d') == date
                            and x.strftime('%H:%M') == minute]
                    if want and isinstance(marks, list) and marks:
                        idx = {m.get('index') if isinstance(m, dict) else m
                               for m in marks}
                        held = want[0] in idx
                flag = ('TRUE ' if held else 'false') if held is not None else '  ?  '
                print(f'    {i}. [{flag}] {_describe_node(node)}')
            except Exception as e:                          # noqa: BLE001
                print(f'    {i}. [error] {_describe_node(node)} → {e}')

        for t in (res.get('trades') or []):
            when = pd.Timestamp(t['entry_ts'], unit='s', tz='UTC').tz_convert(_ET)
            print(f"\n  TRADE {when:%Y-%m-%d %H:%M} entry={t['entry']} "
                  f"stop={t.get('stop')} exit={t.get('exit')} ({t.get('reason')})")
        print()


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = sys.argv[1:]
    symbol = (args[0] if args else 'LIFE').upper()
    date = args[1] if len(args) > 1 else '2026-08-06'
    feed = opts[opts.index('--feed') + 1] if '--feed' in opts else 'yahoo'
    tf = opts[opts.index('--tf') + 1] if '--tf' in opts else '1m'
    minute = opts[opts.index('--minute') + 1] if '--minute' in opts else '10:00'
    prefix = opts[opts.index('--strategy') + 1] if '--strategy' in opts \
        else 'T2 10:00 VWAP Extension'
    run(symbol, date, prefix, feed, tf, minute)
