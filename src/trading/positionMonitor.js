/**
 * Position Monitor
 *
 * Watches the bar stream and auto-closes any open position whose SL or
 * TP was touched during the current bar. Used in paper / testing modes
 * where nothing is actually submitted to a broker.
 *
 * In live mode with a real broker connection, the broker's fill events
 * would drive the close instead — this module is a paper-mode stand-in.
 */

const db     = require('../db');
const router = require('./router');

function _openPositionsFor(ticker) {
  return db
    .prepare("SELECT * FROM trading_positions WHERE status = 'open' AND ticker = ?")
    .all(String(ticker).toUpperCase());
}

/**
 * Called by the bar poller after each new bar arrives for a ticker.
 * Closes positions whose SL or TP was touched during this bar.
 *
 * Convention: if a bar touches both SL and TP in the same minute we
 * assume the SL fired first (worst-case, conservative for paper).
 */
function checkBar(ticker, bar) {
  if (!bar || !Number.isFinite(bar.h) || !Number.isFinite(bar.l)) return;
  const positions = _openPositionsFor(ticker);
  if (positions.length === 0) return;

  for (const pos of positions) {
    let exitPrice = null;
    let exitReason = null;

    if (pos.direction === 'Long') {
      // Longs hit their stop when low touches SL, target when high touches TP.
      const stopHit   = pos.sl != null && bar.l <= pos.sl;
      const targetHit = pos.tp != null && bar.h >= pos.tp;
      if (stopHit)        { exitPrice = pos.sl; exitReason = 'stop';   }
      else if (targetHit) { exitPrice = pos.tp; exitReason = 'target'; }
    } else {
      // Shorts: stop above entry (bar.h touches SL), target below (bar.l touches TP).
      const stopHit   = pos.sl != null && bar.h >= pos.sl;
      const targetHit = pos.tp != null && bar.l <= pos.tp;
      if (stopHit)        { exitPrice = pos.sl; exitReason = 'stop';   }
      else if (targetHit) { exitPrice = pos.tp; exitReason = 'target'; }
    }

    if (exitPrice != null) {
      try {
        router.closePosition(pos.id, exitPrice, exitReason);
        console.log(`[PositionMonitor] Auto-closed ${pos.ticker} @ $${exitPrice} (${exitReason})`);
      } catch (err) {
        console.warn('[PositionMonitor] Close failed:', err.message);
      }
    }
  }
}

module.exports = { checkBar };
