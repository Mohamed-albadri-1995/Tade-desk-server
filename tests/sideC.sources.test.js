/*
 * Where the news comes from, what happens when it doesn't come, and what gets
 * thrown away on the way in.
 *
 * These exist because of what 23 days of backups showed: 11,359 news items,
 * every one from Yahoo. Finnhub returned nothing on every day because no key
 * was ever entered; EDGAR returned nothing because the SEC refuses requests
 * that do not identify themselves. Both failures were caught by a bare
 * `catch { return []; }`, which made a dead source and a quiet stock produce
 * identical output for the entire history of the tool.
 *
 * And of what got through: 15% of delivered items were market listings — "Top
 * Premarket Gainers", "BC-Most Active Stocks" — which report that a stock moved,
 * the one thing the screener already knew, while feeding the catalyst
 * classifier the exact words it hunts for.
 *
 * So: every fetcher reports HOW it did, and listings are removed by structure
 * rather than by hoping the wording gives them away.
 */

const axios = require('axios');
const { fetchNewsForTicker, isRoundup, MAX_RELATED_SYMBOLS } = require('../src/sideC/news');

const TV = 'NASDAQ:AAA';

beforeEach(() => jest.restoreAllMocks());

function mockHosts({ tv, yahoo, edgar }) {
  jest.spyOn(axios, 'get').mockImplementation((url, opts) => {
    if (url.includes('tradingview')) return (tv || empty)(url, opts);
    if (url.includes('yahoo')) return (yahoo || empty)(url, opts);
    if (url.includes('sec.gov')) return (edgar || empty)(url, opts);
    return Promise.reject(new Error('unexpected host: ' + url));
  });
}
const empty = () => Promise.resolve({ data: {} });
const denied = (code) => () => Promise.reject(Object.assign(new Error('x'), { response: { status: code } }));
const tvStory = (over = {}) => ({
  id: '1', title: 'Company wins FDA clearance', published: 1770000000,
  link: 'https://x', relatedSymbols: [{ symbol: TV }], urgency: 2,
  source: { name: 'Reuters' }, ...over,
});
const yahooStory = (over = {}) => ({
  title: 'Company wins FDA clearance', link: 'u', providerPublishTime: 1770000000,
  relatedTickers: ['AAA'], publisher: 'Reuters', ...over,
});

