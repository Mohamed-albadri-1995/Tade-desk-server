#!/usr/bin/env node
/*
 * Does the direction call earn its place?
 *
 * Bias answers "long or short" and nothing in the system has ever checked it
 * against what the stocks did. Three things feed it and only one has been
 * measured: the news layer was audited and fixed, technical catalysts were
 * barred from setting direction after they were shown to run -0.06R against
 * +0.18R for news-sourced ones — but the fallback, the context ladder in
 * bias.js, has never been tested at all. It is eight hand-written rules about
 * short-term trend, sector bias and the long-term view, and every card that has
 * no catalyst gets its direction from them.
 *
 * A rule nobody has measured is a guess with a function name. This measures it.
 *
 *   node scripts/analyse-bias.js            every tool
 *   node scripts/analyse-bias.js T1         one of them
 *   node scripts/analyse-bias.js --entry B  score against the 09:40 entry
 *
 * Read from each tool's r4a_train / r4b_train, which is where the features the
 * call was made from and the outcome that followed sit in the same row. No
 * network, no writes.
 *
 * WHAT "RIGHT" MEANS HERE. Each row carries upR and downR — how far the stock
 * ran in favour and against, in units of its own ATR, from that entry. A long
 * call is right when upR beats downR. That is a deliberately weak test: it asks
 * whether the direction was the better side to be on, not whether the trade
 * made money. Expectancy is reported beside it, because a call that is right
 * 55% of the time and loses money is a different object from one that is right
 * 55% of the time and makes money, and only the second is worth keeping.
 *
 * THE COMPARISON THAT MATTERS is not 50%. It is what you would have got by
 * always saying long, which on a screener that mostly finds stocks going up is
 * a genuinely hard number to beat. A ladder that scores 58% against an
 * always-long baseline of 61% is worse than having no ladder.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const only = args.find(a => /^T\d+$/i.test(a));
const entryIdx = args.indexOf('--entry');
const ENTRY = (entryIdx >= 0 && (args[entryIdx + 1] || '').toUpperCase() === 'B') ? 'B' : 'A';

const { contextBias } = require('../src/sideC/bias');

const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8')).tools;

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));

/*
 * One row's features and outcome.
 *
 * The stored shape has changed over the project's life, and the training rows
 * are flat rather than nested, so read both spellings rather than assuming —
 * a reader that looked in the wrong place would report a clean 0-for-0 and
 * look like an answer.
 */
function readRow(blob) {
  const d = blob || {};
  const ctx = {
    shortTerm: d.shortTerm ?? d.context?.shortTerm ?? null,
    secBias: d.secBias ?? d.context?.secBias ?? null,
    longTerm: d.longTerm ?? d.context?.longTerm ?? null,
  };
  const up = num(d[`upR_${ENTRY}`] ?? d.upR);
  const down = num(d[`downR_${ENTRY}`] ?? d.downR);
  return { ctx, up, down, catalyst: d.catalyst || null, ticker: d.ticker, date: d.date };
}

/** Was this direction the better side to be on, and by how much? */
function judge(dir, up, down) {
  if (dir !== 'long' && dir !== 'short') return null;
  const favour = dir === 'long' ? up : down;
  const against = dir === 'long' ? down : up;
  return { right: favour > against, edge: favour - against };
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '  — ');
const r2 = v => (v >= 0 ? '+' : '') + v.toFixed(2);

