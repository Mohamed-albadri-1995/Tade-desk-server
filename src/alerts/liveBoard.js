/*
 * THE LIVE BOARD — TODAY'S TRADES, BY ACCOUNT, EACH ON ONE LINE.
 *
 * Asked for 2026-09-24: "a summary of the open and closed positions today —
 * setup, account, side, symbol, shares, SL, TP, the last time it was
 * monitored — clear visually, an organised hierarchy but not confusing."
 *
 * ONE HIERARCHY: ACCOUNT → TRADE. The account is where the money is, so it is
 * the top level; the setup, side and status are columns on the trade, not more
 * levels to click through.
 *
 * Four records, each the authority on one thing:
 *
 *   the ledger     what the desk SENT: setup, side, planned entry, SL, TP, and
 *                  every order that was not sent and why
 *   Alpaca fills   what actually FILLED: real entry and exit, shares, open or
 *                  closed (journalTrades.tradesFrom pairs fills into trades)
 *   heldNow        what is held NOW and what it is worth
 *   the manager    where the stop is now, target legs banked, what the exit is
 *                  waiting for, and when it last looked
 *
 * Nothing is inferred to fill a gap: a field no record answers is null and the
 * page shows "—". Every dependency is injectable.
 */
const { toETDate } = require('../utils/time');

const FILLS_TTL_MS = 30 * 1000;
let fillsCache = { key: null, at: 0, value: null };

const up = s => String(s || '').toUpperCase();
const sideOf = (sig) => (/^(short|sell)/i.test(String(sig || '')) ? 'short' : 'long');

/** Alpaca round trips for today, per readable account — cached 30 s. */
async function alpacaTrades(date, deps = {}) {
  if (deps.alpacaTrades) return deps.alpacaTrades(date);
  const key = date;
  if (fillsCache.key === key && Date.now() - fillsCache.at < FILLS_TTL_MS) return fillsCache.value;
  const reconcile = require('../broker/reconcile');
  const alpaca = require('../alpaca/account');
  const { tradesFrom } = require('../broker/journalTrades');
  const scope = reconcile.credentialScope();
  const trades = [];
  const problems = scope.blind.length ? [scope.reason] : [];
  const after = new Date(`${date}T04:00:00-04:00`).toISOString();
  for (const id of scope.readable) {
    const { creds, error } = reconcile.credsForDest(id);
    if (error) { problems.push(error); continue; }
    const r = await alpaca.fills({ after, account: creds, timeoutMs: 8000 });
    if (!r.ok) { problems.push(`${id}: ${r.error}`); continue; }
    trades.push(...tradesFrom(r.fills, id).filter(t => t.date === date));
  }
  const value = { trades, problems, readable: scope.readable };
  fillsCache = { key, at: Date.now(), value };
  return value;
}

