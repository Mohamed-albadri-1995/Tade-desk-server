/*
 * THE BROKER'S STOP FOLLOWS THE STRATEGY'S STOP.
 *
 * A bracket goes to Alpaca with the stop as it was at the entry. The strategy's
 * stop then moves — Test trails it a cent a minute — and until 2026-09-24 only
 * this box knew. It watched the moved stop once a minute on Yahoo bars and sent
 * a close when it saw a hit, which is late by construction: after the bar ends,
 * and after Yahoo stops revising it. EXEL, 2026-09-24: the backtest's stop was
 * hit at 11:36, the box saw it at 11:40. The backtest books the stop price on
 * the bar it is touched; only an order resting AT the broker does that live.
 *
 * So each pass, for each Alpaca account that holds the position, the stop leg
 * of every open bracket on the symbol is moved to the strategy's stop now.
 *
 *   TIGHTEN ONLY. A stop moves toward the price, never away. A trailing stop
 *   in the backtest only ratchets; a qp answer that says otherwise is the
 *   thing to distrust, and a looser stop than the broker already holds is
 *   more risk than anyone asked for.
 *
 *   SAME ROUNDING AS THE ENTRY. signalstack.stopTick, the rule the original
 *   stop was sent with.
 *
 *   NOTHING GETS WORSE ON FAILURE. A PATCH Alpaca refuses leaves the stop it
 *   already had. The once-a-minute check keeps running either way; this is
 *   the faster path, not the only one.
 *
 *   ALPACA ONLY. Trade The Pool is reached through SignalStack, which has no
 *   way to change a resting order — its positions are watched by the minute
 *   check alone, as before, and the answer says so.
 */
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'replaced', 'rejected',
                          'done_for_day', 'stopped', 'suspended', 'calculated']);

function stopLegs(orders, symbol, side) {
  // A long is protected by a SELL stop, a short by a BUY stop.
  const want = side === 'short' ? 'buy' : 'sell';
  const out = [];
  const walk = (o) => {
    if (!o) return;
    if (String(o.symbol || '').toUpperCase() === symbol
        && (o.type === 'stop' || o.type === 'stop_limit')
        && o.side === want && !TERMINAL.has(o.status)
        && Number.isFinite(o.stopPrice)) out.push(o);
    for (const l of o.legs || []) walk(l);
  };
  for (const o of orders || []) walk(o);
  return out;
}

/**
 * @param pos   { symbol, side: 'long'|'short', destinations: [destId] }
 * @param stop  the strategy's stop now (qp manage's `stop_now`)
 * @returns     one row per destination: { dest, moved: [{id, from, to}], kept, skipped, error }
 */
async function syncStop(pos, stop, deps = {}) {
  const broker = deps.broker || require('./signalstack');
  const reconcile = deps.reconcile || require('./reconcile');
  const alpaca = deps.alpaca || require('../alpaca/account');
  const symbol = String(pos.symbol || '').toUpperCase();
  const side = pos.side === 'short' ? 'short' : 'long';
  if (!(Number(stop) > 0)) return [{ dest: null, skipped: 'no stop to move to' }];
  const to = broker.stopTick(stop, side === 'short' ? 'sell' : 'buy');

  const alpacaIds = new Set(reconcile.alpacaDestinations());
  const rows = [];
  for (const dest of pos.destinations || []) {
    if (!alpacaIds.has(dest)) {
      rows.push({ dest, skipped: 'not an Alpaca account — its stop cannot be moved from here; '
        + 'the minute check watches it' });
      continue;
    }
    const { creds, error } = reconcile.credsForDest(dest);
    if (error) { rows.push({ dest, error }); continue; }
    const q = new URLSearchParams({ status: 'open', symbols: symbol, nested: 'true', limit: '100' });
    const r = await alpaca.get(`/v2/orders?${q}`, { timeoutMs: 8000, account: creds });
    if (!r.ok) { rows.push({ dest, error: r.error }); continue; }
    const legs = stopLegs((Array.isArray(r.data) ? r.data : []).map(flat), symbol, side);
    if (!legs.length) { rows.push({ dest, skipped: 'no open stop order at Alpaca' }); continue; }

    const row = { dest, moved: [], kept: 0, errors: [] };
    for (const leg of legs) {
      const tighter = side === 'long' ? to > leg.stopPrice : to < leg.stopPrice;
      if (!tighter) { row.kept += 1; continue; }
      const p = await alpaca.request('PATCH', `/v2/orders/${encodeURIComponent(leg.id)}`,
        { timeoutMs: 8000, account: creds, body: { stop_price: String(to) } });
      if (p.ok) row.moved.push({ id: leg.id, from: leg.stopPrice, to });
      else row.errors.push(p.error);
    }
    if (row.errors.length) row.error = row.errors.join(' · ');
    delete row.errors;
    rows.push(row);
  }
  return rows;
}

/** Alpaca's order JSON → the fields used here, legs included. */
function flat(o) {
  return {
    id: o.id,
    symbol: String(o.symbol || '').toUpperCase(),
    side: o.side,
    type: o.type,
    status: o.status,
    stopPrice: o.stop_price == null ? NaN : Number(o.stop_price),
    legs: Array.isArray(o.legs) ? o.legs.map(flat) : [],
  };
}

/** One line for the log and the Live board, or null when nothing happened. */
function summary(rows) {
  const moved = rows.flatMap(r => (r.moved || []).map(m => ({ ...m, dest: r.dest })));
  const errs = rows.filter(r => r.error).map(r => `${r.dest}: ${r.error}`);
  if (!moved.length && !errs.length) return null;
  const parts = [];
  if (moved.length) {
    parts.push(`broker stop moved ${moved[0].from} → ${moved[0].to}`
      + (moved.length > 1 ? ` (${moved.length} orders)` : ''));
  }
  if (errs.length) parts.push(`could not move the broker stop — ${errs.join(' · ')}`);
  return parts.join('; ');
}

module.exports = { syncStop, stopLegs, summary };
