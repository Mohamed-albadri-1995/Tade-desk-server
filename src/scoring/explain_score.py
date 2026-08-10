"""
explain_score.py — show, in full arithmetic, how one live stock gets its score.

Not part of the scoring path; a read-only explainer. It loads the SAME
metadata.pkl the LiveScorer uses, pulls a real card from the running screener,
and prints every number that goes into the result:

    raw value -> model average -> z-score -> x loading -> contribution
    -> factor score -> which bucket -> that bucket's real history -> score

Usage (on the box, with the screener running):
    python3 src/scoring/explain_score.py                # highest-scoring stock
    python3 src/scoring/explain_score.py SUNE           # a specific ticker
    python3 src/scoring/explain_score.py SUNE --factor 2
    python3 src/scoring/explain_score.py --base B3      # force a base table
"""

import argparse
import json
import os
import pickle
import urllib.request

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT = os.path.join(HERE, 'outputs')
SCREENER = os.environ.get('SCREENER_URL', 'http://localhost:3000')

# Mirrors sideE/score.js buildCard()
CATEGORICAL_COLS = [
    'sector', 'industry', 'regime', 'regimeLabel', 'secBias', 'themes',
    'catalyst', 'screenerKeys', 'longTerm', 'midTerm', 'shortTerm',
    'broadResolved', 'inShortlist', 'bias',
]
NUMERIC_COLS = [
    'price', 'prevClose', 'open', 'change', 'gapPct', 'vwap', 'sma5', 'ema9',
    'ema13', 'ema20', 'ema50', 'rvol', 'atr', 'adrPct', 'dayHigh', 'dayLow',
    'monthHigh', 'monthLow', 'monthRangePos', 'mcap', 'floatShares',
    'shortFloat', 'pmHigh', 'pmLow', 'pmRange', 'pmAdrRatio', 'secScore',
]


def fetch_rows():
    url = f'{SCREENER}/api/registry/today'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=8) as r:
        return json.loads(r.read().decode('utf-8')).get('rows', [])


def resolve_bias(row):
    """Mirrors sideC/bias.js resolveAutoBias -> sideE/score.js resolveCardBias."""
    set_bias = row.get('bias')
    if set_bias in ('long', 'short'):
        return ('Long' if set_bias == 'long' else 'Short'), 'set by trader'

    cat = row.get('catalyst') or {}
    ctx = row.get('context') or {}
    sentiment, tier, stale = cat.get('sentiment'), cat.get('tier'), cat.get('stale')
    if sentiment in ('bull', 'bear') and not stale:
        direction = 'Long' if sentiment == 'bull' else 'Short'
        opposed = 'BEARISH' if direction == 'Long' else 'BULLISH'
        if tier == 1:
            return direction, f"catalyst: {cat.get('label')} (major)"
        if tier == 2 and not (ctx.get('shortTerm') == opposed and ctx.get('secBias') == opposed):
            return direction, f"catalyst: {cat.get('label')} (notable)"

    short, sec, lt = ctx.get('shortTerm'), ctx.get('secBias'), ctx.get('longTerm')
    if short == 'BEARISH' and sec == 'BEARISH':   return 'Short', 'context'
    if short == 'BEARISH' and sec != 'BULLISH':   return 'Short', 'context'
    if sec == 'BEARISH' and short != 'BULLISH':   return 'Short', 'context'
    if short == 'BULLISH' or sec == 'BULLISH':    return 'Long', 'context'
    if lt == 'BEARISH':                           return 'Short', 'context'
    return 'Long', 'context (default)'


def build_card(row, bias_label):
    s, ctx = row.get('stock') or {}, row.get('context') or {}
    cat = row.get('catalyst') or {}
    themes = ctx.get('themes')
    keys = row.get('screenerKeys')
    card = {
        'sector': s.get('sector'), 'industry': s.get('industry'),
        'regime': ctx.get('regime'), 'regimeLabel': ctx.get('regimeLabel'),
        'secBias': ctx.get('secBias'),
        'themes': '+'.join(sorted(themes)) if isinstance(themes, list) else None,
        'catalyst': cat.get('label'),
        'screenerKeys': '+'.join(sorted(keys)) if isinstance(keys, list) else None,
        'longTerm': ctx.get('longTerm'), 'midTerm': ctx.get('midTerm'),
        'shortTerm': ctx.get('shortTerm'), 'broadResolved': ctx.get('broadResolved'),
        'inShortlist': 'true' if row.get('inShortlist') else 'false',
        'bias': 'long' if bias_label == 'Long' else 'short',
    }
    for c in NUMERIC_COLS:
        card[c] = ctx.get('secScore') if c == 'secScore' else s.get(c)
    return card


