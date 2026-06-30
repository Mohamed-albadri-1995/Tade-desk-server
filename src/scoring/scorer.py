"""
LiveScorer — Trade Desk Rebuild
Loads trained model outputs and scores a live stock card.
"""

import os
import pickle
import numpy as np
import pandas as pd

# ─────────────────────────────────────────────────────────
# Constants (spec section 2)
# ─────────────────────────────────────────────────────────

IDENTIFIER_COLS = ['ticker', 'date', 'capturedAt']

CATEGORICAL_COLS = [
    'sector', 'industry', 'regime', 'regimeLabel', 'secBias',
    'themes', 'catalyst', 'screenerKeys', 'longTerm', 'midTerm',
    'shortTerm', 'broadResolved', 'inShortlist', 'bias',
]

NUMERIC_COLS = [
    '_score', 'price', 'prevClose', 'open', 'change', 'gapPct',
    'vwap', 'sma5', 'ema9', 'ema13', 'ema20', 'ema50', 'rvol',
    'atr', 'adrPct', 'dayHigh', 'dayLow', 'monthHigh', 'monthLow',
    'monthRangePos', 'mcap', 'floatShares', 'shortFloat', 'pmHigh',
    'pmLow', 'pmRange', 'pmAdrRatio', 'secScore',
]

DEFAULT_ENTRY_TIME    = '9:40'
FALLBACK_ENTRY_TIME   = '9:37'
REGIME_SAMPLE_THRESHOLD = 10

BIAS_MAPPING = {
    'Long':      'upR',
    'Short':     'downR',
    'Undefined': 'max',
}


def select_base(bias: str, entry_time: str = DEFAULT_ENTRY_TIME) -> str:
    target_type = BIAS_MAPPING.get(bias, 'max')
    if entry_time == DEFAULT_ENTRY_TIME:
        if target_type == 'upR':   return 'B4'
        if target_type == 'downR': return 'B5'
        return 'B6'
    else:  # '9:37' (explicitly chosen)
        if target_type == 'upR':   return 'B1'
        if target_type == 'downR': return 'B2'
        return 'B3'


# ─────────────────────────────────────────────────────────
# LiveScorer
# ─────────────────────────────────────────────────────────

