"""
Flask HTTP server for LiveScorer — Trade Desk Rebuild
Runs on port 3001. Node.js calls this for live stock scoring.

Start:  python3 server.py [--output path/to/outputs] [--port 3001]
"""

import os
import sys
import argparse
import json
from flask import Flask, request, jsonify
from scorer import LiveScorer

app = Flask(__name__)
scorer: LiveScorer = None


@app.route('/health', methods=['GET'])
def health():
    ready = scorer.is_ready() if scorer else False
    return jsonify({'ok': True, 'ready': ready})


@app.route('/score', methods=['POST'])
def score():
    data = request.get_json(force=True, silent=True)
    if not data:
        return jsonify({'ok': False, 'error': 'No JSON body'}), 400

    card = data.get('card', data)          # accept {card: {...}} or flat card dict
    bias = data.get('bias', 'Undefined')   # 'Long', 'Short', 'Undefined'
    entry_time = data.get('entry_time', '9:40')

    if not scorer.is_ready():
        return jsonify({'ok': False, 'error': 'Model not trained. Run processor.py first.'}), 503

    try:
        result = scorer.score_card(card, bias=bias, entry_time=entry_time)
        return jsonify({'ok': True, **result})
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
        # Import processor and run (in the same process for simplicity)
        from processor import FactorAnalysisProcessor
        proc = FactorAnalysisProcessor(r4a_path, r4b_path, output_root)
        proc.run()
        # Invalidate scorer caches so next /score call reloads fresh metadata
        scorer._meta_cache.clear()
        scorer._bucket_cache.clear()
        return jsonify({'ok': True, 'message': 'Training complete'})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Trade Desk Scoring Service')
    parser.add_argument('--output', default=os.path.join(os.path.dirname(__file__), 'outputs'),
                        help='Path to model outputs directory')
    parser.add_argument('--port', type=int, default=3001, help='Port to listen on')
    args = parser.parse_args()

    output_root = os.path.abspath(args.output)
    os.makedirs(output_root, exist_ok=True)

    scorer = LiveScorer(output_root)

    if scorer.is_ready():
        print(f'[Scorer] Model ready at {output_root}')
    else:
        print(f'[Scorer] WARNING: No model found at {output_root}. Run processor.py first.')

    app.run(host='127.0.0.1', port=args.port)
