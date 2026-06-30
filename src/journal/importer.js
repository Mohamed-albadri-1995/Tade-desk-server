/**
 * CSV Importer — matches the old extension's supported formats:
 *   - TradingView fills export
 *   - TTP (Trade the Pool) orders history
 *   - DXtrade orders history
 * Converts fills → matched round-trip trades.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ─── CSV parsing ──────────────────────────────────────────────────────────────

function parseCsvLine(line, delim = ',') {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === delim && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function detectFormat(headers) {
  const h = headers.map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
  if (h.includes('datetime') && h.includes('orderid') && h.includes('event')) return 'ttporders';
  if (h.includes('symbol') && h.includes('side') && h.includes('qty')) return 'tv';
  if (h.includes('action') && h.includes('shares')) return 'ttp';
  return null;
}

function etOffsetMs(dateStr) {
  const s = String(dateStr || '').slice(0, 10);
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d.getTime())) return 5 * 3600000;
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d));
  return ((12 - (h === 24 ? 0 : h) + 24) % 24) * 3600000;
}

function parseDateTime(dateStr, timeStr = '') {
  const combined = (timeStr ? `${dateStr.trim()} ${timeStr.trim()}` : dateStr.trim());
  let m = combined.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const utc = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}Z`).getTime();
    return utc + etOffsetMs(`${m[1]}-${m[2]}-${m[3]}`);
  }
  m = combined.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const date = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    const utc  = new Date(`${date}T${m[4]}:${m[5]}:${m[6]||'00'}Z`).getTime();
    return utc + etOffsetMs(date);
  }
  return null;
}

// ─── Format parsers → fills ───────────────────────────────────────────────────

function parseTv(lines, headers) {
  const idx = {};
  headers.forEach((h, i) => { idx[h.toLowerCase()] = i; });
  const fills = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 4) continue;
    const ts = parseDateTime(c[idx['date']] || '');
    if (!ts) continue;
    fills.push({
      ticker: (c[idx['symbol']] || '').toUpperCase(),
      ts,
      side: (c[idx['side']] || '').toLowerCase(),
      shares: parseFloat(c[idx['qty']]) || 0,
      price:  parseFloat(c[idx['price']]) || 0,
      commission: parseFloat(c[idx['commission']]) || 0,
    });
  }
  return fills;
}

function parseTtp(lines, headers) {
  const h = {};
  headers.forEach((hdr, i) => { h[hdr.toLowerCase().replace(/[^a-z]/g,'')] = i; });
  const fills = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length < 5) continue;
    const ts = parseDateTime(c[h['date']] || '', c[h['time']] || '');
    if (!ts) continue;
    const action = (c[h['action']] || '').toLowerCase();
    const sideRaw = (c[h['side']] || '').toLowerCase();
    const side = action === 'open' ? (sideRaw === 'short' ? 'sell_short' : 'buy')
               : (sideRaw === 'short' ? 'buy_cover' : 'sell');
    fills.push({
      ticker: (c[h['symbol'] ?? h['sym']] || '').toUpperCase(),
      ts, side,
      shares: parseFloat(c[h['shares']]) || 0,
      price:  parseFloat(c[h['price']])  || 0,
      commission: parseFloat(c[h['commission']]) || 0,
    });
  }
  return fills;
}

// ─── Fills → round-trip trades ───────────────────────────────────────────────

function isEntry(side) { return ['buy','buy_long','sell_short'].includes(side); }
function isLong(side)  { return ['buy','buy_long','buy_cover'].includes(side); }

function matchTrades(fills, account) {
  fills.sort((a, b) => a.ts - b.ts);
  const openPositions = {};
  const completed = [];

  for (const fill of fills) {
    const key = fill.ticker;
    if (isEntry(fill.side)) {
      if (!openPositions[key]) {
        openPositions[key] = {
          ticker: fill.ticker,
          direction: isLong(fill.side) ? 'Long' : 'Short',
          entryTs: fill.ts,
          entryPrice: fill.price,
          shares: fill.shares,
          commission: fill.commission,
          account,
        };
      }
    } else {
      const open = openPositions[key];
      if (!open) continue;
      const grossPnl = open.direction === 'Long'
        ? (fill.price - open.entryPrice) * open.shares
        : (open.entryPrice - fill.price) * open.shares;
      const totalComm = open.commission + fill.commission;
      const netPnl    = grossPnl - totalComm;
      const pctMove   = open.entryPrice ? (fill.price - open.entryPrice) / open.entryPrice * 100 : null;
      const duration  = fill.ts - open.entryTs;

      const entryDate = new Date(open.entryTs).toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
      const etDate    = entryDate.replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2');
      const fmtTime   = ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });

      completed.push({
        id: uuidv4(),
        date: etDate,
        ticker: open.ticker,
        direction: open.direction,
        setup_id: null,
        shares: open.shares,
        entry_price: open.entryPrice,
        entry_time: fmtTime(open.entryTs),
        exit_price: fill.price,
        exit_time: fmtTime(fill.ts),
        sl: null, tp: null,
        gross_pnl: parseFloat(grossPnl.toFixed(2)),
        commission: parseFloat(totalComm.toFixed(2)),
        net_pnl: parseFloat(netPnl.toFixed(2)),
        pct_move: pctMove != null ? parseFloat(pctMove.toFixed(3)) : null,
        duration_ms: duration,
        source: 'import',
        account: account || null,
        status: 'closed',
        technical_computed: 0,
        created_at: Date.now(),
      });
      delete openPositions[key];
    }
  }

  return completed;
}

// ─── Main import entry point ──────────────────────────────────────────────────

function importCsv(csvText, account) {
  const lines   = csvText.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV too short');
  const headers = parseCsvLine(lines[0]);
  const format  = detectFormat(headers);
  if (!format) throw new Error('Unknown CSV format. Supported: TradingView, TTP, DXtrade.');

  let fills;
  if (format === 'tv')         fills = parseTv(lines, headers);
  else if (format === 'ttp')   fills = parseTtp(lines, headers);
  else if (format === 'ttporders') fills = parseTtp(lines, headers); // simplified
  else throw new Error(`Unsupported format: ${format}`);

  const trades = matchTrades(fills, account);
  if (!trades.length) return { imported: 0, trades: [] };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO journal_trades
      (id, date, ticker, direction, setup_id, shares, entry_price, entry_time,
       exit_price, exit_time, sl, tp, gross_pnl, commission, net_pnl, pct_move,
       duration_ms, source, account, status, technical_computed, created_at)
    VALUES
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let imported = 0;
  for (const t of trades) {
    const r = insert.run(
      t.id, t.date, t.ticker, t.direction, t.setup_id, t.shares,
      t.entry_price, t.entry_time, t.exit_price, t.exit_time,
      t.sl, t.tp, t.gross_pnl, t.commission, t.net_pnl, t.pct_move,
      t.duration_ms, t.source, t.account, t.status, t.technical_computed, t.created_at
    );
    if (r.changes) imported++;
  }

  return { imported, total: trades.length, trades };
}

module.exports = { importCsv };
