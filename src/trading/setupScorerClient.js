/**
 * Node client for the Python per-setup factor-analysis scorer.
 *
 * Thin HTTP wrapper around the Flask endpoints on the scoring server
 * (see src/scoring/server.py, port 3001 by default). Every call is
 * setup-scoped — the client never sees data from a setup other than the
 * one it asked about — which preserves the "each setup has its own
 * engine" isolation requirement all the way through the stack.
 *
 * Fallback semantics: if the service is unreachable OR the setup hasn't
 * been trained yet, methods return null. Callers (router grading path)
 * treat null as "use the existing Node-side grader" so the trade still
 * fires with a sensible grade even before any model exists.
 */

const SCORER_URL = process.env.SCORER_URL || 'http://127.0.0.1:3001';
const TIMEOUT_MS = 1500;   // don't stall a live fire on slow model IO

async function _fetch(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SCORER_URL}${path}`, { ...opts, signal: ctl.signal });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask the Python scorer for THIS setup's per-fire grade.
 *
 * alignedChecks: array of trade_card_check-shaped objects. Each must
 *   carry { key, variation, aligned } so we can build the
 *   "check_key::variation" feature string the trained model expects.
 *
 * Returns { grade, expectedR, modelInfo } on success, null on any
 * failure (service down, model missing for this setup, timeout).
 */
async function scoreSetup(setupId, alignedChecks) {
  if (!setupId) return null;
  const aligned_features = (alignedChecks || [])
    .filter(c => c && c.aligned)
    .map(c => `${c.key}::${c.variation || 'symmetric'}`);
  const body = JSON.stringify({ setup_id: setupId, aligned_features });
  const r = await _fetch('/setup/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r?.ok) return null;
  return {
    grade:      r.grade,
    expectedR:  r.expected_R,
    modelInfo:  r.model_info,
    source:    'factor-analysis',
  };
}

/**
 * Read a setup's model metadata (n trained on, when trained, feature
 * count, quantile cutoffs, per-grade expected R). null if the setup
 * has never been trained OR the service is down.
 */
async function getSetupModel(setupId) {
  if (!setupId) return null;
  const r = await _fetch(`/setup/model/${encodeURIComponent(setupId)}`);
  if (!r?.ok || !r.ready) return null;
  return { ready: true, meta: r.meta };
}

/**
 * Trigger a retrain for one setup. Returns whatever the processor
 * returned ({ ok, n, features, ... } or { ok: false, reason }).
 * Null if the service is unreachable.
 */
async function trainSetup(setupId) {
  if (!setupId) return null;
  return await _fetch(`/setup/train/${encodeURIComponent(setupId)}`, { method: 'POST' });
}

async function trainAll() {
  return await _fetch('/setup/train-all', { method: 'POST' });
}

async function health() {
  return await _fetch('/setup/health');
}

module.exports = { scoreSetup, getSetupModel, trainSetup, trainAll, health };
