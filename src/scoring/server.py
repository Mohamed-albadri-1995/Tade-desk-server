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

# NOTE the imports that are NOT here. scorer, setupScorer, setupProcessor and
# processor pull in numpy, pandas and scikit-learn between them: measured on
# this box, flask alone is 29MB resident, pandas takes it to 74MB and sklearn to
# 155MB. One scorer runs per tool, and most of them have no trained model and
# never score anything — so importing eagerly cost well over a gigabyte across
# the machine to hold libraries that were never called.
#
# On a 912MB box that is not a tuning detail. It is why scorers were being
# OOM-killed mid-import and restarting hundreds of times.
#
# Everything heavy is therefore imported at the point of first use. An idle
# scorer stays at flask-only; it grows when it is actually asked to score or
# train.

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
# Set in __main__; the objects themselves are built on first use.
OUTPUT_ROOT = None
SETUP_OUTPUT = None
DB_PATH = None
MIN_TRADES = 30

scorer = None
setup_scorer = None
setup_processor = None


def get_scorer():
    """The scanner-side scorer, built on first use."""
    global scorer
    if scorer is None:
        from scorer import LiveScorer
        scorer = LiveScorer(OUTPUT_ROOT)
    return scorer


def get_setup_scorer():
    global setup_scorer
    if setup_scorer is None:
        from setupScorer import SetupLiveScorer
        setup_scorer = SetupLiveScorer(SETUP_OUTPUT)
    return setup_scorer


def get_setup_processor():
    global setup_processor
    if setup_processor is None:
        from setupProcessor import SetupFactorProcessor
        setup_processor = SetupFactorProcessor(DB_PATH, SETUP_OUTPUT, min_trades=MIN_TRADES)
    return setup_processor


def model_ready():
    """Is a trained model present?

    The same check LiveScorer.is_ready makes, done directly so that asking the
    question does not drag numpy and pandas into a process that may never need
    them. /health is polled constantly — by the deploy, by the landing page, by
    the Analysis tab — so this is the hot path that must stay cheap.
    """
    if not OUTPUT_ROOT:
        return False
    return os.path.exists(os.path.join(OUTPUT_ROOT, 'B6', 'main', 'metadata.pkl'))


def n_buckets():
    """The bucket count, without importing processor to read it.

    processor.py reads this from the environment and so can this. Importing the
    module to fetch one integer pulled in scikit-learn — 80MB resident, on every
    scorer, permanently, because /health is called on all of them at deploy.
    If processor is already loaded (after a train) its live value wins.
    """
    mod = sys.modules.get('processor')
    if mod is not None:
        return getattr(mod, 'N_BUCKETS', None)
    try:
        return int(os.environ.get('SCORER_N_BUCKETS', '5'))
    except (TypeError, ValueError):
        return None


@app.route('/health', methods=['GET'])
def health():
    ready = model_ready()
    on_disk = _disk_mtime()
    stale = on_disk is not None and _LOADED_MTIME is not None and on_disk != _LOADED_MTIME
    return jsonify({
        'ok': True,
        'ready': ready,
        # identity, so a stale process holding the port is obvious rather than
        # silently answering on behalf of the supervised one
        'pid': os.getpid(),
        'uptime_s': round(time.time() - _STARTED_AT),
        'n_buckets': n_buckets(),
        'output_root': OUTPUT_ROOT,
        # whether the heavy libraries have actually been loaded in this process
        'loaded': scorer is not None,
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

    if not model_ready():
        return jsonify({'ok': False, 'error': 'Model not trained. Run processor.py first.'}), 503

    try:
        result = get_scorer().score_card(card, bias=bias, entry_time=entry_time,
                                         regime_sample_threshold=regime_sample_threshold)
        return jsonify({'ok': True, **result})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/model-info', methods=['GET'])
def model_info():
    if not model_ready():
        return jsonify({'ok': False, 'error': 'Model not trained'}), 503
    try:
        info = get_scorer().get_model_info()
        return jsonify({'ok': True, 'bases': info})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/train', methods=['POST'])
def train():
    """Trigger retraining from already-exported R4A/R4B CSVs."""
    data = request.get_json(force=True, silent=True) or {}
    r4a_path = data.get('r4a', os.path.join(os.path.dirname(__file__), '..', '..', 'tmp', 'r4a.csv'))
    r4b_path = data.get('r4b', os.path.join(os.path.dirname(__file__), '..', '..', 'tmp', 'r4b.csv'))
    output_root = OUTPUT_ROOT

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
        # Invalidate cached metadata so the next score reloads it. Only if the
        # scorer was ever built — training does not require one to exist.
        if scorer is not None:
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
    # Configured, rather than instantiated — the objects are built on demand.
    return jsonify({'ok': True, 'ready': bool(SETUP_OUTPUT and DB_PATH)})


@app.route('/setup/model/<setup_id>', methods=['GET'])
def setup_model(setup_id):
    """Metadata + readiness for one setup's model."""
    if not SETUP_OUTPUT:
        return jsonify({'ok': False, 'error': 'setup scorer not initialised'}), 503
    ss = get_setup_scorer()
    ready = ss.is_ready(setup_id)
    meta = ss.get_meta(setup_id) if ready else None
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
    if not SETUP_OUTPUT:
        return jsonify({'ok': False, 'error': 'setup scorer not initialised'}), 503
    data = request.get_json(force=True, silent=True) or {}
    setup_id = data.get('setup_id')
    features = data.get('aligned_features') or []
    if not setup_id:
        return jsonify({'ok': False, 'error': 'setup_id required'}), 400

    result = get_setup_scorer().score(setup_id, features)
    if result is None:
        return jsonify({'ok': False, 'fallback': True, 'reason': 'setup model not trained yet'})
    return jsonify({'ok': True, 'setup_id': setup_id, **result})


@app.route('/setup/train/<setup_id>', methods=['POST'])
def setup_train_one(setup_id):
    """Trigger a retrain for one setup. Idempotent — overwrites artifact."""
    if not DB_PATH:
        return jsonify({'ok': False, 'error': 'setup processor not initialised'}), 503
    try:
        result = get_setup_processor().train_setup(setup_id)
        get_setup_scorer().invalidate(setup_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'ok': False, 'setup_id': setup_id, 'reason': str(e)}), 500


@app.route('/setup/train-all', methods=['POST'])
def setup_train_all():
    """Iterate every setup in the DB and retrain any that qualify."""
    if not DB_PATH:
        return jsonify({'ok': False, 'error': 'setup processor not initialised'}), 503
    try:
        results = get_setup_processor().train_all()
        get_setup_scorer().invalidate()
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

    OUTPUT_ROOT = os.path.abspath(args.output)
    os.makedirs(OUTPUT_ROOT, exist_ok=True)
    SETUP_OUTPUT = os.path.abspath(args.setup_output or os.path.join(OUTPUT_ROOT, 'setups'))
    os.makedirs(SETUP_OUTPUT, exist_ok=True)
    DB_PATH = os.path.abspath(args.db)
    MIN_TRADES = args.min_trades

    # Nothing heavy is constructed here on purpose — see the note at the top.
    if model_ready():
        print(f'[Scorer] Scanner model ready at {OUTPUT_ROOT} (loading on first score)')
    else:
        print(f'[Scorer] No scanner model at {OUTPUT_ROOT} yet — idle, using no memory for it.')
    print(f'[SetupScorer] Per-setup models at {SETUP_OUTPUT}; DB: {DB_PATH}')

    app.run(host='127.0.0.1', port=args.port)
