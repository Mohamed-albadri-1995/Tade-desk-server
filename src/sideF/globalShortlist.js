/*
 * The shortlist across every tool.
 *
 * Nine tools each keep their own shortlist, which is right — each is a separate
 * experiment. But the trader is one person with one screen and one account, and
 * a name that three different tools independently picked is a different
 * proposition from one that only appeared on a single list. That is worth
 * seeing without opening nine tabs.
 *
 * So: anything shortlisted anywhere is on the unified list, by design. There is
 * nothing to opt into and no separate list to maintain — a tool publishes its
 * shortlist whenever it changes, and the union is what everyone reads.
 *
 * Same shape as the CANSLIM share, and for the same reasons:
 *
 *   - It is a VIEW, never a filter. No tool's screeners, scores or registers
 *     change because of what another tool shortlisted.
 *   - Every tool writes only its own entry; a reader that cannot find or parse
 *     the file simply sees fewer tools rather than failing.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = process.env.GLOBAL_SHORTLIST_FILE
  || path.join(path.dirname(config.dbPath), 'shortlist-all.json');

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.tools ? raw : { tools: {} };
  } catch {
    return { tools: {} };
  }
}

function writeAll(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Write-then-rename so a reader mid-scan never sees half a file.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
    return true;
  } catch (err) {
    console.warn('[Shortlist] could not publish:', err.message);
    return false;
  }
}

/**
 * Publish this tool's shortlist for a date.
 *
 * Called on every change — the auto-rule, a manual toggle — so the unified list
 * is never behind. Only this tool's own key is touched, so two tools publishing
 * at the same moment cannot lose each other's entries beyond the last write,
 * and the next change restores it.
 */
function publish(date, items) {
  const state = readAll();
  state.tools = state.tools || {};
  state.tools[config.toolId] = {
    name: config.toolName,
    date,
    updatedAt: Date.now(),
    tickers: (items || []).map(i => String(i.ticker || i).toUpperCase()),
  };
  state.updatedAt = Date.now();
  writeAll(state);
  return { published: (items || []).length };
}

/**
 * The union for a date: every ticker any tool shortlisted, with who picked it.
 *
 * Sorted by how many tools agreed, because that is the question the unified
 * list exists to answer. Entries from other dates are ignored rather than
 * merged — yesterday's shortlist is not today's.
 */
function union(date) {
  const state = readAll();
  const byTicker = new Map();
  for (const [toolId, entry] of Object.entries(state.tools || {})) {
    if (!entry || entry.date !== date) continue;
    for (const ticker of entry.tickers || []) {
      if (!byTicker.has(ticker)) byTicker.set(ticker, { ticker, tools: [] });
      byTicker.get(ticker).tools.push({ id: toolId, name: entry.name || toolId });
    }
  }
  return [...byTicker.values()]
    .map(r => ({ ...r, count: r.tools.length }))
    .sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker));
}

/** Map<TICKER, [{id,name}]> — for tagging rows cheaply. */
function membersFor(date) {
  const m = new Map();
  for (const row of union(date)) m.set(row.ticker, row.tools);
  return m;
}

/**
 * Mark rows that any tool has shortlisted.
 *
 * `inShortlist` is left alone — that is this tool's own decision and the model
 * reads it. These fields are additional, so a card can say "I did not shortlist
 * this, but two other tools did" without either claim overwriting the other.
 */
function tagRows(rows, date) {
  const members = membersFor(date);
  let tagged = 0;
  for (const row of rows) {
    const tools = members.get(String(row.ticker || '').toUpperCase());
    const others = (tools || []).filter(t => t.id !== config.toolId);
    row.shortlistedBy = tools ? tools.map(t => t.id) : [];
    row.shortlistedElsewhere = others.length > 0 ? 'yes' : 'no';
    if (tools) tagged++;
  }
  return { tagged, memberCount: members.size };
}

module.exports = { FILE, publish, union, membersFor, tagRows, readAll };