describe('a source reports how it did, not just what it found', () => {

  test('a row with no exchange-qualified symbol says so, rather than reporting no news', async () => {
    mockHosts({ yahoo: () => Promise.resolve({ data: { news: [yahooStory()] } }) });
    const { news } = await fetchNewsForTicker('AAA', undefined);
    expect(news.sources.tradingview.status).toBe('no-symbol');
    expect(news.tradingview).toEqual([]);
    expect(news.yahoo).toHaveLength(1);          // the others carry on
  });

  test('TradingView is called with the exchange-qualified symbol', async () => {
    let called = null;
    mockHosts({ tv: (url) => { called = url; return Promise.resolve({ data: [tvStory()] }); } });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(decodeURIComponent(called)).toContain(TV);
    expect(news.sources.tradingview.status).toBe('ok');
    expect(news.tradingview[0].headline).toBe('Company wins FDA clearance');
  });

  // The specific bug: the SEC denies anonymous automated requests.
  test('the SEC request identifies itself, or it gets refused', async () => {
    let headers = null;
    mockHosts({ edgar: (url, opts) => { headers = opts && opts.headers; return Promise.resolve({ data: { hits: { hits: [] } } }); } });
    await fetchNewsForTicker('AAA', TV);
    expect(headers && headers['User-Agent']).toBeTruthy();
    expect(String(headers['User-Agent']).length).toBeGreaterThan(5);
  });

  test('a 403 is recorded as denied, not as silence', async () => {
    mockHosts({ edgar: denied(403) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.edgar.status).toBe('denied');
    expect(news.sources.edgar.detail).toMatch(/403/);
  });

  test('rate limiting is its own answer', async () => {
    mockHosts({ tv: denied(429) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.tradingview.status).toBe('rate-limited');
  });

  test('a timeout is distinguishable from an empty answer', async () => {
    mockHosts({ yahoo: () => Promise.reject(Object.assign(new Error('t'), { code: 'ECONNABORTED' })) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.yahoo.status).toBe('timeout');
  });

  // The distinction the whole change is for.
  test('a genuinely quiet stock is "ok", not an error', async () => {
    mockHosts({
      tv: () => Promise.resolve({ data: [] }),
      yahoo: () => Promise.resolve({ data: { news: [] } }),
      edgar: () => Promise.resolve({ data: { hits: { hits: [] } } }),
    });
    const { news } = await fetchNewsForTicker('AAA', TV);
    for (const s of ['tradingview', 'yahoo', 'edgar']) {
      expect(news.sources[s].status).toBe('ok');
      expect(news.sources[s].count).toBe(0);
    }
  });

  test('one source failing does not lose the others', async () => {
    mockHosts({ tv: denied(500), yahoo: () => Promise.resolve({ data: { news: [yahooStory()] } }), edgar: denied(403) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.yahoo).toHaveLength(1);
    expect(news.sources.tradingview.status).toBe('error');
    expect(news.sources.edgar.status).toBe('denied');
  });

  test('Finnhub is gone entirely — no call, no source entry', async () => {
    const spy = jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(spy.mock.calls.every(c => !String(c[0]).includes('finnhub'))).toBe(true);
    expect(news.sources.finnhub).toBeUndefined();
  });
});

describe('market listings are removed on the way in', () => {

  test('a story tagged to more symbols than a story can be about is a listing', () => {
    const many = MAX_RELATED_SYMBOLS + 1;
    expect(isRoundup('Some perfectly normal headline', many)).toBe(true);
    expect(isRoundup('Some perfectly normal headline', 2)).toBe(false);
  });

  // These four accounted for most of the 177 that got through.
  test.each([
    'Top Premarket Gainers',
    'BC-Most Active Stocks',
    'Top Premarket Decliners',
    'Top Midday Gainers',
  ])('%s is caught even when the symbol list is small', (headline) => {
    expect(isRoundup(headline, 1)).toBe(true);
  });

  test('a real story is not caught by the word list', () => {
    for (const h of [
      'Pfizer wins FDA approval for gene therapy',
      'Shares surge after Q2 earnings beat',
      'Company announces $200M offering',
      'Analyst upgrades stock to buy',
    ]) expect(isRoundup(h, 1)).toBe(false);
  });

  test('TradingView listings are dropped and counted', async () => {
    const wide = Array.from({ length: 40 }, (_, i) => ({ symbol: `X${i}` }));
    mockHosts({ tv: () => Promise.resolve({ data: [
      tvStory({ title: 'Top Premarket Gainers', relatedSymbols: wide }),
      tvStory(),
    ] }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.tradingview).toHaveLength(1);
    expect(news.tradingview[0].headline).toBe('Company wins FDA clearance');
    expect(news.sources.tradingview.dropped).toBe(1);
  });

  // Yahoo tags its listings with every ticker in them, so requiring its own tag
  // never excluded them — the listing passes on the very stock it buries.
  test('a Yahoo listing tagged with this ticker is still dropped', async () => {
    mockHosts({ yahoo: () => Promise.resolve({ data: { news: [
      yahooStory({ title: 'Top Premarket Gainers', relatedTickers: ['AAA', 'BBB', 'CCC'] }),
      yahooStory(),
    ] } }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.yahoo).toHaveLength(1);
    expect(news.sources.yahoo.dropped).toBe(1);
  });

  test('the same story from two sources is counted once', async () => {
    // Otherwise the classifier reads it as two outlets independently
    // corroborating one event, and rates it higher for being duplicated.
    mockHosts({
      tv: () => Promise.resolve({ data: [tvStory()] }),
      yahoo: () => Promise.resolve({ data: { news: [yahooStory()] } }),
    });
    const { news, catalyst } = await fetchNewsForTicker('AAA', TV);
    expect(news.tradingview).toHaveLength(1);
    expect(news.yahoo).toHaveLength(1);          // both keep their own copy to show
    if (catalyst) expect(catalyst.corroboration || 1).toBe(1);
  });
});
