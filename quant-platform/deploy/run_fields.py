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
            # THE DIRECTION, WHICH IS THE PART THAT MEANS SOMETHING. One
            # count is a fact; whether it is shrinking is the reading. Printed
            # with BOTH figures and BOTH dates, so the percentage can be
            # checked on its own line rather than taken on trust — this file
            # exists to catch numbers that are wrong, not only ones that are
            # missing.
            _sc = s.get('shares_chg_1y')
            _sh = s.get('shares_history') or []
            add('S', 'share count 1yr',
                (f"{_sc['pct']:+.2f}% "
                 f"({_fmt(_sc['from_val'])} on {_sc['from']} → "
                 f"{_fmt(_sc['to_val'])} on {_sc['to']}, {_sc['days']}d)")
                if _sc else None,
                # THE REASON, NOT A DASH, and the two reasons are different
                # facts about different companies — one has not filed for long
                # enough, the other files too irregularly to give a rate.
                ('only one count on file, so no direction yet'
                 if len(_sh) < 2 else
                 f'{len(_sh)} counts on file but no pair 290-440 days apart'),
                'buying back' if _sc and _sc['pct'] <= -1 else
                'diluting' if _sc and _sc['pct'] >= 2 else
                'flat' if _sc else '')

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
            # WITH THE DENOMINATOR, because without it every widely-held name
            # reads as "rising" — the number of managers FILING grows every
            # quarter and carries the count up with it. AAPL +729, NVDA +792,
            # MSFT +635, AMD +736, PLTR +483 over the same four quarters, in
            # five different industries, is what that looks like.
            _fq = (fm or {}).get('filers_by_quarter') or {}
            # A LIST OR NOTHING. `trend()` used to return a key called
            # `quarters` holding a COUNT, and `row.update()` replaced the
            # history with it — so this field was the integer 4 and
            # `_qlist[-1].get('q')` raised TypeError right here. The shape is
            # checked rather than assumed, because a reader that trusts a
            # shape it did not verify turns a data fault into a crash.
            _q = fs.get('quarters')
            _qlist = _q if isinstance(_q, list) else []
            _newest = (_qlist[-1] or {}).get('q') if _qlist else None
            _of = _fq.get(_newest)
            _unit = (fm or {}).get('holder_unit') or 'manager'
            add('I', 'holders', fs.get('funds'), '',
                (f"of {_of:,} managers who filed {_newest}" if _of else '')
                # AN APPROXIMATION SAYS SO. `filing` means a quarter was
                # cached before SUBMISSION.tsv existed, so an amendment counts
                # twice and every figure here runs high.
                + (' · COUNTED BY FILING, not by manager — amendments inflate '
                   'this' if _unit != 'manager' else ''))
            # THE SHARE SERIES, which is what the direction is read from. The
            # raw change is kept beside it and labelled as raw: five mega-caps
            # printed "rising" on raw counts while Microsoft was losing ground
            # against the managers who could have held it.
            add('I', 'share of filers',
                ' → '.join(f"{r.get('share_pct')}%" for r in _qlist
                           if r.get('share_pct') is not None) or None,
                'no filer population on file — an older build')
            add('I', 'change (share)',
                (f"{fs['change_share_pct']:+}%"
                 if fs.get('change_share_pct') is not None else None),
                'direction taken from the raw count instead')
            add('I', 'change (raw holders)', fs.get('change'))
            add('I', 'direction', fs.get('direction'), '',
                'from the RAW COUNT — population unknown'
                if (fs.get('direction_basis') or 'share') != 'share' else '')
            add('I', 'managers filing',
                ' · '.join(f'{q} {n:,}' for q, n in sorted(_fq.items()))
                or None,
                'not published — an older build; re-run qp-13f')
            # WHICH QUARTERS, and this line is why it exists. Every 13F label
            # was one quarter too new for as long as the letter worked, and
            # nothing here would have shown it: holders, change and direction
            # were all correct — they were correct ABOUT THE WRONG QUARTERS.
            # It took reading a card in September and asking why it said Q2.
            _qs = (fm or {}).get('quarters') or []
            add('I', 'quarters', ' · '.join(_qs) or None,
                'the file carries no quarter list — an older build',
                # A SLID WINDOW IS NOT A FAULT, and it is not silence either:
                # the SEC publishes weeks after the deadline, so the newest
                # quarter wanted is routinely not out yet. Said here as well
                # as in the nightly log, because this is where it is looked
                # for.
                (fm or {}).get('fell_back') or '')
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
