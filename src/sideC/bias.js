/*
 * Auto-bias resolution — single source of truth for what 'auto' means.
 *
 * Priority ladder:
 *  1. Manual bias set by the trader always wins.
 *  2. Catalyst direction, when there is a fresh directional catalyst:
 *     - tier 1 (major): follow the catalyst unconditionally — an FDA
 *       rejection makes a stock a short even in a bullish tape.
 *     - tier 2 (notable): follow the catalyst unless BOTH the stock's
 *       short-term trend and its sector bias point the other way — a
 *       notable story doesn't justify fighting a fully opposed tape.
 *     - tier 3 (minor), neutral sentiment, or stale (>4 days): a minor or
 *       old story is not a directional edge — fall through to context.
 *  3. Context (short-term trend / sector bias / long-term), the previous
 *     behavior, as the fallback.
 */

function contextBias(ctx) {
  const short = ctx?.shortTerm;
  const sec = ctx?.secBias;
  const lt = ctx?.longTerm;
  if (short === 'BEARISH' && sec === 'BEARISH') return 'short';
  if (short === 'BEARISH' && sec !== 'BULLISH') return 'short';
  if (sec === 'BEARISH' && short !== 'BULLISH') return 'short';
  if (short === 'BULLISH' || sec === 'BULLISH') return 'long';
  if (lt === 'BEARISH') return 'short';
  return 'long'; // default to Long in uptrend regimes
}

/**
 * @param row r0 row ({ bias, catalyst, context })
 * @returns { bias: 'long'|'short', source: 'manual'|'catalyst'|'context', reason }
 */
function resolveAutoBias(row) {
  const set = row?.bias;
  if (set === 'long' || set === 'short') {
    return { bias: set, source: 'manual', reason: 'set by trader' };
  }

  const cat = row?.catalyst;
  const ctx = row?.context || {};
  if (cat && (cat.sentiment === 'bull' || cat.sentiment === 'bear') && !cat.stale) {
    const dir = cat.sentiment === 'bull' ? 'long' : 'short';
    if (cat.tier === 1) {
      return { bias: dir, source: 'catalyst', reason: `${cat.label} (major)` };
    }
    if (cat.tier === 2) {
      const opposed = dir === 'long' ? 'BEARISH' : 'BULLISH';
      const tapeFullyOpposed = ctx.shortTerm === opposed && ctx.secBias === opposed;
      if (!tapeFullyOpposed) {
        return { bias: dir, source: 'catalyst', reason: `${cat.label} (notable)` };
      }
    }
  }

  return { bias: contextBias(ctx), source: 'context', reason: 'trend/sector context' };
}

module.exports = { resolveAutoBias, contextBias };
