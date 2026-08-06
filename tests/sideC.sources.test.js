/*
 * Where the news comes from, and what happens when it doesn't come.
 *
 * These exist because of what 23 days of backups showed: 11,359 news items, every
 * one of them from Yahoo. Finnhub and EDGAR returned nothing on every day for
 * every stock — Finnhub because no API key was ever entered, EDGAR because the
 * SEC refuses requests that do not identify themselves and the request sent no
 * headers at all. Both failures were caught by a bare `catch { return []; }`,
 * which made a dead source and a quiet stock produce identical output.
 *
 * A third of the news pipeline was switched off for the entire history of the
 * tool and nothing anywhere said so. The tests below are the alarm that was
 * missing: every fetcher must report HOW it did, not only what it found.
 */

const axios = require('axios');

let mockKey = '';
jest.mock('../src/db', () => ({
  prepare: () => ({ get: () => (mockKey ? { value: mockKey } : undefined) }),
}));

const { fetchNewsForTicker } = require('../src/sideC/news');

beforeEach(() => {
  mockKey = '';
  delete process.env.FINNHUB_API_KEY;
  jest.restoreAllMocks();
});

// Route each host to its own canned answer, so one source can fail while the
// others succeed — which is the situation that actually occurred.
function mockHosts({ finnhub, yahoo, edgar }) {
  jest.spyOn(axios, 'get').mockImplementation((url, opts) => {
    if (url.includes('finnhub.io')) return finnhub(url, opts);
    if (url.includes('yahoo')) return yahoo(url, opts);
    if (url.includes('sec.gov')) return edgar(url, opts);
    return Promise.reject(new Error('unexpected host: ' + url));
  });
}

const okYahoo = () => Promise.resolve({ data: { news: [
  { title: 'Shares jump', link: 'u', providerPublishTime: 1770000000, relatedTickers: ['AAA'] },
] } });
const denied = (code) => () => Promise.reject(Object.assign(new Error('x'), { response: { status: code } }));
const empty = () => Promise.resolve({ data: {} });

describe('a source reports how it did, not just what it found', () => {

  test('no Finnhub key is reported as a missing key, not as no news', async () => {
    mockHosts({ finnhub: empty, yahoo: okYahoo, edgar: empty });
    const { news } = await fetchNewsForTicker('AAA');
    expect(news.sources.finnhub.status).toBe('no-key');
    expect(news.sources.finnhub.detail).toMatch(/Settings/);
    expect(news.finnhub).toEqual([]);
    // …and the source that did work is untouched by the one that didn't
    expect(news.sources.yahoo.status).toBe('ok');
    expect(news.yahoo).toHaveLength(1);
  });

  test('a key present means Finnhub is actually called', async () => {
    mockKey = 'abc123';
    let called = null;
    mockHosts({
      finnhub: (url) => { called = url; return Promise.resolve({ data: [
        { headline: 'FDA clearance', url: 'u', datetime: 1770000000 }] }); },
      yahoo: okYahoo, edgar: empty,
    });
    const { news } = await fetchNewsForTicker('AAA');
    expect(called).toContain('token=abc123');
    expect(news.sources.finnhub.status).toBe('ok');
    expect(news.finnhub[0].headline).toBe('FDA clearance');
  });

  // The specific bug: the SEC denies anonymous automated requests.
  test('the SEC request identifies itself, or it gets refused', async () => {
    mockKey = 'k';
    let headers = null;
    mockHosts({
      finnhub: empty, yahoo: okYahoo,
      edgar: (url, opts) => { headers = opts && opts.headers; return Promise.resolve({ data: { hits: { hits: [] } } }); },
    });
    await fetchNewsForTicker('AAA');
    expect(headers).toBeTruthy();
    expect(headers['User-Agent']).toBeTruthy();
    expect(String(headers['User-Agent']).length).toBeGreaterThan(5);
  });

  test('a 403 from the SEC is recorded as denied, not as silence', async () => {
    mockHosts({ finnhub: empty, yahoo: okYahoo, edgar: denied(403) });
    const { news } = await fetchNewsForTicker('AAA');
    expect(news.sources.edgar.status).toBe('denied');
    expect(news.sources.edgar.detail).toMatch(/403/);
  });

  test('rate limiting is its own answer', async () => {
    mockKey = 'k';
    mockHosts({ finnhub: denied(429), yahoo: okYahoo, edgar: empty });
    const { news } = await fetchNewsForTicker('AAA');
    expect(news.sources.finnhub.status).toBe('rate-limited');
  });

  test('a timeout is distinguishable from an empty answer', async () => {
    mockHosts({
      finnhub: empty, edgar: empty,
      yahoo: () => Promise.reject(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })),
    });
    const { news } = await fetchNewsForTicker('AAA');
    expect(news.sources.yahoo.status).toBe('timeout');
  });

  // The distinction the whole change is for.
  test('a genuinely quiet stock is "ok", not an error', async () => {
    mockKey = 'k';
    mockHosts({
      finnhub: () => Promise.resolve({ data: [] }),
      yahoo: () => Promise.resolve({ data: { news: [] } }),
      edgar: () => Promise.resolve({ data: { hits: { hits: [] } } }),
    });
    const { news } = await fetchNewsForTicker('AAA');
    for (const s of ['finnhub', 'yahoo', 'edgar']) {
      expect(news.sources[s].status).toBe('ok');
      expect(news.sources[s].count).toBe(0);
    }
  });

  test('one source failing does not lose the others', async () => {
    mockKey = 'k';   // or Finnhub short-circuits on no-key before it can be denied
    mockHosts({ finnhub: denied(401), yahoo: okYahoo, edgar: denied(403) });
    const { news } = await fetchNewsForTicker('AAA');
    expect(news.yahoo).toHaveLength(1);
    expect(news.sources.finnhub.status).toBe('denied');
    expect(news.sources.edgar.status).toBe('denied');
    expect(news.sources.yahoo.count).toBe(1);
  });

  test('EDGAR filings still become items when the request succeeds', async () => {
    mockHosts({
      finnhub: empty, yahoo: () => Promise.resolve({ data: { news: [] } }),
      edgar: () => Promise.resolve({ data: { hits: { hits: [
        { _id: 'x', _source: { form_type: '8-K', period_of_report: '2026-08-04', entity_id: '1' } },
      ] } } }),
    });
    const { news } = await fetchNewsForTicker('AAA');
    expect(news.edgar).toHaveLength(1);
    expect(news.edgar[0].headline).toContain('8-K');
    expect(news.sources.edgar.count).toBe(1);
  });
});
