/**
 * CSV Importer — supported formats:
 *   - TradingView fills export (comma, symbol/side/qty headers)
 *   - TTP (Trade the Pool) orders history
 *   - DXtrade orders history (semicolon-delimited)
 *   - TradingView paper trading log (Time,Text narrative)
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

function detectDelimiter(firstLine) {
  const semis  = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semis > commas ? ';' : ',';
}

function detectFormat(headers, delim) {
  const h = headers.map(x => x.toLowerCase().replace(/[^a-z]/g, ''));
  if (delim === ';' && h.includes('symbol') && h.includes('side') && h.includes('event')) return 'dxtrade';
  if (h.includes('datetime') && h.includes('orderid') && h.includes('event')) return 'ttporders';
  if (h.includes('symbol') && h.includes('side') && h.includes('qty')) return 'tv';
  if (h.includes('action') && h.includes('shares')) return 'ttp';
  if (h.length === 2 && h.includes('time') && h.includes('text')) return 'tvlog';
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
  // YYYY-MM-DD HH:MM[:SS]
  let m = combined.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const utc = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}Z`).getTime();
    return utc + etOffsetMs(`${m[1]}-${m[2]}-${m[3]}`);
  }
  // MM/DD/YYYY HH:MM[:SS] (US style)
  m = combined.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const date = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    const utc  = new Date(`${date}T${m[4]}:${m[5]}:${m[6]||'00'}Z`).getTime();
    return utc + etOffsetMs(date);
  }
  return null;
}

// DD/MM/YYYY HH:MM:SS AM/PM  (DXtrade format)
function parseDxDateTime(raw) {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hr = parseInt(m[4]);
  const isPM = m[7].toUpperCase() === 'PM';
  if (isPM && hr !== 12) hr += 12;
  if (!isPM && hr === 12) hr = 0;
  const date = `${m[3]}-${m[2]}-${m[1]}`;
  const utc  = new Date(`${date}T${String(hr).padStart(2,'0')}:${m[5]}:${m[6]}Z`).getTime();
  return utc + etOffsetMs(date);
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

/**
 * DXtrade orders history (semicolon-delimited).
 * Headers: Date/Time;Account;Symbol;Side;Order ID;Type;Price;Stop price;Quantity;Event;...
 * Only processes rows where Event=Filled and Type in {Market, Stop loss, Take profit}.
 * Market+Filled = entry. Stop loss/Take profit+Filled = exit.
 * Side reflects the order side, NOT the position direction — need to infer direction from first fill.
 */
function parseDxtrade(lines, headers) {
  const h = {};
  headers.forEach((hdr, i) => { h[hdr.toLowerCase().replace(/[^a-z\/\s]/g,'').trim()] = i; });

  // find column indices by flexible matching
  const col = name => {
    const key = Object.keys(h).find(k => k.includes(name));
    return key != null ? h[key] : -1;
  };

  const iDt       = col('date');
  const iSymbol   = col('symbol');
  const iSide     = col('side');
  const iType     = col('type');
  const iPrice    = col('price');
  const iStopPrice= col('stop');
  const iQty      = col('quantity');
  const iEvent    = col('event');

  const fills = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i], ';');
    if (c.length < 9) continue;
    const event = (c[iEvent] || '').trim().toLowerCase();
    if (event !== 'filled') continue;

    const type = (c[iType] || '').trim().toLowerCase();
    const isEntry = type === 'market';
    const isExit  = type === 'stop loss' || type === 'take profit';
    if (!isEntry && !isExit) continue;

    const ts = parseDxDateTime(c[iDt] || '');
    if (!ts) continue;

    const rawSide = (c[iSide] || '').trim().toLowerCase();  // buy or sell
    const qty = parseFloat((c[iQty] || '').replace(/,/g, '')) || 0;
    const rawPrice = parseFloat((c[iPrice] || '').replace(/,/g, '')) || 0;
    const stopPrice = parseFloat((c[iStopPrice] || '').replace(/,/g, '')) || 0;
    const price = (isExit && stopPrice > 0) ? stopPrice : rawPrice;

    // For DXtrade: Market buy = long entry, Market sell = short entry
    // Exit side is opposite of entry side
    let side;
    if (isEntry) {
      side = rawSide === 'buy' ? 'buy' : 'sell_short';
    } else {
      // Stop loss / Take profit — exit
      side = rawSide === 'buy' ? 'buy_cover' : 'sell';
    }

    fills.push({
      ticker: (c[iSymbol] || '').replace(/^[A-Z]+:/, '').toUpperCase(),
      ts, side, shares: qty, price, commission: 0,
    });
  }
  return fills;
}

