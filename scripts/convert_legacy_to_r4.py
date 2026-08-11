"""
Convert legacy mergedregister CSV to R4A and R4B training files.

Usage:
  python3 scripts/convert_legacy_to_r4.py <input.csv> <output_dir>

Example:
  python3 scripts/convert_legacy_to_r4.py tmp/mergedregister_1.csv tmp/
  → produces tmp/r4a.csv and tmp/r4b.csv (ready to upload and train)

Rules:
  - Dedup: keep only the first date each ticker appeared (multi-day stay rule)
  - R4A: uses 9:37 outcomes (up_r35/down_r35) + 9:35 context snapshot
  - R4B: uses 9:40 outcomes (up_r40/down_r40) + 9:40 context snapshot
  - Rows with missing outcomes are dropped
"""

import sys
import os
import pandas as pd

# ── Column mapping from legacy CSV → R4 schema ───────────────────────────────

RENAME = {
    'change_pct':      'change',
    'prev_close':      'prevClose',
    'gap_pct':         'gapPct',
    'day_high':        'dayHigh',
    'day_low':         'dayLow',
    'month_high':      'monthHigh',
    'month_low':       'monthLow',
    'month_range_pos': 'monthRangePos',
    'float_shares':    'floatShares',
    'short_float':     'shortFloat',
    'pm_high':         'pmHigh',
    'pm_low':          'pmLow',
    'pm_range':        'pmRange',
    'pm_adr_ratio':    'pmAdrRatio',
    'adr_pct':         'adrPct',
    'screeners':       'screenerKeys',
    'st_bias':         'shortTerm',
    'lt_bias':         'longTerm',
    'mid_term':        'midTerm',
    'sec_bias':        'secBias',
    'sec_score':       'secScore',
    'captured_at':     'capturedAt',
}

# Final columns expected by the processor (in order)
R4A_COLS = [
    'ticker', 'date', 'capturedAt',
    'sector', 'industry', 'regime', 'regimeLabel', 'secBias',
    'themes', 'catalyst', 'screenerKeys', 'longTerm', 'midTerm',
    'shortTerm', 'broadResolved', 'inShortlist', 'bias',
    '_score', 'price', 'prevClose', 'open', 'change', 'gapPct',
    'vwap', 'sma5', 'ema9', 'ema13', 'ema20', 'ema50', 'rvol',
    'atr', 'adrPct', 'dayHigh', 'dayLow', 'monthHigh', 'monthLow',
    'monthRangePos', 'mcap', 'floatShares', 'shortFloat', 'pmHigh',
    'pmLow', 'pmRange', 'pmAdrRatio', 'secScore',
    'upR_A', 'downR_A',
]

R4B_COLS = [c.replace('upR_A', 'upR_B').replace('downR_A', 'downR_B') for c in R4A_COLS]


