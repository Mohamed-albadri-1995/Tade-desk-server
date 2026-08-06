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

/**
 * Direction from the tape, or null when the tape is not saying anything.
 *
 * This used to end `return 'long'` — a default, reached when the short-term
 * trend, the sector and the long-term view had all declined to answer. That is
 * not a bias, it is the absence of one wearing a bias's clothes, and the card
 * showed it the same way it showed a real read. Across the backups the nine
 * cards biased this way went 0 for 9.
 *
 * Null now, and the card says "no read" rather than inventing one. An opinion
 * manufactured from no evidence is worse than no opinion, because it is
 * indistinguishable from one that was earned.
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
  if (lt === 'BULLISH') return 'long';
  return null;
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

  /*
   * A technical catalyst must not set direction.
   *
   * "Gap Up" on a gap screener is the screener's own filter read back as if it
   * were news — every stock on that list gapped, so it separates nothing. Over
   * 23 days, 39 of 100 catalysts were technicals and 30 of those were literally
   * Gap Up; they are tier 2, so each one was setting a bias. Those cards ran
   * -0.06R net while the news-sourced ones ran +0.18R.
   *
   * They stay on the card — the tape moving hard is worth seeing — but as a
   * description of what happened, not a prediction of what happens next.
   */
  const fromNews = cat && cat.source !== 'technical';
  if (fromNews && (cat.sentiment === 'bull' || cat.sentiment === 'bear') && !cat.stale) {
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

  const ctxDir = contextBias(ctx);
  if (ctxDir) return { bias: ctxDir, source: 'context', reason: 'trend/sector context' };

  // Nothing said anything. That is an answer, and a more useful one than a
  // coin-flip dressed as a read.
  return { bias: null, source: 'none', reason: 'no directional evidence' };
}

module.exports = { resolveAutoBias, contextBias };
