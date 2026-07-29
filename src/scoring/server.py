"""
Flask HTTP server for LiveScorer — Trade Desk Rebuild
Runs on port 3001. Node.js calls this for live stock scoring.

Start:  python3 server.py [--output path/to/outputs] [--port 3001]
"""

import os
import sys
import argparse
import importlib
import json
import time
from flask import Flask, request, jsonify
from scorer import LiveScorer
from setupScorer import SetupLiveScorer
from setupProcessor import SetupFactorProcessor

app = Flask(__name__)

# ── Staleness guard ───────────────────────────────────────────────────────────
# A long-lived process keeps processor.py in sys.modules, so a deploy that
# changes training behaviour has no effect until the process restarts — and a
# retrain still reports success while writing tables from the old code. Worse,
# an orphaned scorer holding the port serves /train indefinitely while the
# supervised one crash-loops. Record what was loaded so it can be compared to
# what is on disk, and reload when they diverge.
_PROCESSOR_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'processor.py')
_STARTED_AT = time.time()


def _disk_mtime():
    try:
        return os.path.getmtime(_PROCESSOR_PATH)
    except OSError:
        return None


_LOADED_MTIME = _disk_mtime()


def _load_processor(force_reload=False):
    """Import processor, reloading it if the file changed since it was loaded."""
    global _LOADED_MTIME
    import processor
    on_disk = _disk_mtime()
    reloaded = False
    if force_reload or (on_disk is not None and on_disk != _LOADED_MTIME):
        processor = importlib.reload(processor)
        _LOADED_MTIME = on_disk
        reloaded = True
    return processor, reloaded
scorer: LiveScorer = None
setup_scorer: SetupLiveScorer = None
setup_processor: SetupFactorProcessor = None


@app.route('/health', methods=['GET'])
def health():
    ready = scorer.is_ready() if scorer else False
    on_disk = _disk_mtime()
    stale = on_disk is not None and _LOADED_MTIME is not None and on_disk != _LOADED_MTIME
    try:
        import processor
        n_buckets = getattr(processor, 'N_BUCKETS', None)
    except Exception:
        n_buckets = None
    return jsonify({
        'ok': True,
        'ready': ready,
        # identity, so a stale process holding the port is obvious rather than
        # silently answering on behalf of the supervised one
        'pid': os.getpid(),
        'uptime_s': round(time.time() - _STARTED_AT),
        'n_buckets': n_buckets,
        'output_root': scorer.output_root if scorer else None,
        'code_stale': stale,
    })


