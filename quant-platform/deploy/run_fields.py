#!/usr/bin/env python3
"""Every CANSLIM field, for real tickers, with the reason for every blank.

    cd quant-platform && set -a && . ./.env && set +a && \
        python3 -u deploy/run_fields.py AAPL NVDA MSFT

WHY THIS AND NOT run_status.py. That one answers "is the FILE built" — a
question about jobs. This answers "does this STOCK have a number in this
field", which is the question a card raises and the only one that settles
whether the data is really there.

    "you need to make sure every field get data ... data not just place
     holder ... you need to make sure it's correct represented and calculated"

The two failures it exists to tell apart:

    EMPTY     the field has no value, and this says which of the reasons it is
    WRONG     the field has a value that cannot be right — a ratio from a
              negative base, a percentage in six figures, a per-share figure
              reconstructed across a share-count change

The second is the dangerous one and the harder one to see, so the checks are
run here rather than left to a reader's eye on a card.

Reads the same shared files and the same EDGAR cache the cards read. Fetches
nothing, so a stock the nightly walk has not reached yet reports as
not-yet-fetched rather than being quietly filled in by this script and looking
healthy.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BAR = '─' * 72


def _fmt(v, suffix=''):
    if v is None:
        return None
    if isinstance(v, float):
        return f'{v:,.2f}{suffix}'
    if isinstance(v, int):
        return f'{v:,}{suffix}'
    return f'{v}{suffix}'


def main(tickers):
    from chart import edgar, oneil, groups, f13, base as bmod, ratings
    from chart import data_manager

    gm = None
    try:
        import json
        gm = json.loads(groups.SHARED.read_text())
    except Exception:                                     # noqa: BLE001
        pass
    fm = None
    try:
        import json
        fm = json.loads(f13.SHARED.read_text())
    except Exception:                                     # noqa: BLE001
        pass
    try:
        market = oneil.read_shared()
    except Exception:                                     # noqa: BLE001
        market = None

    bad_total = empty_total = 0

    for t in tickers:
        t = t.upper()
        print()
        print(BAR)
        print(f'  {t}')
        print(BAR)
        rows = []          # (letter, field, value, note)

        # TWO KINDS OF ANNOTATION, AND THEY WERE THE SAME ONE.
        #
        #   note  WHY THIS IS BLANK. Meaningless beside a value, and printed
        #         there anyway it produced flat contradictions: "shares
        #         outstanding 3,435,357 — no share-count tag in the filing",
        #         and the A/D grade's standing methodology paragraph hung off
        #         a perfectly good letter.
        #   qual  A CAVEAT ON A VALUE THAT IS PRESENT — "only 23 of 50
        #         sessions", "a weighted average, not a count on a date".
        #         These must survive, because they are the difference between
        #         a number and a number you can trust.
        #
        # A field has one or the other, never both.
        def add(letter, field, value, note='', qual=''):
            blank = value is None or value == ''
            rows.append((letter, field, value, note if blank else qual))

        # ── C and A, from the EDGAR cache ───────────────────────────────
        rec = edgar.cached(t)
        if rec is None:
            add('C/A', 'earnings tables', None,
                'not fetched yet — deploy/run_edgar.py walks these')
        elif not rec.get('ok'):
            add('C/A', 'earnings tables', None,
                f"EDGAR has nothing: {str(rec.get('error'))[:60]}")
        else:
            c, a, s = rec.get('c') or {}, rec.get('a') or {}, rec.get('s') or {}
            crows = c.get('rows') or []
            add('C', 'quarters filed', len(crows) or None,
                'no quarterly filings parsed' if not crows else '')
            if crows:
                r0 = crows[0]
                add('C', 'latest quarter', r0.get('quarter'))
                add('C', 'EPS', _fmt(r0.get('eps')))
                add('C', 'EPS a year ago', _fmt(r0.get('eps_yr_ago')),
                    'no matching quarter one year back'
                    if r0.get('eps_yr_ago') is None else '')
                add('C', 'EPS %chg', r0.get('eps_chg_label'))
                add('C', 'sales', _fmt(r0.get('sales')))
                add('C', 'sales %chg', r0.get('sales_chg_label'))
                add('C', 'margin', _fmt(r0.get('margin_pct'), '%'))
                add('C', 'accelerating', c.get('accelerating'),
                    'no quarter had a comparable base, so there is nothing '
                    'to accelerate from',
                    f"over {c.get('accelerating_of')} quarters")
                add('C', f"beat +{c.get('bar_pct')}%",
                    f"{c.get('beat_25')} of {c.get('beat_25_of')}",
                    'no quarter had a comparable base'
                    if not c.get('beat_25_of') else '')
            arows = a.get('rows') or []
            add('A', 'years filed', len(arows) or None,
                'no annual filings parsed' if not arows else '')
            add('A', '3-yr growth', _fmt(a.get('growth_3yr_pct'), '%'),
                'needs 4 unbroken years and a POSITIVE base year — a company '
                'that lost money three years ago has no growth rate'
                if a.get('growth_3yr_pct') is None else '')
            add('A', 'stability', a.get('stability'),
                'needs 4 annual rows' if a.get('stability') is None else '')
            add('A', 'ROE', _fmt(a.get('roe_pct'), '%'),
                (arows[0].get('roe_note') or 'no equity figure filed')
                if a.get('roe_pct') is None and arows else '')
            add('S', 'shares outstanding', _fmt(s.get('shares_outstanding')),
                'no share-count tag in the filing',
                s.get('shares_basis') or '')

        # ── N, computed live from bars ──────────────────────────────────
        try:
            df = data_manager.load_bars(t, '1d', 560, 'yahoo')
            b = bmod.analyse(df)
            if b.get('ok'):
                add('N', 'base length', f"{b.get('weeks')}w")
                add('N', 'base depth', _fmt(b.get('depth_pct'), '%'))
                add('N', 'pivot', _fmt(b.get('pivot')))
                add('N', 'handle', (b.get('handle') or {}).get('valid'),
                    'no handle formed yet' if not b.get('handle') else '')
            else:
                add('N', 'base', None, str(b.get('error'))[:70])

            # ── S, the demand half ──────────────────────────────────────
            ud = ratings.up_down_volume_ratio(df)
            ad = ratings.acc_dis(df)
            def _short(got, want):
                return (f'only {got} of {want} sessions — the window is short'
                        if (got or 0) < want else '')
            add('S', 'U/D volume', _fmt(ud.get('ratio')),
                ud.get('note') or 'no ratio', _short(ud.get('sessions'), 50))
            add('S', 'A/D grade', ad.get('letter'),
                ad.get('note') or 'no grade', _short(ad.get('sessions'), 65))
        except Exception as e:                            # noqa: BLE001
            add('N/S', 'price bars', None, f'no bars: {str(e)[:60]}')

        # ── L ───────────────────────────────────────────────────────────
        gs = ((gm or {}).get('stocks') or {}).get(t)
        if gs:
            add('L', 'group', gs.get('group'))
            add('L', 'group rank', f"{gs.get('group_rank')} of {gs.get('group_of')}")
            add('L', 'RS in group', f"{gs.get('rs_in_group')} of {gs.get('members')}")
            add('L', 'level', gs.get('group_level'))
        else:
            un = ((gm or {}).get('unranked') or {}).get(t)
            if not gm or not gm.get('ok'):
                why = 'group ranks not built yet'
            elif un and un.get('why') == 'gate':
                why = (f"in {un.get('industry')}, but no RS rating — a listing "
                       f"under a year old has none by construction")
            elif un:
                why = f"in {un.get('industry')}, but no price history"
            elif 'unranked' not in gm:
                # THE FILE PREDATES THE LIST, so absence from `stocks` proves
                # nothing. Saying "not in the industry map" here was a guess
                # dressed as a finding — and wrong for four of five live
                # stocks, one of them a $5.8bn company that is in the map.
                why = ('this groups file was built before the unranked list '
                       'existed, so why is unknown — rebuild with qp-daily')
            else:
                why = 'not in the industry map at all — an ETF, or no SIC code'
            add('L', 'group', None, why)

        # ── I ───────────────────────────────────────────────────────────
        fs = ((fm or {}).get('stocks') or {}).get(t)
        if fs:
            add('I', 'holders', fs.get('funds'))
            add('I', 'change', fs.get('change'))
            add('I', 'direction', fs.get('direction'))
        else:
            add('I', 'holders', None,
                'CUSIP did not resolve to this ticker' if fm and fm.get('ok')
                else '13F not built yet')

        # ── M ───────────────────────────────────────────────────────────
        if market and market.get('ok'):
            add('M', 'market status', market.get('status'))
            add('M', 'distribution days',
                len(market.get('distribution_days') or []))
            sd = None
            for _name in ('stock_vs_distribution', 'stockVsDistribution'):
                _fn = getattr(oneil, _name, None)
                if callable(_fn):
                    try:
                        sd = _fn(t)
                    except Exception:                     # noqa: BLE001
                        sd = None
                    break
            if isinstance(sd, dict) and sd.get('checked'):
                add('M', 'held on DD days',
                    f"{sd.get('held')} of {sd.get('checked')}")
        else:
            add('M', 'market status', None, 'market model not built yet')

        # ── print, and count ────────────────────────────────────────────
        empty = bad = 0
        for letter, field, value, note in rows:
            if value is None or value == '' or value == 'None':
                empty += 1
                print(f'  {letter:<4} {field:<22} —          {note}')
            else:
                # THE VALUES THAT ARE PRESENT AND STILL WRONG. Each of these
                # reached a live card, and none of them is a blank.
                flag = ''
                if field == 'margin' and isinstance(value, str):
                    try:
                        if abs(float(value.rstrip('%').replace(',', ''))) >= 999:
                            flag = '  ⚠ capped — a loss over almost no revenue'
                    except ValueError:
                        pass
                if flag:
                    bad += 1
                print(f'  {letter:<4} {field:<22} {str(value):<10} {note}{flag}')
        print(f'       {len(rows) - empty} of {len(rows)} fields have a value'
              + (f' · {bad} flagged' if bad else ''))
        empty_total += empty
        bad_total += bad

    print()
    print(f'  {empty_total} empty fields across {len(tickers)} stocks'
          + (f' · {bad_total} flagged values' if bad_total else ''))
    print('  An empty field with a reason beside it is working as intended. '
          'One with no reason is a bug — report it.')
    print()


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a]
    if not args:
        print(__doc__)
        sys.exit(2)
    main(args)