def select_base(bias, entry_time='9:40'):
    tgt = {'Long': 'up', 'Short': 'down'}.get(bias, 'max')
    if entry_time == '9:40':
        return {'up': 'B4', 'down': 'B5'}.get(tgt, 'B6')
    return {'up': 'B1', 'down': 'B2'}.get(tgt, 'B3')


def load_meta(path):
    with open(path, 'rb') as f:
        return pickle.load(f)


def encode(card, meta, table_type):
    """Rebuild the exact feature row the LiveScorer would build."""
    df = pd.DataFrame([card])
    if table_type == 'sub' and 'regime' in df.columns:
        df = df.drop(columns=['regime'])
    cat_present, num_present = meta['categorical_cols'], meta['numeric_cols']
    feature_names = meta['feature_names']

    X_cat = pd.get_dummies(df[[c for c in cat_present if c in df.columns]])
    X_cat = X_cat.reindex(columns=[f for f in feature_names if f not in num_present],
                          fill_value=0)

    num_in = [c for c in num_present if c in feature_names]
    raw = df[[c for c in num_present if c in df.columns]].apply(pd.to_numeric, errors='coerce').fillna(0)
    raw = raw.reindex(columns=num_in, fill_value=0)
    scaled = pd.DataFrame(meta['scaler'].transform(raw), columns=num_in)

    X = pd.concat([scaled, X_cat], axis=1).reindex(columns=feature_names, fill_value=0).fillna(0)
    return X, raw, num_in


