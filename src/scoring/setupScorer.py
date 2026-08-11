"""
SetupLiveScorer — loads per-setup trained models and scores live fires

Given a setup_id and the list of currently-aligned additional checks
(with variation), returns { grade, expected_R, model_info }.

Isolation guarantee: each setup's model lives at a distinct path
(`{output_root}/{setup_id}/model.pkl`) and is loaded independently.
Different setups NEVER share a scorer — a call for setup A only touches
A's artifacts.

Fallback: is_ready(setup_id) → False when the setup hasn't been trained
yet (typically n_closed < min_trades). Callers should fall back to their
prior scoring path (naive delta expectancy in the Node engine).
"""

import os
import json
import pickle
import numpy as np


class SetupLiveScorer:

    def __init__(self, output_root):
        self.output_root = output_root
        self._model_cache = {}
        self._meta_cache = {}

    def _paths(self, setup_id):
        base = os.path.join(self.output_root, setup_id)
        return os.path.join(base, 'model.pkl'), os.path.join(base, 'meta.json')

    def _load_model(self, setup_id):
        if setup_id in self._model_cache:
            return self._model_cache[setup_id]
        model_path, _ = self._paths(setup_id)
        if not os.path.exists(model_path):
            return None
        with open(model_path, 'rb') as f:
            model = pickle.load(f)
        self._model_cache[setup_id] = model
        return model

    def _load_meta(self, setup_id):
        if setup_id in self._meta_cache:
            return self._meta_cache[setup_id]
        _, meta_path = self._paths(setup_id)
        if not os.path.exists(meta_path):
            return None
        with open(meta_path, 'r') as f:
            meta = json.load(f)
        self._meta_cache[setup_id] = meta
        return meta

    def invalidate(self, setup_id=None):
        """Drop cached model(s). Call after retraining."""
        if setup_id is None:
            self._model_cache.clear()
            self._meta_cache.clear()
        else:
            self._model_cache.pop(setup_id, None)
            self._meta_cache.pop(setup_id, None)

    def is_ready(self, setup_id):
        return self._load_model(setup_id) is not None

    def score(self, setup_id, aligned_features):
        """
        aligned_features: list of "check_key::variation" strings that
            resolved aligned=1 on this live fire. Anything not in this
            list is treated as 0.
        """
        model = self._load_model(setup_id)
        if model is None:
            return None

        aligned_set = set(aligned_features)
        vec = np.zeros(len(model['features']), dtype=float)
        for i, name in enumerate(model['features']):
            if name in aligned_set:
                vec[i] = 1.0

        Xs = model['scaler'].transform(vec.reshape(1, -1))
        Xp = model['pca'].transform(Xs)
        pred = float(model['ridge'].predict(Xp)[0])

        cuts = model['buckets']
        if pred >= cuts[0]:   grade = 'A+'
        elif pred >= cuts[1]: grade = 'A'
        elif pred >= cuts[2]: grade = 'B'
        else:                 grade = 'C'

        return {
            'grade':     grade,
            'expected_R': pred,
            'model_info': {
                'n_trained':  model['n_trained'],
                'trained_at': model['trained_at'],
                'n_features': len(model['features']),
                'buckets':    cuts,
            },
        }

    def get_meta(self, setup_id):
        return self._load_meta(setup_id)
