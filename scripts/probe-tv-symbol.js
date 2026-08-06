#!/usr/bin/env node
/*
 * Which symbol form does TradingView's headline endpoint accept, for the
 * symbols this tool actually holds?
 *
 * The endpoint answered for NASDAQ:AAPL when probed by hand and then returned
 * nothing in production. Two candidate explanations, and guessing between them
 * is what caused the problem in the first place:
 *
 *   1. The symbol. Side A stores whatever TradingView's SCANNER calls a stock,
 *      and the scanner and the news feed do not have to agree — the scanner
 *      lists OTC and AMEX names under prefixes the news feed may not know.
 *      AAPL is the one ticker least likely to expose that.
 *   2. The response shape, which the tool reads differently from the probe.
 *
 * This settles both, against the symbols on the running tool rather than a
 * hand-picked one: it reads today's rows, takes their real tvSymbol values,
 * and tries each form — as stored, bare ticker, and the common prefixes — then
 * prints the raw envelope of whichever worked.
 *
 *   node scripts/probe-tv-symbol.js            # reads localhost:3000
 *   node scripts/probe-tv-symbol.js 3060       # a different tool's port
 *
 * Run from the server.
 */

const axios = require('axios');

const PORT = process.argv[2] || '3000';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  Accept: 'application/json',
};

async function tryOne(symbol) {
  const url = `https://news-headlines.tradingview.com/v2/headlines?client=overview&lang=en&symbol=${encodeURIComponent(symbol)}`;
  try {
    const r = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, code: (e.response && e.response.status) || e.code || e.message };
  }
}

// Same search the tool now uses, so what this reports is what the tool sees.
function findHeadlineArray(data) {
  const seen = new Set();
  const looks = (x) => x && typeof x === 'object' && (x.title || x.headline) &&
    (x.published || x.publishedAt || x.datetime || x.timestamp);
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.some(looks)) return node.filter(looks);
      for (const x of node) { const r = walk(x); if (r) return r; }
      return null;
    }
    for (const v of Object.values(node)) { const r = walk(v); if (r) return r; }
    return null;
  };
  return walk(data);
}

// Where in the response the array was found — the thing the tool guessed wrong.
function pathTo(data, target) {
  const seen = new Set();
  const walk = (node, path) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (node === target) return path || '(top level)';
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) { const r = walk(node[i], `${path}[${i}]`); if (r) return r; }
      return null;
    }
    for (const [k, v] of Object.entries(node)) { const r = walk(v, path ? `${path}.${k}` : k); if (r) return r; }
    return null;
  };
  return walk(data, '');
}

(async () => {
  let rows = [];
  try {
    const r = await axios.get(`http://localhost:${PORT}/api/registry/today`, { timeout: 5000 });
    rows = (r.data && r.data.rows) || [];
  } catch (e) {
    console.log(`Could not read localhost:${PORT} — is that tool running? (${e.code || e.message})`);
  }

  const samples = rows
    .map(r => ({ ticker: r.ticker, tv: r.stock && r.stock.tvSymbol }))
    .filter(x => x.ticker)
    .slice(0, 4);

  if (!samples.length) {
    console.log('No rows on that tool right now — falling back to a known-good symbol.\n');
    samples.push({ ticker: 'AAPL', tv: 'NASDAQ:AAPL' });
  } else {
    console.log(`Symbols as this tool stores them:`);
    samples.forEach(s => console.log(`  ${s.ticker.padEnd(8)} tvSymbol = ${JSON.stringify(s.tv)}`));
    console.log('');
  }

  let shapeShown = false;
  for (const s of samples) {
    console.log(`${s.ticker}`);
    console.log('─'.repeat(s.ticker.length));
    const forms = [];
    if (s.tv) forms.push(['as stored', s.tv]);
    forms.push(['bare ticker', s.ticker]);
    for (const ex of ['NASDAQ', 'NYSE', 'AMEX']) {
      if (!s.tv || !s.tv.startsWith(ex + ':')) forms.push([`${ex}:`, `${ex}:${s.ticker}`]);
    }

    for (const [label, sym] of forms) {
      const r = await tryOne(sym);
      if (!r.ok) { console.log(`  ${label.padEnd(12)} ${String(sym).padEnd(18)} no — ${r.code}`); }
      else {
        const items = findHeadlineArray(r.data);
        const n = items ? items.length : 0;
        console.log(`  ${label.padEnd(12)} ${String(sym).padEnd(18)} ${
          items === null ? 'answered, NO headline array found' : `YES — ${n} item(s)`}`);
        if (items && items.length && !shapeShown) {
          shapeShown = true;
          console.log(`      array found at: ${pathTo(r.data, items) || '(filtered copy — see envelope)'}`);
          console.log(`      envelope keys:  ${Array.isArray(r.data) ? '(top level array)' : Object.keys(r.data).join(', ')}`);
          console.log(`      first headline: ${(items[0].title || items[0].headline || '').slice(0, 80)}`);
          console.log(`      item fields:    ${Object.keys(items[0]).join(', ')}`);
        }
      }
      await new Promise(x => setTimeout(x, 500));
    }
    console.log('');
  }
  console.log('Paste this whole output back.');
})();
