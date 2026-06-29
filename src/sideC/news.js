const axios = require('axios');

const CATALYST_PATTERNS = [
  { priority: 1, pattern: /FDA approval|PDUFA approval|clinical trial success/i, label: 'FDA Approval', sentiment: 'bull', color: '#4ade80' },
  { priority: 2, pattern: /FDA CRL|clinical trial fail|FDA rejection/i, label: 'FDA Rejection', sentiment: 'bear', color: '#ef4444' },
  { priority: 3, pattern: /earnings beat|EPS beat|revenue beat/i, label: 'Earnings Beat', sentiment: 'bull', color: '#34d399' },
  { priority: 4, pattern: /earnings miss|EPS miss|revenue miss/i, label: 'Earnings Miss', sentiment: 'bear', color: '#f87171' },
  { priority: 5, pattern: /acquisition|takeover|buyout|M&A/i, label: 'M&A', sentiment: 'bull', color: '#a78bfa' },
  { priority: 6, pattern: /offering|dilution|secondary|shelf|at-the-market/i, label: 'Dilution', sentiment: 'bear', color: '#f87171' },
  { priority: 7, pattern: /analyst upgrade|outperform|overweight|buy rating/i, label: 'Upgrade', sentiment: 'bull', color: '#86efac' },
  { priority: 8, pattern: /analyst downgrade|underperform|underweight|sell rating/i, label: 'Downgrade', sentiment: 'bear', color: '#f87171' },
  { priority: 9, pattern: /short interest|short squeeze/i, label: 'Short Squeeze', sentiment: 'bull', color: '#fb923c' },
  { priority: 10, pattern: /insider buying|CEO bought|director bought/i, label: 'Insider Buy', sentiment: 'bull', color: '#fbbf24' },
  { priority: 11, pattern: /insider selling|CEO sold|director sold/i, label: 'Insider Sell', sentiment: 'bear', color: '#f87171' },
  { priority: 12, pattern: /partnership|contract|deal|collaboration/i, label: 'Partnership', sentiment: 'bull', color: '#67e8f9' },
  { priority: 13, pattern: /lawsuit|investigation|SEC charge/i, label: 'Legal Risk', sentiment: 'bear', color: '#f472b6' },
];

function classifyCatalyst(headlines) {
  const text = headlines.join(' ');
  for (const { pattern, label, sentiment, color } of CATALYST_PATTERNS) {
    if (pattern.test(text)) {
      return { label, sentiment, color };
    }
  }
  return null;
}

function getFinnhubKey() {
  try {
    const db = require('../db');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'finnhubApiKey'").get();
    if (row && row.value) return row.value;
  } catch { /* ignore */ }
  return process.env.FINNHUB_API_KEY || '';
}

async function fetchFinnhub(ticker) {
  try {
    const apiKey = getFinnhubKey();
    if (!apiKey) return [];
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const resp = await axios.get(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${apiKey}`,
      { timeout: 8000 }
    );
    return (resp.data || []).slice(0, 10).map(n => ({
      headline: n.headline,
      url: n.url,
      datetime: n.datetime,
      source: 'finnhub',
    }));
  } catch {
    return [];
  }
}

async function fetchYahoo(ticker) {
  try {
    const resp = await axios.get(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}`,
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const news = resp.data?.news || [];
    return news.slice(0, 10).map(n => ({
      headline: n.title,
      url: n.link,
      datetime: n.providerPublishTime,
      source: 'yahoo',
    }));
  } catch {
    return [];
  }
}

async function fetchEdgar(ticker) {
  try {
    const resp = await axios.get(
      `https://efts.sec.gov/LATEST/search-index?q=${ticker}&forms=8-K,S-3`,
      { timeout: 8000 }
    );
    const hits = resp.data?.hits?.hits || [];
    return hits.slice(0, 5).map(h => ({
      headline: h._source?.period_of_report
        ? `${h._source.form_type} — ${h._source.period_of_report}`
        : h._source?.form_type || 'SEC Filing',
      url: `https://www.sec.gov/Archives/edgar/data/${h._source?.entity_id}/${h._id}`,
      datetime: h._source?.period_of_report,
      source: 'edgar',
    }));
  } catch {
    return [];
  }
}

async function fetchNewsForTicker(ticker) {
  const [finnhub, yahoo, edgar] = await Promise.all([
    fetchFinnhub(ticker),
    fetchYahoo(ticker),
    fetchEdgar(ticker),
  ]);

  const allHeadlines = [
    ...finnhub.map(n => n.headline),
    ...yahoo.map(n => n.headline),
  ].filter(Boolean);

  const catalyst = classifyCatalyst(allHeadlines);

  return {
    news: { finnhub, yahoo, edgar, fetchedAt: new Date().toISOString() },
    catalyst,
  };
}

module.exports = { fetchNewsForTicker, classifyCatalyst };