async function board({ date } = {}, deps = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : toETDate(Date.now());
  const notes = [];
  const broker = deps.broker || require('../broker/signalstack');
  const sessionLog = deps.sessionLog || require('../setups/sessionLog');

  const dests = (() => { try { return broker.destinations(); } catch { return []; } })();
  const nameOf = id => ((dests.find(d => d.id === id) || {}).name) || id || 'unknown account';
  const modeOf = id => ((dests.find(d => d.id === id) || {}).mode) || null;

  let setupNames = {};
  try {
    const list = deps.setups ? await deps.setups() : await require('../setups/catalog').list();
    for (const s of list || []) {
      setupNames[s.id] = s.name;
      for (const sid of s.strategyIds || []) setupNames[sid] = s.name;
    }
  } catch { setupNames = {}; }

  let ledger = [];
  try { ledger = broker.orders(day); } catch (e) { notes.push(`the ledger could not be read: ${e.message}`); }

  let fills = { trades: [], problems: [], readable: [] };
  try { fills = await alpacaTrades(day, deps); } catch (e) { notes.push(`fills: ${e.message}`); }
  notes.push(...(fills.problems || []));

  let held = { ok: false, positions: [] };
  try { held = deps.held ? await deps.held() : await require('../broker/reconcile').heldNow(); }
  catch (e) { notes.push(`positions: ${e.message}`); }
  if (held && !held.ok && held.reason) notes.push(`positions: ${held.reason}`);

  let pass = null;
  try { const ps = sessionLog.passesOn(day); pass = ps[ps.length - 1] || null; } catch { pass = null; }

  // ── one row per (account, symbol): the desk's first send is the plan ──
  const rows = new Map();
  const keyOf = (acct, sym) => `${acct || '?'}|${up(sym)}`;
  const entries = ledger.filter(o => !o.kind && o.symbol && o.signal);
  for (const o of entries) {
    const k = keyOf(o.destination, o.symbol);
    const was = rows.get(k);
    if (was && was.sent) continue;                       // the first SENT one is the plan
    rows.set(k, {
      account: o.destination || null, symbol: up(o.symbol), side: sideOf(o.signal),
      setupId: o.setupId || null, setup: setupNames[o.setupId] || o.setupId || null,
      plannedEntry: o.price ?? null, sl: o.stop ?? null, tp: o.target ?? null,
      sentAt: o.at || null, sent: !!o.sent, shares: o.sent ? (o.quantity ?? null) : null,
      notSent: o.sent ? null : (o.error || o.skipped || 'not sent'),
      notSentLevel: o.error ? 'error' : 'warn',
    });
  }
  // ── what filled: Alpaca's round trips ──
  for (const t of fills.trades || []) {
    const k = keyOf(t.account, t.ticker);
    const r = rows.get(k) || {
      account: t.account, symbol: up(t.ticker), side: t.direction === -1 || /short/i.test(t.direction) ? 'short' : 'long',
      setupId: null, setup: 'not placed by the desk', plannedEntry: null, sl: null, tp: null,
      sentAt: null, sent: true, shares: null, notSent: null,
    };
    r.entry = t.entryPrice; r.entryTime = t.entryTime;
    r.exit = t.exitPrice; r.exitTime = t.exitTime;
    r.shares = t.shares ?? r.shares;
    r.filled = true;
    r.closedAtBroker = t.status === 'closed';
    rows.set(k, r);
  }
  // ── how it closed: the desk's close orders ──
  for (const o of ledger.filter(x => x.kind === 'flatten')) {
    const r = rows.get(keyOf(o.destination, o.symbol));
    if (!r) continue;
    r.closeReason = o.source || null;
    r.closeAt = o.at || null;
    if (!o.sent) r.closeProblem = o.error || o.skipped || 'close not sent';
  }
  // ── what is held now ──
  const heldRows = (held && held.positions) || [];
  for (const p of heldRows) {
    const k = keyOf(p.account, p.symbol);
    const r = rows.get(k) || {
      account: p.account, symbol: up(p.symbol), side: /short/i.test(p.side) || p.qty < 0 ? 'short' : 'long',
      setupId: null, setup: 'not placed by the desk today', sent: true, notSent: null,
    };
    r.heldNow = true;
    r.now = p.current ?? null;
    r.unrealised = p.unrealised ?? null;
    r.shares = Math.abs(Number(p.qty)) || r.shares;
    r.entry = r.entry ?? p.avgEntry ?? null;
    rows.set(k, r);
  }
  // ── the manager's last look ──
  for (const x of (pass && pass.positions) || []) {
    for (const r of rows.values()) {
      if (r.symbol !== up(x.symbol)) continue;
      r.stopNow = x.stop ?? null;
      r.stopMoved = !!x.stopMoved;
      r.legsBanked = x.legsBanked || 0;
      r.waitingFor = x.waitingFor || null;
      r.managerError = x.error || null;
      // The stop resting at Alpaca, when this pass moved it or could not.
      r.brokerStop = x.brokerStop || null;
      r.checkedAt = pass.at || null;
    }
  }

  // ── status and money, decided once, here ──
  for (const r of rows.values()) {
    const sign = r.side === 'short' ? -1 : 1;
    if (!r.sent) r.status = 'not sent';
    else if (r.heldNow) r.status = 'open';
    else if (r.closedAtBroker || r.closeAt) r.status = 'closed';
    else if (r.filled) r.status = 'open';
    else if (held && held.ok) r.status = 'no fill';
    else r.status = 'unknown';
    if (r.status === 'open') {
      r.pnl = r.unrealised ?? ((r.now != null && r.entry != null && r.shares)
        ? (r.now - r.entry) * r.shares * sign : null);
    } else if (r.status === 'closed' && r.exit != null && r.entry != null && r.shares) {
      r.pnl = (r.exit - r.entry) * r.shares * sign;
    } else {
      r.pnl = null;
    }
    if (r.pnl != null) r.pnl = Math.round(r.pnl * 100) / 100;
    r.pnlPct = (r.pnl != null && r.entry && r.shares)
      ? Math.round((r.pnl / (r.entry * r.shares)) * 10000) / 100 : null;
  }

  // ── account → trades ──
  const ORDER = { open: 0, closed: 1, 'no fill': 2, 'not sent': 3, unknown: 4 };
  const byAcct = new Map();
  for (const r of rows.values()) {
    const id = r.account || 'unknown';
    if (!byAcct.has(id)) byAcct.set(id, []);
    byAcct.get(id).push(r);
  }
  const accounts = [...byAcct.entries()].map(([id, trades]) => {
    trades.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || ((a.sentAt || 0) - (b.sentAt || 0)));
    const sum = (st) => trades.filter(t => t.status === st && t.pnl != null)
      .reduce((s, t) => s + t.pnl, 0);
    return {
      id, name: nameOf(id), mode: modeOf(id),
      open: trades.filter(t => t.status === 'open').length,
      closed: trades.filter(t => t.status === 'closed').length,
      openPnl: Math.round(sum('open') * 100) / 100,
      closedPnl: Math.round(sum('closed') * 100) / 100,
      trades,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { ok: true, date: day, at: Date.now(), accounts,
           managerAt: pass ? pass.at : null, notes };
}

module.exports = { board, sideOf };
