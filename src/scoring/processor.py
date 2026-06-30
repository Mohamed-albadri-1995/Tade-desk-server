"""
FactorAnalysisProcessor — Trade Desk Rebuild
Reads R4A and R4B CSV files, generates 96 analysis tables + metadata.
Run this offline to retrain the scoring model.
"""

import os
import pickle
import warnings
import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

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
    'price', 'prevClose', 'open', 'change', 'gapPct',
    'vwap', 'sma5', 'ema9', 'ema13', 'ema20', 'ema50', 'rvol',
    'atr', 'adrPct', 'dayHigh', 'dayLow', 'monthHigh', 'monthLow',
    'monthRangePos', 'mcap', 'floatShares', 'shortFloat', 'pmHigh',
    'pmLow', 'pmRange', 'pmAdrRatio', 'secScore',
]

ALL_FEATURES = IDENTIFIER_COLS + CATEGORICAL_COLS + NUMERIC_COLS

OUTCOMES_A = ['upR_A', 'downR_A']
OUTCOMES_B = ['upR_B', 'downR_B']

BASES = [
    {'id': 'B1', 'file': 'r4a', 'target': 'upR_A'},
    {'id': 'B2', 'file': 'r4a', 'target': 'downR_A'},
    {'id': 'B3', 'file': 'r4a', 'target': 'max', 'src': ['upR_A', 'downR_A']},
    {'id': 'B4', 'file': 'r4b', 'target': 'upR_B'},
    {'id': 'B5', 'file': 'r4b', 'target': 'downR_B'},
    {'id': 'B6', 'file': 'r4b', 'target': 'max', 'src': ['upR_B', 'downR_B']},
]

ALPHA = 0.5
K_CONFIDENCE = 5


# ─────────────────────────────────────────────────────────
# FactorAnalysisProcessor
# ─────────────────────────────────────────────────────────