def money(v):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return '—'
    a = abs(v)
    if a >= 1e9:  return f'{v/1e9:.2f}B'
    if a >= 1e6:  return f'{v/1e6:.2f}M'
    if a >= 1000: return f'{v:,.0f}'
    return f'{v:.4g}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ticker', nargs='?', help='Ticker to explain (default: highest score)')
    ap.add_argument('--output', default=DEFAULT_OUTPUT)
    ap.add_argument('--base', help='Force a base table (B1..B6)')
    ap.add_argument('--entry-time', default='9:40')
    ap.add_argument('--factor', type=int, default=1, help='Which factor to break down in full')
    ap.add_argument('--top', type=int, default=12, help='How many features to list')
    args = ap.parse_args()

    rows = fetch_rows()
    if not rows:
        print('No rows from the screener. Is it running, and has a scan completed?')
        return

    if args.ticker:
        row = next((r for r in rows if str(r.get('ticker', '')).upper() == args.ticker.upper()), None)
        if row is None:
            print(f"{args.ticker} not in today's rows. Have: " + ', '.join(r['ticker'] for r in rows))
            return
    else:
        row = max(rows, key=lambda r: r.get('_score') if isinstance(r.get('_score'), (int, float)) else -1)

    ticker = row['ticker']
    bias, bias_why = resolve_bias(row)
    base = args.base or select_base(bias, args.entry_time)
    card = build_card(row, bias)

    regime = card.get('regime')
    sub_path = os.path.join(args.output, base, f'sub_{regime}', 'metadata.pkl')
    main_path = os.path.join(args.output, base, 'main', 'metadata.pkl')
    if regime and os.path.exists(sub_path) and load_meta(sub_path)['total_samples'] >= 10:
        meta, table_type, folder = load_meta(sub_path), 'sub', f'sub_{regime}'
    elif os.path.exists(main_path):
        meta, table_type, folder = load_meta(main_path), 'main', 'main'
    else:
        print(f'No trained model at {main_path}')
        return

    X, raw, num_in = encode(card, meta, table_type)
    pca = meta['pca']
    k = meta['k_factors']
    feature_names = meta['feature_names']

    x = X.values[0]
    centered = x - pca.mean_
    scores = centered @ pca.components_[:k].T

    print()
    print('=' * 66)
    print(f'  {ticker}   ·   card score on screen: {row.get("_score")}')
    print('=' * 66)
    print(f'  bias      : {bias}  ({bias_why})')
    print(f'  table used: {base}/{folder}   ({meta["total_samples"]} training rows, {k} factors)')
    cat_label = (row.get('catalyst') or {}).get('label')
    print(f'  catalyst  : {cat_label or "none"}')

    j = max(1, min(args.factor, k)) - 1
    loadings = pca.components_[j]
    contrib = centered * loadings

    order = np.argsort(-np.abs(contrib))[:args.top]
    scaler = meta['scaler']
    mean_map = dict(zip(num_in, scaler.mean_))
    scale_map = dict(zip(num_in, scaler.scale_))

    print()
    print(f'  FACTOR {j+1} — how this stock\'s score is built')
    print(f'  (showing the {len(order)} biggest of {len(feature_names)} features)')
    print()
    print(f'  {"feature":<22}{"your value":>12}{"model avg":>12}{"z":>8}{"loading":>9}{"adds":>9}')
    print('  ' + '-' * 70)
    for i in order:
        name = feature_names[i]
        if name in mean_map:
            rawv = float(raw[name].iloc[0])
            print(f'  {name:<22}{money(rawv):>12}{money(mean_map[name]):>12}'
                  f'{x[i]:>8.2f}{loadings[i]:>9.3f}{contrib[i]:>9.3f}')
        else:
            on = 'yes' if x[i] >= 0.5 else 'no'
            print(f'  {name:<22}{on:>12}{pca.mean_[i]:>12.2f}'
                  f'{x[i]:>8.2f}{loadings[i]:>9.3f}{contrib[i]:>9.3f}')
    other = contrib.sum() - contrib[order].sum()
    print('  ' + '-' * 70)
    print(f'  {"all other features":<22}{"":>12}{"":>12}{"":>8}{"":>9}{other:>9.3f}')
    print(f'  {"FACTOR " + str(j+1) + " SCORE":<22}{"":>12}{"":>12}{"":>8}{"":>9}{scores[j]:>9.3f}')

    print()
    print('  WHICH BUCKET THAT LANDS IN, AND WHAT THAT BUCKET DID HISTORICALLY')
    print()
    print(f'  {"factor":<9}{"score":>9}{"bucket":>8}{"trades":>8}{"avg R":>8}{"win %":>8}{"points":>9}')
    print('  ' + '-' * 60)
    bucket_scores = []
    for f in range(1, k + 1):
        fs = float(scores[f - 1])
        edges = meta['bucket_edges'].get(f'factor_{f}', [])
        bidx = None
        for idx, (lo, hi) in enumerate(edges):
            if lo <= fs <= hi:
                bidx = idx
                break
        if bidx is None and edges:
            bidx = 0 if fs < edges[0][0] else len(edges) - 1

        bpath = os.path.join(args.output, base, folder, f'factor_{f}_buckets.csv')
        pts = n = mean_r = wr = None
        if bidx is not None and os.path.exists(bpath):
            bdf = pd.read_csv(bpath)
            r = bdf[bdf['Bucket'] == bidx]
            if not r.empty:
                pts = float(r['FinalScore'].iloc[0])
                n = int(r['Count'].iloc[0])
                mean_r = float(r['Mean'].iloc[0])
                wr = float(r['WinRate_%'].iloc[0])
        bucket_scores.append(pts if pts is not None and np.isfinite(pts) else 0.0)
        mark = ' <—' if f == j + 1 else ''
        print(f'  {"F" + str(f):<9}{fs:>9.2f}{("#" + str(bidx)) if bidx is not None else "—":>8}'
              f'{n if n is not None else "—":>8}{mean_r if mean_r is not None else float("nan"):>8.2f}'
              f'{wr if wr is not None else float("nan"):>8.1f}{bucket_scores[-1]:>9.1f}{mark}')

    print('  ' + '-' * 60)
    print(f'  FINAL = average of the {k} point values = {np.mean(bucket_scores):.1f}')
    print(f'  (rounded on the card: {round(float(np.mean(bucket_scores)))})')
    print()


if __name__ == '__main__':
    main()
