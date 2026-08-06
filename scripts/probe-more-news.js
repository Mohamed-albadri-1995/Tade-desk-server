#!/usr/bin/env node
/*
 * Is three sources enough, and what else can this box actually reach?
 *
 * Coverage is not the same everywhere. CELH pulled twenty items across
 * TradingView, Yahoo and EDGAR; WYHG — up 205% the same day — pulled none
 * inside three weeks. The screener's whole job is finding the second kind, so
 * that is where a thin news layer costs something, and where an extra source
 * would earn its place.
 *
 * The candidates below are all reachable without a new subscription. The one
 * worth the most is Alpaca: its news feed is Benzinga's, tagged by symbol, and
 * the keys are already in this tool's settings for the trading side. If it
 * answers, it is a better source than anything here except TradingView.
 *
 * Nothing is added on the strength of a URL looking plausible. Each is called
 * against BOTH a well-covered stock and a thin one, because a source that only
 * knows the large caps adds nothing this tool needs.
 *
 *   node scripts/probe-more-news.js               # AAPL and WYHG
 *   node scripts/probe-more-news.js CELH JLHL
 *
 * Run from the server.
 */

const axios = require('axios');

const BIG = (process.argv[2] || 'AAPL').toUpperCase();
const THIN = (process.argv[3] || 'WYHG').toUpperCase();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function alpacaKeys() {
  try {
    const db = require('../src/db');
    const get = (k) => {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return (r && r.value) || '';
    };
    return { key: get('alpacaApiKey'), secret: get('alpacaApiSecret') };
  } catch {
    return { key: process.env.ALPACA_API_KEY || '', secret: process.env.ALPACA_API_SECRET || '' };
  }
}

const SOURCES = [
  {
    name: 'Alpaca (Benzinga feed)',
    note: 'symbol-tagged, real financial newsroom; uses the keys already in Settings',
    build: (t) => {
      const { key, secret } = alpacaKeys();
      if (!key || !secret) return null;
      return {
        url: `https://data.alpaca.markets/v1beta1/news?symbols=${t}&limit=10`,
        opts: { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }, timeout: 12000 },
      };
    },
    count: (d) => (d && Array.isArray(d.news) ? d.news : []).length,
    sample: (d) => ((d && d.news) || [])[0] && `${d.news[0].headline} — ${d.news[0].created_at}`,
  },
  {
    name: 'Google News RSS',
    note: 'no key, very wide, but untagged — every roundup would need the word filter',
    build: (t) => ({
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(`"${t}" stock`)}&hl=en-US&gl=US&ceid=US:en`,
      opts: { headers: { 'User-Agent': UA }, timeout: 12000, responseType: 'text' },
    }),
    count: (d) => (String(d).match(/<item>/g) || []).length,
    sample: (d) => { const m = String(d).match(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/); return m && m[1]; },
  },
  {
    name: 'Stocktwits',
    note: 'sentiment stream rather than a newsroom — noisy by nature',
    build: (t) => ({
      url: `https://api.stocktwits.com/api/2/streams/symbol/${t}.json`,
      opts: { headers: { 'User-Agent': UA }, timeout: 12000 },
    }),
    count: (d) => ((d && d.messages) || []).length,
    sample: (d) => ((d && d.messages) || [])[0] && String(d.messages[0].body).slice(0, 80),
  },
];

async function probe(src, ticker) {
  const built = src.build(ticker);
  if (!built) return { skip: 'no keys in Settings' };
  try {
    const r = await axios.get(built.url, built.opts);
    return { n: src.count(r.data), sample: src.sample(r.data), status: r.status };
  } catch (e) {
    const code = e.response && e.response.status;
    return { err: code ? `HTTP ${code}` : (e.code || e.message) };
  }
}

(async () => {
  console.log(`Well-covered: ${BIG}     Thin: ${THIN}`);
  console.log('A source that only answers for the first one adds nothing this tool needs.\n');

  for (const src of SOURCES) {
    console.log(src.name);
    console.log('─'.repeat(src.name.length));
    console.log(`  ${src.note}`);
    for (const t of [BIG, THIN]) {
      const r = await probe(src, t);
      if (r.skip) { console.log(`  ${t.padEnd(6)} skipped — ${r.skip}`); continue; }
      if (r.err) { console.log(`  ${t.padEnd(6)} no — ${r.err}`); continue; }
      console.log(`  ${t.padEnd(6)} ${r.n} item(s)${r.n ? `\n           e.g. ${String(r.sample).slice(0, 90)}` : ''}`);
      await new Promise(s => setTimeout(s, 700));
    }
    console.log('');
  }
  console.log('Paste this whole output back.');
})();
