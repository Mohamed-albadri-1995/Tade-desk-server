#!/usr/bin/env node
/*
 * Can we read TradingView's news without a subscription?
 *
 * The news layer currently rests entirely on Yahoo — Finnhub has no key and,
 * by the trader's own experience, mostly returns "what is hot today" roundups
 * rather than company news; EDGAR was refused for months. Yahoo carries real
 * stories but 16% of what it delivers is market roundups ("Top Premarket
 * Gainers", "BC-Most Active Stocks"), which say a stock moved — something the
 * screener already knew — and nothing about why.
 *
 * TradingView's own charts show a headline feed, and the widgets that feed is
 * served to are public. If those endpoints answer unauthenticated, they are a
 * better source than anything currently wired in: the stories are already
 * mapped to a symbol, so the roundup problem largely disappears.
 *
 * This does not guess. Each candidate endpoint is called and the answer
 * reported — shape, count, and a sample headline — so the decision is made on
 * what came back rather than on what the URL looks like.
 *
 *   node scripts/probe-tv-news.js            # defaults to NASDAQ:AAPL
 *   node scripts/probe-tv-news.js NYSE:GME
 *
 * Run it from the server; this sandbox cannot reach TradingView.
 */

const axios = require('axios');

const SYMBOL = process.argv[2] || 'NASDAQ:AAPL';
const BARE = SYMBOL.includes(':') ? SYMBOL.split(':')[1] : SYMBOL;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  Accept: 'application/json',
};

const CANDIDATES = [
  ['headlines v2',
   `https://news-headlines.tradingview.com/v2/headlines?symbol=${encodeURIComponent(SYMBOL)}&lang=en`],
  ['headlines v2 (client=overview)',
   `https://news-headlines.tradingview.com/v2/headlines?client=overview&lang=en&symbol=${encodeURIComponent(SYMBOL)}`],
  ['news-flow v2',
   `https://news-mediator.tradingview.com/news-flow/v2/news?filter=lang:en&filter=symbol:${encodeURIComponent(SYMBOL)}&client=overview`],
  ['news-flow v1',
   `https://news-mediator.tradingview.com/public/view/v1/symbol?filter=lang:en&filter=symbol:${encodeURIComponent(SYMBOL)}`],
  ['headlines (bare ticker)',
   `https://news-headlines.tradingview.com/v2/headlines?symbol=${encodeURIComponent(BARE)}&lang=en`],
];

// The shape is not documented and need not be guessed at — find the first
// array of objects that look like headlines, wherever it is nested.
function findItems(data) {
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      const hit = node.find(x => x && typeof x === 'object' &&
        (x.title || x.headline) && (x.published || x.publishedAt || x.datetime || x.timestamp));
      if (hit) return node;
      for (const x of node) { const r = walk(x); if (r) return r; }
      return null;
    }
    for (const v of Object.values(node)) { const r = walk(v); if (r) return r; }
    return null;
  };
  return walk(data);
}

(async () => {
  console.log(`Probing TradingView news for ${SYMBOL}\n`);
  let winner = null;
  for (const [name, url] of CANDIDATES) {
    process.stdout.write(`  ${name.padEnd(32)}`);
    try {
      const r = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const items = findItems(r.data);
      if (!items || !items.length) {
        console.log(`answered ${r.status}, but no headline array found`);
        console.log(`      shape: ${JSON.stringify(r.data).slice(0, 140)}`);
      } else {
        const s = items[0];
        console.log(`YES — ${items.length} items`);
        console.log(`      title:   ${(s.title || s.headline || '').slice(0, 90)}`);
        console.log(`      time:    ${s.published || s.publishedAt || s.datetime || s.timestamp}`);
        console.log(`      source:  ${(s.source && (s.source.name || s.source)) || s.provider || '?'}`);
        console.log(`      fields:  ${Object.keys(s).join(', ').slice(0, 140)}`);
        if (!winner) winner = name;
      }
    } catch (e) {
      const code = e.response && e.response.status;
      console.log(code ? `no — HTTP ${code}` : `no — ${e.code || e.message}`);
    }
    console.log('');
    await new Promise(s => setTimeout(s, 600));
  }
  console.log(winner ? `Usable: "${winner}"` : 'None of these answered with headlines.');
  console.log('Paste this whole output back.');
})();
