#!/usr/bin/env node
/*
 * News → catalyst → bias: does the chain earn its place?
 *
 * Three layers stacked on each other. Bias reads the catalyst; the catalyst
 * reads the news; the news is whatever the sources sent. A weakness anywhere
 * propagates upward wearing the confidence of the layer above it, and none of
 * the three has ever been measured against what the stocks actually did.
 *
 * This measures them, from the backups — the only place the cards and the
 * outcomes sit together. It answers three questions and refuses to answer
 * beyond the data:
 *
 *   1. What fraction of delivered news is market roundups — "Top Premarket
 *      Gainers" — which report that a stock moved, a thing the screener
 *      already knew, and say nothing about why.
 *   2. Are catalysts derived from news, or from the screener's own criteria
 *      restated? A "Gap Up" catalyst on a gap screener is not information.
 *   3. Do cards with a catalyst, or with a bias, actually do better? With a
 *      significance test, because a difference across 150 cards in 23 days is
 *      usually noise wearing a percentage sign.
 *
 *   node scripts/analyse-news-chain.js [path-to-backups-dir]
 *
 * Defaults to ../trade-desk-data/backups. Re-run after the collection month;
 * the answers now are directional at best and the script says so.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || path.join(__dirname, '..', '..', 'trade-desk-data', 'backups');
const WIN_R = 1.3;

const ROUNDUP = /most active|stocks? (moving|to watch|making)|market (wrap|open|close)|top (gainers|losers|premarket|midday)|movers|premarket (gainers|decliners)|midday (gainers|decliners)|what to watch|biggest (movers|gainers)|trending|hot stocks|winners and losers/i;

function load() {
  const cards = new Map(), outcomes = new Map();
  let files;
  try {
    files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    console.error(`Cannot read ${DIR}. Pass the backups directory as the first argument.`);
    process.exit(1);
  }
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    const T = (d && d.tables) || {};
    for (const r of T.r1_frozen || []) {
      try { cards.set(`${r.date}|${r.ticker}`, JSON.parse(r.data)); } catch { /* skip */ }
    }
    for (const r of T.r3b || []) outcomes.set(`${r.date}|${r.ticker}`, r);
  }
  return { cards, outcomes, days: files.length };
}

// Two-sided Fisher exact — the sample is far too small for anything that
// assumes a normal distribution, and small samples are exactly where a
// percentage point difference looks like a finding.
function fisher(a, b, c, d) {
  const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const p = (a, b, c, d) => Math.exp(
    lf(a + b) + lf(c + d) + lf(a + c) + lf(b + d) -
    lf(a) - lf(b) - lf(c) - lf(d) - lf(a + b + c + d));
  const p0 = p(a, b, c, d);
  let tot = 0;
  for (let i = 0; i <= Math.min(a + b, a + c); i++) {
    const j = a + b - i, k = a + c - i, l = d - (a - i);
    if (j < 0 || k < 0 || l < 0) continue;
    const pi = p(i, j, k, l);
    if (pi <= p0 + 1e-12) tot += pi;
  }
  return Math.min(1, tot);
}

const mean = (xs) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

function summarise(label, rows) {
  if (!rows.length) return console.log(`  ${label.padEnd(30)} n=  0`);
  const ups = rows.map(r => Number(r.o.up_r_b) || 0);
  const dns = rows.map(r => Number(r.o.down_r_b) || 0);
  const wins = ups.filter(u => u >= WIN_R).length;
  const note = rows.length < 20 ? '  ← too few to read' : '';
  console.log(`  ${label.padEnd(30)} n=${String(rows.length).padStart(3)}  ` +
    `win ${(100 * wins / rows.length).toFixed(1).padStart(5)}%  ` +
    `up ${mean(ups).toFixed(2)}R  down ${mean(dns).toFixed(2)}R  ` +
    `net ${(mean(ups) - mean(dns) >= 0 ? '+' : '')}${(mean(ups) - mean(dns)).toFixed(2)}R${note}`);
  return { wins, losses: rows.length - wins };
}

