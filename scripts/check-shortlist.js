#!/usr/bin/env node
/*
 * Why is the unified shortlist empty when the tools' own shortlists are not?
 *
 *   node scripts/check-shortlist.js
 *
 * The unified list is not a query across nine databases. Each tool WRITES its
 * own shortlist into one shared file whenever that shortlist changes, and the
 * landing page READS the union out of that file. So there are four separate
 * places the chain can break, and from the browser they all look the same —
 * an empty panel:
 *
 *   1. The tool never shortlisted anything (nothing to publish).
 *   2. It shortlisted, but never published — running code from before the
 *      unified list existed, so its rows sit in its own database only.
 *   3. It published under a different date than the one being asked for.
 *   4. It published to a different file, because its DB_PATH points somewhere
 *      else and the file lives next to the database.
 *
 * This reads each tool's own database directly and compares it against the
 * shared file, which tells the four apart in one pass. It only reads.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));

// The same date the server would use. Deliberately recomputed rather than
// imported through config, so a misconfigured tool cannot change the answer.
const { toETDate } = require(path.join(ROOT, 'src', 'utils', 'time'));
const TODAY = process.argv[2] || toETDate(Date.now());

// Mirrors deploy-tools.sh: T1 keeps the original path, the rest are named.
function dbFor(id) {
  return id === 'T1'
    ? path.join(ROOT, 'data', 'tradedesk.db')
    : path.join(ROOT, 'data', `${id.toLowerCase()}.db`);
}

console.log(`date being asked for: ${TODAY}`);
console.log();

// ── what each tool holds in its own database ─────────────────────────────────
console.log('per-tool shortlist, read from each database:');
const inDb = new Map();
for (const t of reg.tools || []) {
  const file = dbFor(t.id);
  if (!fs.existsSync(file)) {
    console.log(`  ${t.id.padEnd(3)} no database at ${path.relative(ROOT, file)}`);
    continue;
  }
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT items FROM shortlist WHERE date = ?').get(TODAY);
    const latest = db.prepare('SELECT date FROM shortlist ORDER BY date DESC LIMIT 1').get();
    db.close();
    const items = row ? JSON.parse(row.items) : [];
    inDb.set(t.id, items.length);
    const tail = row ? items.map(i => i.ticker).join(' ') : `(latest is ${latest ? latest.date : 'none'})`;
    console.log(`  ${t.id.padEnd(3)} ${String(items.length).padStart(2)} today   ${tail}`);
  } catch (err) {
    console.log(`  ${t.id.padEnd(3)} could not read: ${err.message}`);
  }
}

// ── what reached the shared file ─────────────────────────────────────────────
const FILE = process.env.GLOBAL_SHORTLIST_FILE
  || path.join(ROOT, 'data', 'shortlist-all.json');
console.log();
console.log(`shared file: ${path.relative(ROOT, FILE)}`);
if (!fs.existsSync(FILE)) {
  console.log('  DOES NOT EXIST — no tool has ever published.');
  console.log('  Cause 2: the running processes predate the unified list.');
  console.log('  Fix:     bash deploy-tools.sh   (restarts every tool on current code)');
  process.exit(0);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (err) {
  console.log(`  UNREADABLE: ${err.message}`);
  process.exit(1);
}
const stat = fs.statSync(FILE);
console.log(`  last written ${new Date(stat.mtimeMs).toISOString()}`);
console.log();
console.log('published entries:');
const entries = Object.entries(state.tools || {});
if (!entries.length) console.log('  (none)');
for (const [id, e] of entries) {
  const mark = e.date === TODAY ? ' ' : '  ← other date, ignored by the union';
  console.log(`  ${id.padEnd(3)} ${String((e.tickers || []).length).padStart(2)} on ${e.date}`
    + `  updated ${new Date(e.updatedAt || 0).toISOString().slice(0, 16)}${mark}`);
}

// ── the union, and the gap ───────────────────────────────────────────────────
const union = new Set();
for (const [, e] of entries) {
  if (e && e.date === TODAY) for (const t of e.tickers || []) union.add(t);
}
console.log();
console.log(`union for ${TODAY}: ${union.size} tickers  ${[...union].join(' ')}`);

const missing = [...inDb.entries()].filter(([id, n]) => {
  const e = (state.tools || {})[id];
  return n > 0 && (!e || e.date !== TODAY || (e.tickers || []).length !== n);
});

console.log();
if (!missing.length && union.size > 0) {
  console.log('Every tool with a shortlist today has published it. The data is fine —');
  console.log('if the panel is still empty the problem is in the page, not the file:');
  console.log(`  curl -sS "http://127.0.0.1:3000/api/shortlist/all-tools?date=${TODAY}"`);
} else if (!missing.length) {
  console.log('Nothing is shortlisted today on any tool, so the panel is correctly');
  console.log('empty. Star a card on any tool, then run this again — it should appear.');
} else {
  console.log('These tools have a shortlist today that did NOT reach the shared file:');
  for (const [id, n] of missing) console.log(`  ${id} — ${n} in its database`);
  console.log();
  console.log('That is cause 2: those processes are running code from before the');
  console.log('unified list, and only publish on the NEXT change to their shortlist.');
  console.log('Fix: bash deploy-tools.sh');
}
