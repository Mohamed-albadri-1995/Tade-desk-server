"""The live decision, replayed minute by minute on a day's FINAL bars.

Asked 2026-09-25: "confirm that everything is identical to the backtest, and
the only reason for a mismatch is data latency."

The daily check (src/setups/dayCheck.js) compares the backtest with what live
actually did. When the two differ there are three possible reasons: the bars
live read were not the final ones (latency), the fill or the exit at the
broker (execution), or the live decision itself doing something the backtest
does not (logic). This separates the third from the other two.

It runs the LIVE path — chart/decide.decide, fill='live', every minute of the
window, on the final bars cut at that minute — and applies the runner's own
gates in its order (src/setups/runner.js): the ranking inside decide, the
one-bar stale tolerance, the once-per-stock latch, the setup's trades-a-day
cap. The bars are the backtest's, so data cannot differ; if the picks are the
backtest's trades — same stock, same decision bar, same side, same stop — the
logic is identical on that day's real data, and everything left in the check
is data or execution.

The frames are handed in (strategy.evaluate `frame=`) rather than the fetch
patched: a check pressed during the session shares the process with live
decisions.
"""
from __future__ import annotations

import time

import pandas as pd

from chart import decide as dec
from chart import strategy as strat
from chart import data_manager as dm
import tools.compare_server as cs

_ET = 'America/New_York'
STALE_TOLERANCE_MIN = 1          # src/setups/runner.js STALE_TOLERANCE_MIN


def _mins(hhmm) -> int | None:
    try:
        h, m = str(hhmm).split(':')[:2]
        return int(h) * 60 + int(m)
    except Exception:                                  # noqa: BLE001
        return None


def _hhmm(total: int) -> str:
    return f'{total // 60:02d}:{total % 60:02d}'


def _window(strategies: list) -> tuple[int, int]:
    """Decision minutes: from the bar before the earliest entry window opens
    (a next-open fill decides one bar early) to the last window's end."""
    lo, hi = None, None
    for s in strategies:
        r = s.get('risk') or {}
        ws, we = r.get('window_start'), r.get('window_end')
        if ws is None:
            ws, we = 930, 1550
        we = we if we is not None else ws
        a = int(ws) // 100 * 60 + int(ws) % 100 - 1
        b = int(we) // 100 * 60 + int(we) % 100
        lo = a if lo is None else min(lo, a)
        hi = b if hi is None else max(hi, b)
    return lo, hi


def replay_day(strategies: list, symbols: list, date: str, *, tf: str = '1m',
               feed: str = 'yahoo', view: str = 'all', rank: dict | None = None,
               max_per_day: int = 0, ctx: dict | None = None,
               target_r: float = 2.0) -> dict:
    """The picks live would have made on `date` had it read the final bars."""
    started = time.time()
    overlays = []
    for s in strategies:
        overlays += strat.referenced_overlays(s)
    days = dm.required_days(overlays, tf, 2)
    full = {}
    for sym in symbols:
        try:
            full[sym] = cs.prepare_bars(sym, tf, days, feed, view, date)
        except Exception:                              # noqa: BLE001 — no bars, no picks
            continue
    lo, hi = _window(strategies)
    rank = rank or {}
    taken, picks, per_minute = set(), [], 0
    for m in range(lo, hi + 1):
        bar = _hhmm(m)
        frames = {}
        # Every bar up to and including the one that closes at this minute's
        # end — the frame live has when it decides on `bar`.
        upto = (pd.Timestamp(date, tz=_ET) + pd.Timedelta(minutes=m)).tz_convert('UTC')
        for sym, (bars, ts, c) in full.items():
            n = int(bars.index.searchsorted(upto, side='right')) if len(bars) else 0
            if n:
                frames[sym] = (bars.iloc[:n], ts[:n], c)
        if not frames:
            continue
        out = dec.decide(strategies, list(frames), date=date, tf=tf, feed=feed,
                         top_n=int(rank.get('top_n') or 0), metric=rank.get('metric'),
                         direction=rank.get('direction'), ctx=ctx, target_r=target_r,
                         days=2, workers=1, fill='live', view=view, frames=frames)
        per_minute += 1
        for p in out.get('picks') or []:
            at = _mins(p.get('entry_at'))
            # The runner's gates, in its order: stale, latch, the day's cap.
            if at is None or m - at > STALE_TOLERANCE_MIN or at > m:
                continue
            if p['symbol'] in taken:
                continue
            if max_per_day and len(picks) >= max_per_day:
                continue
            taken.add(p['symbol'])
            picks.append({'symbol': p['symbol'], 'side': p.get('side'),
                          'bar': p.get('entry_at'), 'decided_at': p.get('decided_at'),
                          'stop': p.get('stop'), 'entry': p.get('entry'),
                          'strategy': p.get('strategy'), 'at_minute': bar,
                          # The legs the order would be sent with — decide's
                          # exit_plan, the one the runner hands the broker.
                          'plan': p.get('exit_plan')})
    return {'picks': picks, 'minutes': per_minute, 'symbols': len(full),
            'took_ms': int((time.time() - started) * 1000)}