/**
 * TradingView paper trading log (Time,Text narrative).
 * Parses lines like:
 *   "2026-06-05 19:43:40,Order 3149586192 for symbol NYSE:HPE has been executed at price 49.15 for 695.1 units"
 *   "2026-06-05 19:43:40,Call to place market order to buy 300 units of symbol NYSE:HPE"
 * We use executed lines only (they have actual fill prices).
 */
function parseTvLog(lines) {
  // executed order pattern: "Order NNN for symbol EX:SYM has been executed at price PP.PP for QQ units"
  const execRe = /order\s+\d+\s+for\s+symbol\s+(?:[A-Z]+:)?([A-Z]+)\s+has been executed at price\s+([\d.]+)\s+for\s+([\d.]+)\s+units/i;
  // call to place pattern: "Call to place market order to (buy|sell|sell short) NNN units of symbol EX:SYM"
  const callRe = /call to place (?:market )?order to (buy|sell(?: short)?)\s+([\d.]+)\s+units of symbol\s+(?:[A-Z]+:)?([A-Z]+)/i;

  // We need to pair executed fills with their side. TV log has both "call" and "executed" lines.
  // Strategy: collect all executed lines, then for each scan backwards to find nearest call for same symbol.
  // Simpler: group by order number if possible. TV log doesn't always have order number in call line.
  // Instead: build a side map from call lines (symbol → side queue), then consume for each fill.

  const sideQueues = {}; // symbol → [{side, shares}]

  const fills = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Split on first comma only (timestamp is before first comma)
    const commaIdx = line.indexOf(',');
    if (commaIdx < 0) continue;
    const timeStr = line.slice(0, commaIdx).trim();
    const text = line.slice(commaIdx + 1).trim();

    // Check call-to-place (queue side info)
    const callMatch = text.match(callRe);
    if (callMatch) {
      const sideRaw = callMatch[1].toLowerCase();
      const shares  = parseFloat(callMatch[3]) || 0;
      const sym     = callMatch[4].toUpperCase();
      const side = sideRaw === 'buy' ? 'buy'
                 : sideRaw === 'sell short' ? 'sell_short'
                 : 'sell';
      if (!sideQueues[sym]) sideQueues[sym] = [];
      sideQueues[sym].push({ side, shares });
      continue;
    }

    // Check executed fill
    const execMatch = text.match(execRe);
    if (execMatch) {
      const sym    = execMatch[1].toUpperCase();
      const price  = parseFloat(execMatch[2]) || 0;
      const shares = parseFloat(execMatch[3]) || 0;
      const ts     = parseDateTime(timeStr);
      if (!ts || !price || !shares) continue;

      // Find matching side from queue
      let side = 'buy'; // fallback
      const q = sideQueues[sym];
      if (q && q.length > 0) {
        // find best match by shares (may have partial fills)
        const idx = q.findIndex(e => Math.abs(e.shares - shares) / shares < 0.01);
        if (idx >= 0) {
          side = q[idx].side;
          q.splice(idx, 1);
        } else {
          side = q.shift().side;
        }
      }

      fills.push({ ticker: sym, ts, side, shares, price, commission: 0 });
    }
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
  const delim   = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delim);
  const format  = detectFormat(headers, delim);
  if (!format) throw new Error('Unknown CSV format. Supported: TradingView fills, TTP, DXtrade, TradingView paper log.');

  let fills;
  if      (format === 'tv')         fills = parseTv(lines, headers);
  else if (format === 'ttp')        fills = parseTtp(lines, headers);
  else if (format === 'ttporders')  fills = parseTtp(lines, headers);
  else if (format === 'dxtrade')    fills = parseDxtrade(lines, headers);
  else if (format === 'tvlog')      fills = parseTvLog(lines);
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