function main() {
  const { cards, outcomes, days } = load();
  const J = [];
  for (const [k, c] of cards) if (outcomes.has(k)) J.push({ k, c, o: outcomes.get(k) });

  console.log(`\n${cards.size} cards over ${days} days; ${J.length} have a measured outcome.`);
  console.log('Only the ones with an outcome can answer anything.\n');

  // ── 1. news ──────────────────────────────────────────────────────────────
  const items = [];
  for (const [, c] of cards) {
    const n = c.news || {};
    for (const src of ['finnhub', 'yahoo', 'edgar']) {
      for (const it of n[src] || []) if (it.headline) items.push({ src, h: it.headline });
    }
  }
  const bySrc = {};
  for (const it of items) bySrc[it.src] = (bySrc[it.src] || 0) + 1;
  const round = items.filter(it => ROUNDUP.test(it.h));
  console.log('NEWS');
  console.log(`  items by source: ${JSON.stringify(bySrc)}`);
  console.log(`  ${round.length} of ${items.length} delivered items are market roundups ` +
    `(${(100 * round.length / Math.max(items.length, 1)).toFixed(0)}%) — they report that a stock`);
  console.log('  moved, which the screener already knew, and not why.');
  const counts = {};
  for (const it of round) counts[it.h] = (counts[it.h] || 0) + 1;
  Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([h, n]) => console.log(`    ${String(n).padStart(4)}×  ${h.slice(0, 70)}`));

  // ── 2. catalyst ──────────────────────────────────────────────────────────
  const src = {}, labels = {};
  for (const { c } of J) {
    const cat = c.catalyst;
    const s = cat ? (cat.source || 'news') : 'none';
    src[s] = (src[s] || 0) + 1;
    if (cat) labels[`${s}:${cat.label}`] = (labels[`${s}:${cat.label}`] || 0) + 1;
  }
  console.log('\nCATALYST');
  console.log(`  by source: ${JSON.stringify(src)}`);
  console.log('  a "technical" catalyst is the screener\'s own criteria restated —');
  console.log('  it cannot separate the stocks the screener already selected for it:');
  Object.entries(labels).filter(([k]) => k.startsWith('technical'))
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`    ${String(n).padStart(4)}×  ${k.replace('technical:', '')}`));

  // ── 3. does any of it predict the move ───────────────────────────────────
  console.log('\nOUTCOMES (entry B)');
  summarise('all cards', J);
  const withC = J.filter(r => r.c.catalyst);
  const noC = J.filter(r => !r.c.catalyst);
  const a = summarise('with a catalyst', withC);
  const b = summarise('without one', noC);
  summarise('  tier 1 (major)', J.filter(r => (r.c.catalyst || {}).tier === 1));
  summarise('  tier 2 (notable)', J.filter(r => (r.c.catalyst || {}).tier === 2));
  summarise('  from real news', J.filter(r => r.c.catalyst && (r.c.catalyst.source || 'news') === 'news'));
  summarise('  restated technicals', J.filter(r => (r.c.catalyst || {}).source === 'technical'));
  console.log('');
  summarise('bias long', J.filter(r => (r.c.autoBias || {}).bias === 'long'));
  summarise('bias short', J.filter(r => (r.c.autoBias || {}).bias === 'short'));
  summarise('  bias from catalyst', J.filter(r => (r.c.autoBias || {}).source === 'catalyst'));
  summarise('  bias from context', J.filter(r => (r.c.autoBias || {}).source === 'context'));

  if (a && b) {
    const p = fisher(a.wins, a.losses, b.wins, b.losses);
    console.log(`\n  catalyst vs no catalyst, win rate: Fisher exact p = ${p.toFixed(3)}`);
    console.log(p > 0.05
      ? '  NOT significant. There is no evidence either way yet — which is not the\n' +
        '  same as evidence that it works, and is the reason for the collection month.'
      : '  Significant at this sample size.');
  }
  console.log('');
}

main();