class FactorAnalysisProcessor:

    def __init__(self, path_r4a: str, path_r4b: str, output_root: str):
        if not os.path.exists(path_r4a):
            raise FileNotFoundError(f"R4A file not found: {path_r4a}")
        if not os.path.exists(path_r4b):
            raise FileNotFoundError(f"R4B file not found: {path_r4b}")

        self.df_a = pd.read_csv(path_r4a, low_memory=False)
        self.df_b = pd.read_csv(path_r4b, low_memory=False)
        self.output_root = output_root
        self.unique_regimes = list(self.df_a['regime'].dropna().unique()) \
            if 'regime' in self.df_a.columns else []

    def run(self):
        os.makedirs(self.output_root, exist_ok=True)
        for base in BASES:
            df_base = self.df_a if base['file'] == 'r4a' else self.df_b
            target = base['target']
            base_id = base['id']

            print(f"[Processor] Processing {base_id} main …")
            self._process_table(df_base.copy(), target, base_id, 'main', None)

            for regime_val in self.unique_regimes:
                print(f"[Processor] Processing {base_id} sub_{regime_val} …")
                self._process_table(df_base.copy(), target, base_id, 'sub', regime_val)

        print("[Processor] Done.")

    def _resolve_target(self, df: pd.DataFrame, base: dict) -> pd.Series:
        target = base['target']
        if target == 'max':
            src = base['src']
            for col in src:
                if col not in df.columns:
                    raise ValueError(f"Missing column {col}")
            return df[src].max(axis=1)
        if target not in df.columns:
            raise ValueError(f"Missing target column {target}")
        return df[target]

    def _process_table(self, df: pd.DataFrame, target_col: str, base_id: str,
                       table_type: str, regime_val):
        base = next(b for b in BASES if b['id'] == base_id)

        # Resolve target column (handles 'max')
        try:
            y = self._resolve_target(df, base)
        except ValueError as e:
            print(f"  [SKIP] {base_id}/{table_type}: {e}")
            return

        # Filter by regime for sub tables
        if regime_val is not None:
            if 'regime' not in df.columns:
                return
            df = df[df['regime'] == regime_val].copy()

        if len(df) == 0:
            print(f"  [SKIP] Empty after regime filter: {base_id}/sub_{regime_val}")
            return
        if len(df) < 2:
            print(f"  [SKIP] Too few samples ({len(df)}): {base_id}/{table_type}")
            return

        y = y.loc[df.index]

        # Drop identifiers
        X = df.drop(columns=[c for c in IDENTIFIER_COLS if c in df.columns], errors='ignore')

        # Drop outcome columns
        outcome_cols = OUTCOMES_A + OUTCOMES_B
        X = X.drop(columns=[c for c in outcome_cols if c in X.columns], errors='ignore')

        # Drop regime from sub table features (filtered out)
        if table_type == 'sub' and 'regime' in X.columns:
            X = X.drop(columns=['regime'])

        # Determine categorical cols present in X
        cat_present = [c for c in CATEGORICAL_COLS if c in X.columns]
        num_present = [c for c in NUMERIC_COLS if c in X.columns]

        # One-hot encode categoricals
        X_cat = pd.get_dummies(X[cat_present], drop_first=True) if cat_present else pd.DataFrame(index=X.index)

        # Standardise numerics
        X_num_raw = X[num_present].apply(pd.to_numeric, errors='coerce').fillna(0)
        scaler = StandardScaler()
        X_num_scaled = pd.DataFrame(
            scaler.fit_transform(X_num_raw),
            columns=num_present,
            index=X.index,
        )

        # Combine
        X_final = pd.concat([X_num_scaled, X_cat], axis=1).fillna(0)
        feature_names = list(X_final.columns)

        if X_final.shape[1] == 0:
            print(f"  [SKIP] No features after encoding: {base_id}/{table_type}")
            return

        # Fit PCA (all components first to get eigenvalues)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            pca_full = PCA()
            pca_full.fit(X_final)

        eigenvalues = pca_full.explained_variance_
        k = int(np.sum(eigenvalues > 1.0))
        if k == 0:
            print(f"  [WARN] No eigenvalue > 1; fallback k=1 for {base_id}/{table_type}")
            k = 1

        pca = PCA(n_components=k)
        scores = pca.fit_transform(X_final)

        # ── Output 1: Factor Importance Table ────────────────
        ev_k = eigenvalues[:k]
        ev_sum = ev_k.sum()
        fi_rows = []
        cumulative = 0.0
        for j in range(k):
            w = (ev_k[j] / ev_sum) * 100
            cumulative += w
            fi_rows.append({
                'Factor': f'PC{j+1}',
                'Eigenvalue': round(float(ev_k[j]), 6),
                'Weight_%': round(w, 4),
                'Cumulative_%': round(cumulative, 4),
            })
        fi_df = pd.DataFrame(fi_rows)

        # ── Output 2: Bucket Performance Tables ──────────────
        bucket_edges_all = {}
        factor_bucket_dfs = {}

        for j in range(k):
            factor_scores = scores[:, j]

            # Create deciles
            try:
                bucket_labels, bin_edges = pd.qcut(factor_scores, q=10, labels=False,
                                                   duplicates='drop', retbins=True)
            except Exception:
                try:
                    bucket_labels, bin_edges = pd.cut(factor_scores, bins=10, labels=False,
                                                      retbins=True, duplicates='drop')
                except Exception:
                    bucket_labels = pd.Series([0] * len(factor_scores), index=X_final.index)
                    bin_edges = np.array([factor_scores.min(), factor_scores.max()])

            bucket_labels = pd.Series(bucket_labels, index=X_final.index)

            # Compute per-bucket stats
            max_mean = None
            max_wr = None
            bucket_rows = []

            groups = {}
            for b_idx in sorted(bucket_labels.dropna().unique()):
                mask = bucket_labels == b_idx
                y_b = y[mask]
                n = len(y_b)
                if n == 0:
                    continue
                mean_b = float(y_b.mean())
                wr_b = float((y_b > 1.3).mean() * 100)
                groups[int(b_idx)] = {'n': n, 'mean': mean_b, 'wr': wr_b, 'y': y_b}
                if max_mean is None or mean_b > max_mean:
                    max_mean = mean_b
                if max_wr is None or wr_b > max_wr:
                    max_wr = wr_b

            # Build edge lookup per bucket
            bucket_edge_list = []
            for b_idx, grp in sorted(groups.items()):
                n = grp['n']
                mean_b = grp['mean']
                wr_b = grp['wr']
                y_b = grp['y']

                mean_norm = (mean_b / max_mean) if max_mean and max_mean != 0 else 0
                wr_norm   = (wr_b / max_wr)     if max_wr   and max_wr   != 0 else 0
                raw_score = (ALPHA * mean_norm + (1 - ALPHA) * wr_norm) * 100
                confidence = n / (n + K_CONFIDENCE)
                final_score = raw_score * confidence

                # Edge for this bucket
                lo = float(bin_edges[b_idx])   if b_idx < len(bin_edges) - 1 else float(bin_edges[-2])
                hi = float(bin_edges[b_idx+1]) if b_idx+1 < len(bin_edges) else float(bin_edges[-1])

                bucket_rows.append({
                    'Bucket': b_idx,
                    'Count': n,
                    'Mean': round(mean_b, 4),
                    'WinRate_%': round(wr_b, 4),
                    'Count_lt1': int((y_b < 1).sum()),
                    'Pct_lt1': round(float((y_b < 1).sum()) / n * 100, 2),
                    'Count_ge1': int((y_b >= 1).sum()),
                    'Pct_ge1': round(float((y_b >= 1).sum()) / n * 100, 2),
                    'Count_ge1.5': int((y_b >= 1.5).sum()),
                    'Pct_ge1.5': round(float((y_b >= 1.5).sum()) / n * 100, 2),
                    'Count_ge2': int((y_b >= 2).sum()),
                    'Pct_ge2': round(float((y_b >= 2).sum()) / n * 100, 2),
                    'Mean_Norm': round(mean_norm, 4),
                    'WinRate_Norm': round(wr_norm, 4),
                    'RawScore': round(raw_score, 4),
                    'Confidence': round(confidence, 4),
                    'FinalScore': round(final_score, 4),
                    'Lower_Edge': round(lo, 6),
                    'Upper_Edge': round(hi, 6),
                })
                bucket_edge_list.append((lo, hi))

            bucket_edges_all[f'factor_{j+1}'] = bucket_edge_list
            factor_bucket_dfs[j+1] = pd.DataFrame(bucket_rows)

        # ── Save outputs ──────────────────────────────────────
        folder_name = 'main' if table_type == 'main' else f'sub_{regime_val}'
        out_dir = os.path.join(self.output_root, base_id, folder_name)
        os.makedirs(out_dir, exist_ok=True)

        # Factor importance CSV
        fi_df.to_csv(os.path.join(out_dir, 'factor_importance.csv'), index=False)

        # Bucket CSVs
        for j, bdf in factor_bucket_dfs.items():
            bdf.to_csv(os.path.join(out_dir, f'factor_{j}_buckets.csv'), index=False)

        # metadata.pkl
        metadata = {
            'base_id': base_id,
            'table_type': table_type,
            'regime_value': regime_val,
            'total_samples': len(df),
            'feature_names': feature_names,
            'categorical_cols': cat_present,
            'numeric_cols': num_present,
            'scaler': scaler,
            'pca': pca,
            'k_factors': k,
            'bucket_edges': bucket_edges_all,
        }
        with open(os.path.join(out_dir, 'metadata.pkl'), 'wb') as f:
            pickle.dump(metadata, f)

        print(f"  [OK] {base_id}/{folder_name}: {len(df)} samples, k={k} factors")


# ─────────────────────────────────────────────────────────
# CLI entry point
# ─────────────────────────────────────────────────────────

if __name__ == '__main__':
    import sys
    import argparse

    parser = argparse.ArgumentParser(description='Run FactorAnalysisProcessor')
    parser.add_argument('--r4a', required=True, help='Path to R4A CSV file')
    parser.add_argument('--r4b', required=True, help='Path to R4B CSV file')
    parser.add_argument('--output', default='outputs', help='Output root directory')
    args = parser.parse_args()

    proc = FactorAnalysisProcessor(args.r4a, args.r4b, args.output)
    proc.run()