/** Wilson interval — a percentage from 30 rows needs its width shown beside it. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

function summarise(label, rows, dirOf) {
  const scored = [];
  for (const r of rows) {
    if (r.up === null || r.down === null) continue;
    const dir = dirOf(r);
    const j = judge(dir, r.up, r.down);
    if (j) scored.push(j);
  }
  if (!scored.length) return { label, n: 0 };
  const right = scored.filter(s => s.right).length;
  const edge = scored.reduce((a, s) => a + s.edge, 0) / scored.length;
  const [lo, hi] = wilson(right, scored.length);
  return { label, n: scored.length, right, edge, lo, hi };
}

function line(s, baseline) {
  if (!s.n) return `  ${s.label.padEnd(30)}      no rows`;
  const band = `${(s.lo * 100).toFixed(0)}–${(s.hi * 100).toFixed(0)}%`;
  // Against the baseline, not against 50%. A ladder that cannot beat "always
  // long" is costing effort to arrive somewhere worse than a constant.
  const vs = baseline && baseline.n
    ? (s.right / s.n > baseline.right / baseline.n ? ' better than always-long'
      : s.right / s.n < baseline.right / baseline.n ? ' WORSE than always-long' : ' same as always-long')
    : '';
  return `  ${s.label.padEnd(30)} ${String(s.n).padStart(5)} rows`
    + `  ${pct(s.right, s.n)} right (95%: ${band.padStart(9)})`
    + `  edge ${r2(s.edge)}R${vs}`;
}

function analyse(t) {
  const dbPath = path.join(ROOT, 'data', `${t.id.toLowerCase()}.db`);
  const legacy = path.join(ROOT, 'data', 'tradedesk.db');
  const file = fs.existsSync(dbPath) ? dbPath
    : (t.id === 'T1' && fs.existsSync(legacy) ? legacy : null);
  if (!file) return null;

  const db = new Database(file, { readonly: true });
  const table = ENTRY === 'B' ? 'r4b_train' : 'r4a_train';
  let raw = [];
  try { raw = db.prepare(`SELECT date, ticker, data FROM ${table}`).all(); } catch { db.close(); return null; }
  db.close();

  const rows = [];
  for (const r of raw) {
    let blob;
    try { blob = JSON.parse(r.data); } catch { continue; }
    const row = readRow(blob);
    row.date = row.date || r.date;
    row.ticker = row.ticker || r.ticker;
    rows.push(row);
  }
  const usable = rows.filter(r => r.up !== null && r.down !== null);
  if (!usable.length) return null;

  console.log(`\n${t.id} · ${t.name}   ${usable.length} of ${rows.length} rows have an outcome`);

  const alwaysLong = summarise('always long (the baseline)', usable, () => 'long');
  console.log(line(alwaysLong));
  console.log(line(summarise('always short', usable, () => 'short'), alwaysLong));

  // The thing actually under test.
  const ladder = summarise('the context ladder', usable, r => contextBias(r.ctx));
  console.log(line(ladder, alwaysLong));

  // …and what it is made of. If one signal carries it, the other two are
  // decoration; if none of them does, the ladder is decoration.
  console.log('  — the individual signals —');
  for (const [name, key] of [['short-term trend', 'shortTerm'], ['sector bias', 'secBias'], ['long-term view', 'longTerm']]) {
    const s = summarise(`  follow ${name}`, usable, r => {
      const v = r.ctx[key];
      return v === 'BULLISH' ? 'long' : v === 'BEARISH' ? 'short' : null;
    });
    console.log(line(s, alwaysLong));
  }

  // How often the ladder declines to answer at all — after the change that
  // stopped it defaulting to long, silence is a real and frequent outcome.
  const silent = usable.filter(r => contextBias(r.ctx) === null).length;
  console.log(`  says nothing on ${silent} of ${usable.length} rows (${pct(silent, usable.length)})`);

  return { id: t.id, ladder, alwaysLong };
}

console.log(`DIRECTION CALL — measured against entry ${ENTRY} (${ENTRY === 'A' ? '09:37' : '09:40'})`);
console.log('"right" = the chosen side ran further than the other. edge = that gap, in ATRs.');
console.log('Beat the always-long baseline or the ladder is not paying for itself.');

const all = [];
for (const t of tools) {
  if (only && t.id.toUpperCase() !== only.toUpperCase()) continue;
  const r = analyse(t);
  if (r) all.push(r);
}

if (!all.length) {
  console.log('\nNo tool has outcomes yet. Come back after the collection run.\n');
} else {
  const n = all.reduce((a, x) => a + x.ladder.n, 0);
  const beat = all.filter(x => x.ladder.n && x.alwaysLong.n
    && x.ladder.right / x.ladder.n > x.alwaysLong.right / x.alwaysLong.n).length;
  console.log(`\nAcross ${all.length} tool(s): the ladder beats always-long on ${beat}.`);
  if (n < 200) {
    // Said plainly, because the temptation with a fresh number is to act on it.
    console.log(`Only ${n} scored rows. At this size a five-point difference is noise;`);
    console.log('this run says which way to look, not what to change.');
  }
}
console.log('');