def convert(input_path, output_dir):
    print(f"Reading {input_path}...")
    df = pd.read_csv(input_path, low_memory=False)
    print(f"  Raw rows: {len(df)}")

    # ── Step 1: Keep only rows with valid outcomes ─────────────────────────
    df = df.dropna(subset=['up_r35', 'down_r35', 'up_r40', 'down_r40'])
    print(f"  After dropping missing outcomes: {len(df)}")

    # ── Step 2: Deduplicate — keep first date per ticker ──────────────────
    df = df.sort_values('date')
    df = df.drop_duplicates(subset='ticker', keep='first')
    print(f"  After dedup (first occurrence per ticker): {len(df)}")

    # ── Step 3: Rename columns ────────────────────────────────────────────
    df = df.rename(columns=RENAME)

    # ── Step 4: Add missing columns with defaults ─────────────────────────
    df['regimeLabel'] = None
    df['themes']      = None
    df['catalyst']    = None
    df['inShortlist'] = 'false'
    df['bias']        = 'auto'
    df['_score']      = None
    df['broadResolved'] = df['sector']   # sector ≈ broadResolved in this data

    # ── Step 5: Build R4A (9:37 entry) ───────────────────────────────────
    df_a = df.copy()
    # Use 9:35 context snapshot for regime/shortTerm if available
    if 'snap935_regime' in df.columns:
        df_a['regime'] = df['snap935_regime'].fillna(df.get('regime', None))
    if 'snap935_st' in df.columns:
        df_a['shortTerm'] = df['snap935_st'].fillna(df_a['shortTerm'])
    if 'snap935_lt' in df.columns:
        df_a['longTerm'] = df['snap935_lt'].fillna(df_a['longTerm'])
    if 'snap935_mt' in df.columns:
        df_a['midTerm'] = df['snap935_mt'].fillna(df_a['midTerm'])
    if 'snap935_sec_bias' in df.columns:
        df_a['secBias'] = df['snap935_sec_bias'].fillna(df_a['secBias'])

    df_a['upR_A']   = df['up_r35']
    df_a['downR_A'] = df['down_r35']

    # Keep only valid rows (outcome must be finite)
    df_a = df_a[df_a['upR_A'].notna() & df_a['downR_A'].notna()]

    # Select and order final columns (fill missing with None)
    for col in R4A_COLS:
        if col not in df_a.columns:
            df_a[col] = None
    df_a = df_a[R4A_COLS]

    # ── Step 6: Build R4B (9:40 entry) ───────────────────────────────────
    df_b = df.copy()
    if 'snap940_regime' in df.columns:
        df_b['regime'] = df['snap940_regime'].fillna(df.get('regime', None))
    if 'snap940_st' in df.columns:
        df_b['shortTerm'] = df['snap940_st'].fillna(df_b['shortTerm'])
    if 'snap940_lt' in df.columns:
        df_b['longTerm'] = df['snap940_lt'].fillna(df_b['longTerm'])
    if 'snap940_mt' in df.columns:
        df_b['midTerm'] = df['snap940_mt'].fillna(df_b['midTerm'])
    if 'snap940_sec_bias' in df.columns:
        df_b['secBias'] = df['snap940_sec_bias'].fillna(df_b['secBias'])

    df_b['upR_B']   = df['up_r40']
    df_b['downR_B'] = df['down_r40']

    df_b = df_b[df_b['upR_B'].notna() & df_b['downR_B'].notna()]

    for col in R4B_COLS:
        if col not in df_b.columns:
            df_b[col] = None
    df_b = df_b[R4B_COLS]

    # ── Step 7: Save ──────────────────────────────────────────────────────
    os.makedirs(output_dir, exist_ok=True)
    path_a = os.path.join(output_dir, 'r4a.csv')
    path_b = os.path.join(output_dir, 'r4b.csv')
    df_a.to_csv(path_a, index=False)
    df_b.to_csv(path_b, index=False)

    print(f"\nR4A → {path_a}  ({len(df_a)} rows)")
    print(f"R4B → {path_b}  ({len(df_b)} rows)")

    # Quick sanity check
    print("\nR4A outcome stats:")
    print(f"  upR_A  — mean: {df_a['upR_A'].mean():.3f}, max: {df_a['upR_A'].max():.3f}")
    print(f"  downR_A— mean: {df_a['downR_A'].mean():.3f}, max: {df_a['downR_A'].max():.3f}")
    print("\nR4B outcome stats:")
    print(f"  upR_B  — mean: {df_b['upR_B'].mean():.3f}, max: {df_b['upR_B'].max():.3f}")
    print(f"  downR_B— mean: {df_b['downR_B'].mean():.3f}, max: {df_b['downR_B'].max():.3f}")

    regimes_a = df_a['regime'].value_counts().to_dict()
    print(f"\nRegimes in R4A: {regimes_a}")

    return path_a, path_b


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 scripts/convert_legacy_to_r4.py <input.csv> <output_dir>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
