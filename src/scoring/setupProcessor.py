"""
SetupFactorProcessor — per-setup training for live signal grading

Runs offline (triggered on demand or on a schedule). For each setup, reads
its closed trade cards and check alignments out of the SQLite DB, fits a
factor-analysis + regression model, and writes a pickled artifact + a
metadata JSON to `outputs/setups/{setup_id}/`.

Isolation guarantee: every setup gets its own directory. Training setup A
never touches setup B's model — that mirrors the "every setup has its
own engine" requirement. A live grade for setup A uses ONLY setup A's
model, never a shared model.

Method:
  1. Build a feature matrix (rows = closed cards, cols = check_key ×
     variation combinations, cells = aligned {0, 1}).
  2. Standardise features + fit PCA (small n_components — capped at
     min(features, 5, n-1) to avoid over-fitting on typical sample
     sizes).
  3. Fit Ridge regression on PCA components → predicted R-multiple.
  4. Compute bucket cutoffs from empirical prediction quantiles (75/50/25
     percentiles → A+ / A / B / C).
  5. Persist scaler + PCA + ridge + cutoffs + metadata.

Fallback semantics:
  - n < min_trades (default 30): skip training, live scorer falls back
    to the naive delta-expectancy path in the Node grading engine.
  - Only 1 unique r_multiple value (all wins or all losses): can't fit
    regression — skip.
  - Only 1 check with variance: PCA degenerates — skip.

CLI:
  python setupProcessor.py --db /path/to/desk.db --output outputs
      [--setup <uuid>]     # optional; retrains one setup instead of all
      [--min-trades N]     # override the default of 30
"""

import os
import sys
import json
import time
import pickle
import sqlite3
import argparse
import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import Ridge


