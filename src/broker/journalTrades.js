/*
 * Alpaca's fills, paired back into trades a journal can hold.
 *
 * WHY. The journal's only ways in were a pasted CSV and typing. So a day the
 * desk traded automatically produced no journal entry at all unless somebody
 * exported a file and imported it by hand — and the one thing the journal is
 * for is being complete. Its own status line said "Alpaca — connected, 3 names
 * filled today" above a page reading "0 trades", which is the whole problem in
 * one screen.
 *
 * A FILL IS NOT A TRADE, and that is the entire difficulty here. Alpaca reports
 * prints: `sell_short 270 WULF @ 15.26`, `sell_short 271 @ 15.25`, `buy 270 @
 * 14.64`. A journal row is a round trip — one entry, one exit, a direction and a
 * result. Turning one into the other means tracking the running position and
 * cutting a trade where it returns to FLAT:
 *
 *     position 0 → non-zero    a trade opens; its direction is the first fill's
 *     position moves further   more entries; the entry price is the weighted
 *                              average, which is what was actually paid
 *     position → 0             the trade closes, and the exit price is the
 *                              weighted average of everything that closed it
 *     position crosses 0       TWO trades: one closed at flat, one opened the
 *                              other way. A reversal is not one trade.
 *
 * WEIGHTED, never the first or the last print. A 541-share short filled in two
 * prints at 15.26 and 15.25 entered at neither of them, and a scale-out exits at
 * neither of its legs. Anything else and the journal's P&L disagrees with the
 * account's, which makes the journal worthless for the one thing it is for.
 *
 * STILL-OPEN TRADES ARE INCLUDED, marked open with no exit. A position taken
 * this morning and still on at noon is a real trade and the journal should show
 * it; leaving it out until it closes is how a day looks quiet while it is not.
 *
 * ALPACA ONLY. TTP5k is behind TraderEvolution with no fill feed, so a trade
 * taken there is not here and every caller says so.
 */

const { toETDate } = require('../utils/time');

/** New York, because a session belongs to a date there and not in UTC. */
function etParts(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return { date: null, time: null, at: 0 };
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(at));
  return { date: toETDate(at), time, at };
}

/** Alpaca signs a side by name; a journal wants +1 / -1. */
function signOf(side) {
  return String(side || '').toLowerCase().startsWith('buy') ? 1 : -1;
}

const round = (n, dp = 4) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Pair a list of fills into round-trip trades.
 *
 * `fills` is what src/alpaca/account.js returns: { id, symbol, side, qty,
 * price, at }. Order does not matter — they are sorted here, because activities
 * come back paged and a page boundary is not a chronology.
 */
function tradesFrom(fills = []) {
  const bySymbol = new Map();
  for (const f of fills) {
    const sym = String(f.symbol || '').toUpperCase();
    if (!sym || !(Number(f.qty) > 0)) continue;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push(f);
  }

  const out = [];
  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));

    let open = null;          // the trade being built
    let position = 0;         // signed shares held

    for (const f of list) {
      const sign = signOf(f.side);
      let qty = Math.abs(Number(f.qty));
      const price = Number(f.price);
      if (!(qty > 0) || !(price > 0)) continue;

      while (qty > 0) {
        /*
         * A REVERSAL IS TWO TRADES. A fill big enough to flatten a short AND
         * open a long is split at the flat point: everything up to zero closes
         * the first trade, the remainder opens the second. Treating it as one
         * would produce a trade whose direction changed halfway through and
         * whose P&L is meaningless.
         */
        const closing = position !== 0 && Math.sign(position) !== sign;
        const take = closing ? Math.min(qty, Math.abs(position)) : qty;

        if (closing) {
          open.exitQty += take;
          open.exitCost += take * price;
          open.exitAt = f.at;
        } else {
          if (!open) {
            const { date, time, at } = etParts(f.at);
            open = {
              // Stable across re-imports: the first fill of a trade identifies
              // it for good, so importing the same day twice is a no-op rather
              // than a second copy.
              extId: `alpaca:${f.id || `${symbol}:${at}`}`,
              symbol, date, entryTime: time, entryAt: at,
              direction: sign > 0 ? 'Long' : 'Short',
              entryQty: 0, entryCost: 0, exitQty: 0, exitCost: 0, exitAt: null,
              fills: 0,
            };
          }
          open.entryQty += take;
          open.entryCost += take * price;
        }
        open.fills += 1;
        position += sign * take;
        qty -= take;

        // Back to flat: the trade is finished, whatever comes next.
        if (position === 0 && open) { out.push(finish(open)); open = null; }
      }
    }
    // Still holding at the end of the window. A real trade, and not a result.
    if (open) out.push(finish(open));
  }

  return out.sort((a, b) => (a.entryAt || 0) - (b.entryAt || 0));
}

function finish(t) {
  const entryPrice = t.entryQty ? t.entryCost / t.entryQty : null;
  const exitPrice = t.exitQty ? t.exitCost / t.exitQty : null;
  const closed = t.exitQty > 0 && t.exitQty >= t.entryQty;
  const ex = t.exitAt ? etParts(t.exitAt) : null;
  return {
    extId: t.extId,
    date: t.date,
    ticker: t.symbol,
    direction: t.direction,
    shares: t.entryQty,
    entryPrice: round(entryPrice),
    entryTime: t.entryTime,
    /*
     * ONLY WHEN IT IS ACTUALLY CLOSED. A half-closed position has an exit price
     * that is not a result — it is a fragment that reads like one — so it goes
     * out as open, with the partial exit left for the account to finish.
     */
    exitPrice: closed ? round(exitPrice) : null,
    exitTime: closed && ex ? ex.time : null,
    status: closed ? 'closed' : 'open',
    fills: t.fills,
    source: 'alpaca',
  };
}

module.exports = { tradesFrom, etParts, signOf };
