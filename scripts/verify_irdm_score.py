"""
Manual score verification for IRDM.
Run on the EC2 server where metadata.pkl files exist.

Usage:
  cd ~/Tade-desk-server
  python3 scripts/verify_irdm_score.py
"""

import os, sys, pickle
import numpy as np
import pandas as pd

OUTPUTS = os.path.join(os.path.dirname(__file__), '..', 'src', 'scoring', 'outputs')

# ── IRDM card data from screenshots ──────────────────────────────────────────
# Bias SHORT  → B5 (expected score: 12)
# Bias LONG   → B4 (expected score: 13)

CARD = {
    # categoricals
    'sector':        'Communications',
    'industry':      'Specialty Telecommunications',
    'regime':        'Uptrend',
    'regimeLabel':   None,
    'secBias':       'BULLISH',
    'themes':        None,
    'catalyst':      'Partnership',
    'screenerKeys':  'Trend',
    'longTerm':      'BULLISH',
    'midTerm':       'REBOUND',
    'shortTerm':     'BULLISH',
    'broadResolved': 'Communications',
    'inShortlist':   'false',
    # For Long bias case:
    'bias':          'long',          # change to 'short' for B5 check

    # numerics
    'price':         54.59,
    'prevClose':     43.52,
    'open':          51.76,
    'change':        25.44,
    'gapPct':        18.92,
    'vwap':          53.69,
    'sma5':          45.28,
    'ema9':          46.06,
    'ema13':         45.94,
    'ema20':         45.83,
    'ema50':         43.02,
    'rvol':          6.4,
    'atr':           3.89,
    'adrPct':        7.1,
    'dayHigh':       55.17,
    'dayLow':        51.30,
    'monthHigh':     55.17,
    'monthLow':      40.60,
    'monthRangePos': 96.0,
    'mcap':          5770000000,
    'floatShares':   91530000,
    'shortFloat':    None,
    'pmHigh':        53.40,
    'pmLow':         43.73,
    'pmRange':       9.67,
    'pmAdrRatio':    2.49,
    'secScore':      26,
}

CATEGORICAL_COLS = [
    'sector', 'industry', 'regime', 'regimeLabel', 'secBias',
    'themes', 'catalyst', 'screenerKeys', 'longTerm', 'midTerm',
    'shortTerm', 'broadResolved', 'inShortlist', 'bias',
]
NUMERIC_COLS = [
    'price', 'prevClose', 'open', 'change', 'gapPct',
    'vwap', 'sma5', 'ema9', 'ema13', 'ema20', 'ema50', 'rvol',
    'atr', 'adrPct', 'dayHigh', 'dayLow', 'monthHigh', 'monthLow',
    'monthRangePos', 'mcap', 'floatShares', 'shortFloat', 'pmHigh',
    'pmLow', 'pmRange', 'pmAdrRatio', 'secScore',
]
IDENTIFIER_COLS = ['ticker', 'date', 'capturedAt']


def score_card(card_dict, base_id, table_type='main', regime_val=None):
    folder = 'main' if table_type == 'main' else f'sub_{regime_val}'
    meta_path = os.path.join(OUTPUTS, base_id, folder, 'metadata.pkl')
    if not os.path.exists(meta_path):
        print(f"  ERROR: {meta_path} not found")
        return None

    with open(meta_path, 'rb') as f:
        meta = pickle.load(f)

    print(f"\n{'='*60}")
    print(f"Base: {base_id}/{folder}  |  Training samples: {meta['total_samples']}")
    print(f"k factors: {meta['k_factors']}")

    df = pd.DataFrame([card_dict])

    # Drop identifiers
    df = df.drop(columns=[c for c in IDENTIFIER_COLS if c in df.columns], errors='ignore')
    if table_type == 'sub' and 'regime' in df.columns:
        df = df.drop(columns=['regime'])

    cat_present = meta['categorical_cols']
    num_present = meta['numeric_cols']
    feature_names = meta['feature_names']

    # One-hot encode
    X_cat = pd.get_dummies(df[[c for c in cat_present if c in df.columns]])
    X_num_raw = df[[c for c in num_present if c in df.columns]].apply(pd.to_numeric, errors='coerce').fillna(0)

    X_cat_aligned = X_cat.reindex(
        columns=[f for f in feature_names if f not in num_present],
        fill_value=0
    )

    num_in_features = [c for c in num_present if c in feature_names]
    X_num_raw_aligned = X_num_raw.reindex(columns=num_in_features, fill_value=0)
    X_num_scaled = pd.DataFrame(
        meta['scaler'].transform(X_num_raw_aligned),
        columns=num_in_features,
    )

    X_combined = pd.concat([X_num_scaled, X_cat_aligned], axis=1)
    X_final = X_combined.reindex(columns=feature_names, fill_value=0).fillna(0)

    # PCA project
    factor_scores_live = meta['pca'].transform(X_final.values)
    print(f"\nFactor scores (PCA projection): {[round(float(x),4) for x in factor_scores_live[0]]}")

    # Bucket lookup
    k = meta['k_factors']
    bucket_edges = meta['bucket_edges']
    bucket_scores = []

    print(f"\n{'Factor':<10} {'Score':>10} {'Bucket':>8} {'FinalScore':>12}")
    print('-' * 45)

    for j in range(1, k+1):
        factor_score = float(factor_scores_live[0, j-1])
        edges = bucket_edges.get(f'factor_{j}', [])

        bucket_idx = None
        for idx, (lo, hi) in enumerate(edges):
            if factor_score >= lo and factor_score <= hi:
                bucket_idx = idx
                break
        if bucket_idx is None and edges:
            bucket_idx = 0 if factor_score < edges[0][0] else len(edges) - 1

        bdf_path = os.path.join(OUTPUTS, base_id, folder, f'factor_{j}_buckets.csv')
        bdf = pd.read_csv(bdf_path)
        row = bdf[bdf['Bucket'] == bucket_idx]
        fs = float(row['FinalScore'].iloc[0]) if not row.empty else 0.0

        print(f"  PC{j:<7} {factor_score:>10.4f} {str(bucket_idx):>8}   {fs:>10.4f}")
        bucket_scores.append(fs)

    final = round(float(np.mean(bucket_scores)), 2)
    print(f"\n  Bucket scores: {[round(x,4) for x in bucket_scores]}")
    print(f"  Mean of bucket scores = {final}")
    print(f"  Rounded int score     = {round(final)}")
    return final


if __name__ == '__main__':
    if not os.path.exists(OUTPUTS):
        print(f"ERROR: outputs directory not found at {os.path.abspath(OUTPUTS)}")
        print("Run this script on the EC2 server after training.")
        sys.exit(1)

    print("IRDM Score Verification")
    print("=======================")

    # Case 1: LONG bias → B4
    card_long = {**CARD, 'bias': 'long'}
    s4 = score_card(card_long, 'B4')
    print(f"\n  >>> B4 (LONG) final score = {s4}  (expected: 13)")

    # Case 2: SHORT bias → B5
    card_short = {**CARD, 'bias': 'short'}
    s5 = score_card(card_short, 'B5')
    print(f"\n  >>> B5 (SHORT) final score = {s5}  (expected: 12)")