@app.route('/score', methods=['POST'])
def score():
    data = request.get_json(force=True, silent=True)
    if not data:
        return jsonify({'ok': False, 'error': 'No JSON body'}), 400

    card = data.get('card', data)          # accept {card: {...}} or flat card dict
    bias = data.get('bias', 'Undefined')   # 'Long', 'Short', 'Undefined'
    entry_time = data.get('entry_time', '9:40')
    regime_sample_threshold = int(data.get('regime_sample_threshold', 150))

    if not scorer.is_ready():
        return jsonify({'ok': False, 'error': 'Model not trained. Run processor.py first.'}), 503

    try:
        result = scorer.score_card(card, bias=bias, entry_time=entry_time,
                                   regime_sample_threshold=regime_sample_threshold)
        return jsonify({'ok': True, **result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/model-info', methods=['GET'])
def model_info():
    if not scorer.is_ready():
        return jsonify({'ok': False, 'error': 'Model not trained'}), 503
    try:
        info = scorer.get_model_info()
        return jsonify({'ok': True, 'bases': info})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/train', methods=['POST'])
def train():
    """Trigger retraining from already-exported R4A/R4B CSVs."""
    data = request.get_json(force=True, silent=True) or {}
    r4a_path = data.get('r4a', os.path.join(os.path.dirname(__file__), '..', '..', 'tmp', 'r4a.csv'))
    r4b_path = data.get('r4b', os.path.join(os.path.dirname(__file__), '..', '..', 'tmp', 'r4b.csv'))
    output_root = scorer.output_root

    if not os.path.exists(r4a_path):
        return jsonify({'ok': False, 'error': f'R4A CSV not found at {r4a_path}'}), 400
    if not os.path.exists(r4b_path):
        return jsonify({'ok': False, 'error': f'R4B CSV not found at {r4b_path}'}), 400

    try:
        # Reload first if processor.py changed since this process started,
        # otherwise a deploy silently trains with the previous code.
        processor, reloaded = _load_processor()
        proc = processor.FactorAnalysisProcessor(r4a_path, r4b_path, output_root)
        proc.run()
        # Invalidate scorer caches so next /score call reloads fresh metadata
        scorer._meta_cache.clear()
        scorer._bucket_cache.clear()
        return jsonify({
            'ok': True,
            'message': 'Training complete',
            'pid': os.getpid(),
            'n_buckets': getattr(processor, 'N_BUCKETS', None),
            'reloaded_processor': reloaded,
            'output_root': output_root,
        })
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════════
# Per-setup routes — every route enforces isolation by keying every path
# on setup_id. Setup A never sees setup B's data at any layer.
# ═══════════════════════════════════════════════════════════════════════

@app.route('/setup/health', methods=['GET'])
def setup_health():
    return jsonify({'ok': True, 'ready': setup_scorer is not None and setup_processor is not None})


@app.route('/setup/model/<setup_id>', methods=['GET'])
def setup_model(setup_id):
    """Metadata + readiness for one setup's model."""
    if not setup_scorer:
        return jsonify({'ok': False, 'error': 'setup scorer not initialised'}), 503
    ready = setup_scorer.is_ready(setup_id)
    meta = setup_scorer.get_meta(setup_id) if ready else None
    return jsonify({'ok': True, 'setup_id': setup_id, 'ready': ready, 'meta': meta})


@app.route('/setup/score', methods=['POST'])
def setup_score():
    """
    POST body: { setup_id, aligned_features }
      aligned_features: list of "check_key::variation" strings that
        resolved aligned=1 on the live fire.

    Returns { grade, expected_R, model_info } or { ok: false, fallback: true }
    when the model isn't ready yet (caller uses its own fallback).
    """
    if not setup_scorer:
        return jsonify({'ok': False, 'error': 'setup scorer not initialised'}), 503
    data = request.get_json(force=True, silent=True) or {}
    setup_id = data.get('setup_id')
    features = data.get('aligned_features') or []
    if not setup_id:
        return jsonify({'ok': False, 'error': 'setup_id required'}), 400

    result = setup_scorer.score(setup_id, features)
    if result is None:
        return jsonify({'ok': False, 'fallback': True, 'reason': 'setup model not trained yet'})
    return jsonify({'ok': True, 'setup_id': setup_id, **result})


@app.route('/setup/train/<setup_id>', methods=['POST'])
def setup_train_one(setup_id):
    """Trigger a retrain for one setup. Idempotent — overwrites artifact."""
    if not setup_processor:
        return jsonify({'ok': False, 'error': 'setup processor not initialised'}), 503
    try:
        result = setup_processor.train_setup(setup_id)
        if setup_scorer:
            setup_scorer.invalidate(setup_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'ok': False, 'setup_id': setup_id, 'reason': str(e)}), 500


@app.route('/setup/train-all', methods=['POST'])
def setup_train_all():
    """Iterate every setup in the DB and retrain any that qualify."""
    if not setup_processor:
        return jsonify({'ok': False, 'error': 'setup processor not initialised'}), 503
    try:
        results = setup_processor.train_all()
        if setup_scorer:
            setup_scorer.invalidate()
        trained = sum(1 for r in results if r.get('ok'))
        return jsonify({'ok': True, 'trained': trained, 'total': len(results), 'results': results})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Trade Desk Scoring Service')
    parser.add_argument('--output', default=os.path.join(os.path.dirname(__file__), 'outputs'),
                        help='Path to scanner-side model outputs directory')
    parser.add_argument('--setup-output', default=None,
                        help='Path to per-setup model outputs (default: outputs/setups)')
    parser.add_argument('--db', default=os.path.join(os.path.dirname(__file__), '..', '..', 'desk.db'),
                        help='Path to desk.db (SQLite) for per-setup training reads')
    parser.add_argument('--port', type=int, default=3001, help='Port to listen on')
    parser.add_argument('--min-trades', type=int, default=30,
                        help='Minimum closed cards for a setup to be trainable')
    args = parser.parse_args()

    output_root = os.path.abspath(args.output)
    os.makedirs(output_root, exist_ok=True)
    setup_output = os.path.abspath(args.setup_output or os.path.join(output_root, 'setups'))
    os.makedirs(setup_output, exist_ok=True)
    db_path = os.path.abspath(args.db)

    scorer = LiveScorer(output_root)
    setup_scorer = SetupLiveScorer(setup_output)
    setup_processor = SetupFactorProcessor(db_path, setup_output, min_trades=args.min_trades)

    if scorer.is_ready():
        print(f'[Scorer] Scanner model ready at {output_root}')
    else:
        print(f'[Scorer] WARNING: No scanner model found at {output_root}. Run processor.py first.')
    print(f'[SetupScorer] Per-setup models at {setup_output}; DB: {db_path}')

    app.run(host='127.0.0.1', port=args.port)