def compare(replay: list, trades: list) -> dict:
    """The replay's picks against the backtest's trades, at the DECISION: the
    stock, the bar it was decided on, the side and the stop. Sizing and exits
    come after and are the check's own rows."""
    def bt_bar(t):
        c = t.get('ctx') or {}
        ts = c.get('signal_ts') or (int(t['entry_ts']) - 60)
        return pd.Timestamp(int(ts), unit='s', tz='UTC').tz_convert(_ET).strftime('%H:%M')

    bt = {t['symbol']: t for t in trades}
    rp = {p['symbol']: p for p in replay}
    rows = []
    for sym in sorted(set(bt) | set(rp)):
        b, r = bt.get(sym), rp.get(sym)
        if not b or not r:
            rows.append({'symbol': sym, 'ok': False,
                         'why': ('the backtest took it, the live decision replayed on the '
                                 'same bars did not') if b else
                                ('the live decision replayed on the same bars took it, '
                                 'the backtest did not')})
            continue
        diffs = []
        if bt_bar(b) != r['bar']:
            diffs.append(f"decision bar {bt_bar(b)} vs {r['bar']}")
        if str(b.get('side')) != str(r.get('side')):
            diffs.append(f"side {b.get('side')} vs {r.get('side')}")
        bs, rs = b.get('stop'), r.get('stop')
        if bs is not None and rs is not None and abs(float(bs) - float(rs)) > 1e-6:
            diffs.append(f'stop {round(float(bs), 4)} vs {round(float(rs), 4)}')
        # THE SCALE-OUT: the legs live would send against the backtest's.
        pd_ = _plan_diff(b.get('plan'), r.get('plan'))
        if pd_:
            diffs.append(pd_)
        rows.append({'symbol': sym, 'ok': not diffs, 'why': '; '.join(diffs) or None})
    return {'identical': all(r['ok'] for r in rows), 'compared': len(rows),
            'mismatches': [r for r in rows if not r['ok']]}


def _legs_of(plan):
    if not plan:
        return None
    return ([(round(float(l.get('fraction') or 0), 6),
              None if l.get('price') is None else round(float(l['price']), 4))
             for l in (plan.get('legs') or [])],
            round(float(plan.get('runner') or 0), 6))


def _plan_diff(bt_plan, live_plan):
    """'' when the two scale-out plans are the same legs at the same prices."""
    a, b = _legs_of(bt_plan), _legs_of(live_plan)
    if a is None or b is None:
        return '' if a == b else 'one side has no exit plan'
    if a == b:
        return ''
    return f'scale-out {a} vs {b}'


def _minute_of(ts_s) -> str:
    return pd.Timestamp(int(ts_s), unit='s', tz='UTC').tz_convert(_ET).strftime('%H:%M')