class SetupFactorProcessor:
    """Trains one PCA + Ridge model per setup and persists per-setup."""

    def __init__(self, db_path, output_root, min_trades=30):
        self.db_path = db_path
        self.output_root = output_root
        self.min_trades = min_trades
        os.makedirs(self.output_root, exist_ok=True)

    def _connect(self):
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        return con

    def _closed_cards(self, con, setup_id):
        rows = con.execute("""
            SELECT id, r_multiple, direction, account
              FROM trade_cards
             WHERE setup_id = ? AND r_multiple IS NOT NULL
             ORDER BY closed_at ASC
        """, (setup_id,)).fetchall()
        return [dict(r) for r in rows]

    def _check_alignments(self, con, card_ids):
        if not card_ids:
            return []
        q = f"""
            SELECT card_id, check_key, aligned, variation
              FROM trade_card_checks
             WHERE kind = 'additional' AND card_id IN ({','.join('?' * len(card_ids))})
        """
        rows = con.execute(q, card_ids).fetchall()
        return [dict(r) for r in rows]

    def _build_features(self, cards, alignments):
        """Rows = cards, cols = check_key×variation, cells = 0/1 aligned.

        Including the variation dimension means a check that fires as
        `long` on some cards and `short` on others contributes two
        independent features, matching how live grading resolves the
        same paired library entry against different signal sides.
        """
        card_df = pd.DataFrame(cards).set_index('id')
        align_df = pd.DataFrame(alignments)
        if align_df.empty:
            return None, None

        align_df = align_df.dropna(subset=['aligned'])
        align_df['feature'] = align_df['check_key'] + '::' + align_df['variation']

        pivot = align_df.pivot_table(
            index='card_id', columns='feature', values='aligned',
            aggfunc='max', fill_value=0,
        )
        pivot = pivot.reindex(card_df.index, fill_value=0).astype(int)
        target = card_df.loc[pivot.index, 'r_multiple'].astype(float)
        return pivot, target

    def train_setup(self, setup_id):
        """Train one setup; returns {ok, ...}."""
        con = self._connect()
        try:
            cards = self._closed_cards(con, setup_id)
            n_cards = len(cards)
            if n_cards < self.min_trades:
                return {'ok': False, 'setup_id': setup_id, 'n': n_cards,
                        'reason': f'not enough closed cards ({n_cards} < {self.min_trades})'}

            card_ids = [c['id'] for c in cards]
            alignments = self._check_alignments(con, card_ids)

            X, y = self._build_features(cards, alignments)
            if X is None or X.shape[1] == 0:
                return {'ok': False, 'setup_id': setup_id, 'n': n_cards,
                        'reason': 'no additional-check alignments recorded'}
            if y.nunique() < 2:
                return {'ok': False, 'setup_id': setup_id, 'n': n_cards,
                        'reason': 'r_multiple has no variance (all wins or all losses)'}

            # Drop features that never fire — they carry no signal and
            # inflate PCA dimensionality artificially.
            keep = X.columns[X.var() > 0]
            X = X[keep]
            if X.shape[1] == 0:
                return {'ok': False, 'setup_id': setup_id, 'n': n_cards,
                        'reason': 'no check features with variance'}

            scaler = StandardScaler(with_mean=True, with_std=True)
            Xs = scaler.fit_transform(X.values)

            # Cap components conservatively — tiny samples can't
            # support many latent factors without over-fitting.
            n_comp = max(1, min(X.shape[1], 5, X.shape[0] - 1))
            pca = PCA(n_components=n_comp)
            Xp = pca.fit_transform(Xs)

            # Ridge on the factor scores. Light regularisation is enough;
            # PCA already suppresses noise.
            ridge = Ridge(alpha=1.0)
            ridge.fit(Xp, y.values)
            preds = ridge.predict(Xp)

            # Bucket cutoffs from empirical prediction distribution.
            # A grade is a QUANTILE of this setup's own history, not an
            # absolute R threshold — so each setup gets graded relative
            # to its own baseline, which is what the user wanted.
            cuts = np.quantile(preds, [0.75, 0.50, 0.25]).tolist()

            model = {
                'scaler':   scaler,
                'pca':      pca,
                'ridge':    ridge,
                'buckets':  cuts,
                'features': list(X.columns),
                'n_trained': int(y.shape[0]),
                'trained_at': time.time(),
                'grade_summary': {
                    'A+_mean_R': float(preds[preds >= cuts[0]].mean()) if any(preds >= cuts[0]) else None,
                    'A_mean_R':  float(preds[(preds >= cuts[1]) & (preds < cuts[0])].mean()) if any((preds >= cuts[1]) & (preds < cuts[0])) else None,
                    'B_mean_R':  float(preds[(preds >= cuts[2]) & (preds < cuts[1])].mean()) if any((preds >= cuts[2]) & (preds < cuts[1])) else None,
                    'C_mean_R':  float(preds[preds < cuts[2]].mean()) if any(preds < cuts[2]) else None,
                },
            }

            setup_dir = os.path.join(self.output_root, setup_id)
            os.makedirs(setup_dir, exist_ok=True)
            with open(os.path.join(setup_dir, 'model.pkl'), 'wb') as f:
                pickle.dump(model, f)
            meta = {
                'setup_id': setup_id,
                'n_trained': model['n_trained'],
                'trained_at': model['trained_at'],
                'features': model['features'],
                'buckets': cuts,
                'grade_summary': model['grade_summary'],
                'r_multiple_stats': {
                    'mean': float(y.mean()),
                    'std':  float(y.std()),
                    'min':  float(y.min()),
                    'max':  float(y.max()),
                },
            }
            with open(os.path.join(setup_dir, 'meta.json'), 'w') as f:
                json.dump(meta, f, indent=2)

            return {'ok': True, 'setup_id': setup_id, 'n': model['n_trained'],
                    'features': len(model['features']), 'components': int(pca.n_components_)}
        finally:
            con.close()

    def train_all(self):
        con = self._connect()
        try:
            setup_ids = [r['id'] for r in con.execute('SELECT id FROM trading_setups').fetchall()]
        finally:
            con.close()
        results = []
        for sid in setup_ids:
            try:
                results.append(self.train_setup(sid))
            except Exception as e:
                results.append({'ok': False, 'setup_id': sid, 'reason': str(e)})
        return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Setup-level factor-analysis training')
    parser.add_argument('--db', required=True, help='Path to desk.db (SQLite)')
    parser.add_argument('--output', default=os.path.join(os.path.dirname(__file__), 'outputs', 'setups'))
    parser.add_argument('--setup', default=None, help='If set, train only this setup id')
    parser.add_argument('--min-trades', type=int, default=30)
    args = parser.parse_args()

    proc = SetupFactorProcessor(args.db, os.path.abspath(args.output), min_trades=args.min_trades)
    if args.setup:
        res = proc.train_setup(args.setup)
        print(json.dumps(res, indent=2))
        sys.exit(0 if res.get('ok') else 1)
    else:
        results = proc.train_all()
        ok = sum(1 for r in results if r.get('ok'))
        print(f'{ok}/{len(results)} setups trained')
        for r in results:
            print(json.dumps(r))