class LiveScorer:

    def __init__(self, output_root: str):
        self.output_root = output_root
        self._meta_cache = {}
        self._bucket_cache = {}

    def _load_meta(self, path: str) -> dict:
        if path in self._meta_cache:
            return self._meta_cache[path]
        with open(path, 'rb') as f:
            meta = pickle.load(f)
        self._meta_cache[path] = meta
        return meta

    def _load_bucket_df(self, path: str) -> pd.DataFrame:
        if path in self._bucket_cache:
            return self._bucket_cache[path]
        df = pd.read_csv(path)
        self._bucket_cache[path] = df
        return df

    def get_model_info(self) -> dict:
        """Return factor compositions (top feature loadings) for all trained bases."""
        info = {}
        for base_id in ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']:
            main_path = os.path.join(self.output_root, base_id, 'main', 'metadata.pkl')
            if not os.path.exists(main_path):
                continue
            meta = self._load_meta(main_path)
            pca = meta['pca']
            feature_names = meta['feature_names']
            k = meta['k_factors']
            factors = []
            for i in range(k):
                loadings = pca.components_[i]
                top = sorted(
                    [{'feature': feature_names[j], 'loading': round(float(loadings[j]), 4)}
                     for j in range(len(feature_names))],
                    key=lambda x: abs(x['loading']),
                    reverse=True
                )[:6]
                factors.append({
                    'factor': i + 1,
                    'explained_variance_pct': round(float(pca.explained_variance_ratio_[i]) * 100, 1)
                        if hasattr(pca, 'explained_variance_ratio_') else None,
                    'top_features': top,
                })
            info[base_id] = {
                'factors': factors,
                'k_factors': k,
                'total_samples': meta['total_samples'],
            }
        return info

    def is_ready(self) -> bool:
        """Returns True if at least the B6/main metadata exists."""
        path = os.path.join(self.output_root, 'B6', 'main', 'metadata.pkl')
        return os.path.exists(path)

    def score_card(self, card_dict: dict, bias: str = 'Undefined',
                   entry_time: str = DEFAULT_ENTRY_TIME) -> dict:
        base_id = select_base(bias, entry_time)

        # Step 2: Select main vs sub table
        regime_card = card_dict.get('regime', None)
        sub_path  = os.path.join(self.output_root, base_id, f'sub_{regime_card}', 'metadata.pkl')
        main_path = os.path.join(self.output_root, base_id, 'main', 'metadata.pkl')

        if regime_card and os.path.exists(sub_path):
            sub_meta = self._load_meta(sub_path)
            if sub_meta['total_samples'] >= REGIME_SAMPLE_THRESHOLD:
                selected_meta = sub_meta
                table_type = 'sub'
            else:
                selected_meta = self._load_meta(main_path)
                table_type = 'main'
        else:
            if not os.path.exists(main_path):
                raise RuntimeError(f"Main metadata not found: {main_path}. Run processor first.")
            selected_meta = self._load_meta(main_path)
            table_type = 'main'

        # Step 3: Preprocess live card
        df_live = pd.DataFrame([card_dict])

        # Drop identifiers
        df_live = df_live.drop(columns=[c for c in IDENTIFIER_COLS if c in df_live.columns], errors='ignore')

        # Drop regime for sub tables
        if table_type == 'sub' and 'regime' in df_live.columns:
            df_live = df_live.drop(columns=['regime'])

        # One-hot encode using same categories
        cat_present = selected_meta['categorical_cols']
        num_present = selected_meta['numeric_cols']

        X_cat = pd.get_dummies(df_live[[c for c in cat_present if c in df_live.columns]])
        X_num_raw = df_live[[c for c in num_present if c in df_live.columns]].apply(
            pd.to_numeric, errors='coerce'
        ).fillna(0)

        # Align to training feature order
        feature_names = selected_meta['feature_names']
        X_cat_aligned = X_cat.reindex(
            columns=[f for f in feature_names if f not in num_present],
            fill_value=0
        )

        # Scale numerics
        num_in_features = [c for c in num_present if c in feature_names]
        X_num_raw_aligned = X_num_raw.reindex(columns=num_in_features, fill_value=0)
        X_num_scaled = pd.DataFrame(
            selected_meta['scaler'].transform(X_num_raw_aligned),
            columns=num_in_features,
        )

        # Combine and align to exact training column order
        X_combined = pd.concat([X_num_scaled, X_cat_aligned], axis=1)
        X_final = X_combined.reindex(columns=feature_names, fill_value=0).fillna(0)

        # Step 4: Project through PCA
        pca = selected_meta['pca']
        factor_scores_live = pca.transform(X_final.values)  # shape (1, k)

        # Step 5: Assign buckets and retrieve scores
        k = selected_meta['k_factors']
        bucket_edges = selected_meta['bucket_edges']
        bucket_scores = []

        for j in range(1, k + 1):
            factor_score = float(factor_scores_live[0, j - 1])
            edges = bucket_edges.get(f'factor_{j}', [])

            # Find matching bucket
            bucket_idx = None
            for idx, (lo, hi) in enumerate(edges):
                if factor_score >= lo and factor_score <= hi:
                    bucket_idx = idx
                    break
            # Clamp to first/last if out of range
            if bucket_idx is None:
                if edges:
                    bucket_idx = 0 if factor_score < edges[0][0] else len(edges) - 1

            if bucket_idx is None:
                bucket_scores.append(0.0)
                continue

            # Load bucket CSV
            table_folder = 'main' if table_type == 'main' else f'sub_{regime_card}'
            bdf_path = os.path.join(self.output_root, base_id, table_folder, f'factor_{j}_buckets.csv')
            if not os.path.exists(bdf_path):
                bucket_scores.append(0.0)
                continue

            bdf = self._load_bucket_df(bdf_path)
            row = bdf[bdf['Bucket'] == bucket_idx]
            if row.empty:
                bucket_scores.append(0.0)
            else:
                bucket_scores.append(float(row['FinalScore'].iloc[0]))

        # Step 6: Aggregate
        final_score = float(np.mean(bucket_scores)) if bucket_scores else 0.0

        return {
            'final_score': round(final_score, 2),
            'used_table': f"{base_id}_{table_type}_{regime_card or 'main'}",
            'total_samples_used': selected_meta['total_samples'],
            'factor_scores': factor_scores_live[0].tolist(),
            'bucket_scores': bucket_scores,
            'confidence': min(1.0, selected_meta['total_samples'] / 100),
        }