def replay_exits(trades: list, strategies: list, date: str, *, tf: str = '1m',
                 feed: str = 'yahoo', view: str = 'all', fill: str = 'live') -> dict:
    """The live MANAGER, asked every minute on the final bars, for each of the
    backtest's trades — exactly as the desk asks it (src/setups/manager.js):
    the setup's fill, the bar the trade was decided on, the stop it was sent
    with. It must bank each target leg on the bar the backtest banked it, and
    call the rest closed on the bar the backtest closed it, for the same
    reason. A rule exit is booked at the next open, so it is decided one bar
    earlier; a 15:50 close is the flattener's, and the manager must not close
    such a trade before it.
    """
    from chart import manage as mg
    started = time.time()
    by_name = {s.get('name'): s for s in strategies}
    frames, rows, legs_compared = {}, [], 0
    for t in trades:
        if t.get('reason') == 'open' or t.get('exit_ts') is None:
            continue
        c = t.get('ctx') or {}
        st = by_name.get(c.get('strategy')) or (strategies[0] if strategies else None)
        if not st:
            continue
        sym = t['symbol']
        if sym not in frames:
            overlays = strat.referenced_overlays(st)
            days = dm.required_days(overlays, tf, 2)
            try:
                frames[sym] = cs.prepare_bars(sym, tf, days, feed, view, date)
            except Exception as e:                     # noqa: BLE001
                rows.append({'symbol': sym, 'ok': False, 'why': f'no bars: {e}'})
                continue
        bars, ts, fctx = frames[sym]
        dec = _mins(_minute_of(c.get('signal_ts') or int(t['entry_ts']) - 60))
        reason = t.get('reason')
        exit_min = _mins(_minute_of(t['exit_ts']))
        want_close = None if reason == 'eod' else (exit_min - 1 if reason == 'exit' else exit_min)
        want_legs = [_minute_of(g['exit_ts']) for g in (t.get('legs') or [])]
        last = want_close if want_close is not None else 15 * 60 + 49
        got_close, banked, err = None, {}, None
        for m in range(dec + 1, last + 1):
            upto = (pd.Timestamp(date, tz=_ET) + pd.Timedelta(minutes=m)).tz_convert('UTC')
            n = int(bars.index.searchsorted(upto, side='right'))
            if not n:
                continue
            a = mg.manage(st, sym, t.get('side') or st.get('side') or 'long', float(t['entry']),
                          f'{date} {_hhmm(dec)}', tf=tf, feed=feed, view=view, asof=date,
                          stop_at_entry=t.get('stop'), fill=fill,
                          frame=(bars.iloc[:n], ts[:n], fctx))
            if not a.get('ok'):
                err = a.get('error') or 'manage failed'
                break
            for xi in a.get('legs_banked') or []:
                if xi not in banked and xi < n:
                    banked[xi] = bars.index[xi].tz_convert(_ET).strftime('%H:%M')
            if a.get('close_now'):
                got_close = (_hhmm(m), a.get('close_reason'))
                break
        got_legs = [banked[k] for k in sorted(banked)]
        legs_compared += len(want_legs)
        diffs = []
        if err:
            diffs.append(f'the manager could not answer: {err}')
        want = None if want_close is None else (_hhmm(want_close), reason)
        if got_close != want:
            diffs.append(f"the manager closed {got_close[0] + ' (' + str(got_close[1]) + ')' if got_close else 'never'}"
                         f"; the backtest {'closes it at 15:50 (the flattener)' if want is None else want[0] + ' (' + str(want[1]) + ')'}")
        if got_legs != want_legs:
            diffs.append(f'target legs banked at {got_legs or "none"} by the manager, '
                         f'{want_legs or "none"} in the backtest')
        rows.append({'symbol': sym, 'ok': not diffs, 'why': '; '.join(diffs) or None,
                     'reason': reason, 'legs': len(want_legs)})
    return {'identical': all(r['ok'] for r in rows), 'compared': len(rows),
            'legs_compared': legs_compared,
            'mismatches': [r for r in rows if not r['ok']],
            'took_ms': int((time.time() - started) * 1000)}
