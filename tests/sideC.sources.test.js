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
// Timestamps are relative, not fixed. A hard-coded date silently ages past the
// news window as time passes and the fixtures start failing for a reason that
// has nothing to do with what they test.
const NOW_S = () => Math.floor(Date.now() / 1000);
const tvStory = (over = {}) => ({
  id: '1', title: 'Company wins FDA clearance', published: NOW_S(),
  link: 'https://x', relatedSymbols: [{ symbol: TV }], urgency: 2,
  source: { name: 'Reuters' }, ...over,
});
const yahooStory = (over = {}) => ({
  title: 'Company wins FDA clearance', link: 'u', providerPublishTime: NOW_S(),
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

  // Finnhub is back — a key exists now, and "it returned nothing" was always
  // "nobody gave it a key". Without one it must say so rather than read as a
  // quiet stock, which is the whole point of the source statuses.
  test('no Finnhub key reads as a missing key, not as no news', async () => {
    mockHosts({});
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.finnhub.status).toBe('no-key');
    expect(news.sources.finnhub.detail).toMatch(/keys\.json|Finnhub key/);
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

/*
 * SEC filings, after the first live run.
 *
 * Fixing the User-Agent got EDGAR answering for the first time, and what it
 * answered with was five rows reading "SEC Filing", dated 1159 and 1162 days
 * ago — sitting in the news list beside a story from 54 minutes earlier as
 * though they were the same kind of thing. A three-year-old 8-K is not news,
 * and a row that says only "SEC Filing" is not information.
 */
describe('SEC filings are recent, or they are not shown', () => {
  const today = new Date().toISOString().slice(0, 10);
  const hit = (over = {}) => ({
    _id: 'x', _source: { form_type: '8-K', file_date: today, entity_id: '1', ...over },
  });
  const edgarHits = (hits) => () => Promise.resolve({ data: { hits: { hits } } });

  test('the request asks for a date range', async () => {
    let url = null;
    mockHosts({ edgar: (u) => { url = u; return Promise.resolve({ data: { hits: { hits: [] } } }); } });
    await fetchNewsForTicker('AAA', TV);
    expect(url).toMatch(/startdt=\d{4}-\d{2}-\d{2}/);
    expect(url).toMatch(/enddt=\d{4}-\d{2}-\d{2}/);
  });

  // Asked for is not the same as honoured.
  test('an old filing is dropped even if the search returns it anyway', async () => {
    const old = new Date(Date.now() - 1159 * 86400000).toISOString().slice(0, 10);
    mockHosts({ edgar: edgarHits([hit({ file_date: old }), hit()]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.edgar).toHaveLength(1);
    expect(news.edgar[0].headline).toContain('8-K');
    expect(news.sources.edgar.dropped).toBe(1);
  });

  test('a filing with neither a form nor a date is dropped, not shown as a placeholder', async () => {
    mockHosts({ edgar: edgarHits([{ _id: 'y', _source: {} }, hit()]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.edgar).toHaveLength(1);
    expect(news.edgar.some(i => i.headline === 'SEC Filing')).toBe(false);
    expect(news.sources.edgar.dropped).toBe(1);
  });

  // The shape is undocumented and has changed before, so the alternatives are
  // read rather than assumed.
  test.each([
    ['form', 'root_form'],
    ['type', 'form'],
  ])('the form type is found under %s as well', async (name) => {
    mockHosts({ edgar: edgarHits([{ _id: 'z', _source: { [name]: '8-K', file_date: today, entity_id: '1' } }]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.edgar[0].headline).toContain('8-K');
  });

  test('a filing with only a date still says something useful', async () => {
    mockHosts({ edgar: edgarHits([{ _id: 'w', _source: { file_date: today, entity_id: '1' } }]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.edgar).toHaveLength(1);
    expect(news.edgar[0].headline).toContain(today);
  });
});

/*
 * The envelope.
 *
 * TradingView answered 25 items when probed and zero in production. The
 * difference was not the symbol: the probe searched the whole response for the
 * headlines, and the tool assumed they sat at the top level or under `.items`.
 * A wrong guess about shape was being reported as a quiet stock — the same
 * silent failure the source-status work exists to prevent, arriving by a
 * different route.
 */
describe('TradingView headlines are found wherever the envelope puts them', () => {
  const story = () => tvStory();

  test.each([
    ['top-level array', (s) => [s]],
    ['under .items', (s) => ({ items: [s] })],
    ['under .news.items', (s) => ({ news: { items: [s] } })],
    ['under .data.stories', (s) => ({ data: { stories: [s] } })],
    ['nested two deep', (s) => ({ result: { payload: { list: [s] } } })],
  ])('%s', async (_label, wrap) => {
    mockHosts({ tv: () => Promise.resolve({ data: wrap(story()) }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.tradingview.status).toBe('ok');
    expect(news.tradingview).toHaveLength(1);
    expect(news.tradingview[0].headline).toBe('Company wins FDA clearance');
  });

  test('an empty answer is a quiet stock, not an unreadable one', async () => {
    for (const body of [[], { items: [] }]) {
      mockHosts({ tv: () => Promise.resolve({ data: body }) });
      const { news } = await fetchNewsForTicker('AAA', TV);
      expect(news.sources.tradingview.status).toBe('ok');
      expect(news.tradingview).toEqual([]);
    }
  });

  // The case that actually happened, and the one it must never look like.
  test('a shape with no headlines in it is reported, not passed off as no news', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: { error: 'symbol not found' } }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.tradingview.status).toBe('unreadable');
    expect(news.sources.tradingview.count).toBe(0);
  });

  test('objects that are not headlines are not mistaken for them', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: { symbols: [{ symbol: 'AAA', exchange: 'NASDAQ' }] } }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.tradingview.status).toBe('unreadable');
  });
});

/*
 * Age — the other half of "relevant".
 *
 * A story can be about this company and nothing else and still have nothing to
 * do with why the stock is moving today. On the live screen WYHG's entire news
 * list was two items from 51 days ago about regaining a Nasdaq listing
 * requirement, sitting under a 205% move; PAVS carried a REVERSE SPLIT
 * catalyst built from a headline 42 days old.
 *
 * The classifier already down-weighted age, which is not the same as excluding
 * it: with nothing to compete against, a stale story still wins, still becomes
 * the catalyst, and still sets a bias.
 */
describe('old stories are not today\'s reason', () => {
  const { MAX_CATALYST_AGE_DAYS, MAX_NEWS_AGE_DAYS } = require('../src/sideC/news');
  const daysAgo = (d) => Math.floor((Date.now() - d * 86400000) / 1000);

  test('the two windows are ordered — show more than you conclude from', () => {
    expect(MAX_CATALYST_AGE_DAYS).toBeLessThan(MAX_NEWS_AGE_DAYS);
  });

  test('a story past the display window is not shown, and is counted', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: [
      tvStory({ title: 'Regains compliance with Nasdaq minimum bid', published: daysAgo(51) }),
      tvStory({ published: daysAgo(1) }),
    ] }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.tradingview).toHaveLength(1);
    expect(news.agedOut).toBe(1);
  });

  // The PAVS case exactly.
  test('a 42-day-old story does not become today\'s catalyst', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: [
      tvStory({ title: 'Company announces 1-for-100 reverse share split', published: daysAgo(42) }),
    ] }) });
    const { catalyst, news } = await fetchNewsForTicker('AAA', TV);
    expect(catalyst).toBeFalsy();
    expect(news.agedOut).toBe(1);
  });

  test('a story inside the display window but outside the catalyst window is shown, not concluded from', async () => {
    const mid = Math.floor((MAX_CATALYST_AGE_DAYS + MAX_NEWS_AGE_DAYS) / 2);
    mockHosts({ tv: () => Promise.resolve({ data: [
      tvStory({ title: 'Company announces $200M offering', published: daysAgo(mid) }),
    ] }) });
    const { catalyst, news } = await fetchNewsForTicker('AAA', TV);
    expect(news.tradingview).toHaveLength(1);      // visible as context
    expect(news.agedOut).toBe(0);
    expect(catalyst).toBeFalsy();                  // but not the reason
  });

  test('a fresh story still becomes the catalyst', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: [
      tvStory({ title: 'Company announces $200M registered direct offering', published: daysAgo(1) }),
    ] }) });
    const { catalyst } = await fetchNewsForTicker('AAA', TV);
    expect(catalyst).toBeTruthy();
  });

  // EDGAR dates filings loosely and some sources send none at all.
  test('an item with no timestamp is kept — unknown age is not old age', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: { items: [
      { id: '1', title: 'Company wins FDA clearance', published: null, timestamp: 1 },
    ] } }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.agedOut).toBe(0);
  });

  test('all of it too old reads as "nothing recent", not "nothing at all"', async () => {
    mockHosts({ tv: () => Promise.resolve({ data: [
      tvStory({ published: daysAgo(60) }), tvStory({ title: 'Another old one', published: daysAgo(80) }),
    ] }) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.tradingview).toEqual([]);
    expect(news.agedOut).toBe(2);
    expect(news.sources.tradingview.status).toBe('ok');   // the source worked fine
  });
});

/*
 * Google News, as a fallback and only as a fallback.
 *
 * Added because of one measurement: CELH pulled twenty items from the three
 * symbol-tagged sources and WYHG, up 205% the same session, pulled none inside
 * three weeks. Google had 28 for WYHG. That is the gap it exists to close.
 *
 * It is not promoted, for two reasons the tests below pin. It sends no symbol
 * list, so listings rest on the word filter alone rather than on structure.
 * And it is an aggregator called per stock per cycle — nine tools times twenty
 * live rows every few minutes — so it is asked only when the tagged sources
 * came back thin.
 */
describe('Google News fills the gap without becoming the source', () => {
  const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${
    items.map(i => `<item><title><![CDATA[${i.t}]]></title><link>${i.l || 'https://x'}</link>` +
      `<pubDate>${i.d || new Date().toUTCString()}</pubDate>` +
      `<source url="https://p">${i.p || 'StockStory'}</source></item>`).join('')
  }</channel></rss>`;

  function mockAll({ tvItems = [], googleXml = rss([]) } = {}) {
    jest.spyOn(axios, 'get').mockImplementation((url) => {
      if (url.includes('news.google.com')) return Promise.resolve({ data: googleXml });
      if (url.includes('tradingview')) return Promise.resolve({ data: tvItems });
      if (url.includes('yahoo')) return Promise.resolve({ data: { news: [] } });
      if (url.includes('sec.gov')) return Promise.resolve({ data: { hits: { hits: [] } } });
      return Promise.reject(new Error('unexpected: ' + url));
    });
  }

  test('it is not called when the tagged sources answered', async () => {
    const spy = jest.fn();
    jest.spyOn(axios, 'get').mockImplementation((url) => {
      if (url.includes('news.google.com')) { spy(); return Promise.resolve({ data: rss([{ t: 'x' }]) }); }
      if (url.includes('tradingview')) return Promise.resolve({ data: [tvStory(), tvStory({ title: 'Second story' })] });
      if (url.includes('yahoo')) return Promise.resolve({ data: { news: [] } });
      return Promise.resolve({ data: { hits: { hits: [] } } });
    });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(spy).not.toHaveBeenCalled();
    expect(news.sources.google.status).toBe('not-needed');
    expect(news.google).toEqual([]);
  });

  // The WYHG case exactly.
  test('it IS called when they came back thin, and its items are used', async () => {
    mockAll({ googleXml: rss([{ t: 'WYHG Stock Whipsaws As Traders Zero In On Volatile Setup - timothysykes.com' }]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.google.status).toBe('ok');
    expect(news.google).toHaveLength(1);
    expect(news.google[0].headline).toBe('WYHG Stock Whipsaws As Traders Zero In On Volatile Setup');
  });

  test('the publisher suffix is stripped out of the headline', async () => {
    // It is already its own field, and leaving it in puts a source name inside
    // the sentence the catalyst classifier reads.
    mockAll({ googleXml: rss([{ t: 'Company wins FDA approval - Reuters', p: 'Reuters' }]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.google[0].headline).toBe('Company wins FDA approval');
    expect(news.google[0].provider).toBe('Reuters');
  });

  test('listings are still removed, on wording alone', async () => {
    mockAll({ googleXml: rss([{ t: 'Top Premarket Gainers - Benzinga' }, { t: 'Company wins FDA approval - Reuters' }]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.google).toHaveLength(1);
    expect(news.sources.google.dropped).toBe(1);
  });

  test('an old Google story is aged out like any other', async () => {
    const old = new Date(Date.now() - 60 * 86400000).toUTCString();
    mockAll({ googleXml: rss([{ t: 'Ancient story - X', d: old }]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.google).toEqual([]);
    expect(news.agedOut).toBe(1);
  });

  test('a page that is not RSS is reported, not read as no news', async () => {
    mockAll({ googleXml: '<!doctype html><html><body>sorry</body></html>' });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.google.status).toBe('unreadable');
  });

  test('an empty feed is a real answer', async () => {
    mockAll({ googleXml: rss([]) });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.google.status).toBe('ok');
    expect(news.google).toEqual([]);
  });

  test('its items can form a catalyst when they are fresh', async () => {
    mockAll({ googleXml: rss([{ t: 'Company to acquire rival in $2B deal - Reuters' }]) });
    const { catalyst } = await fetchNewsForTicker('AAA', TV);
    expect(catalyst).toBeTruthy();
    expect(catalyst.label).toBe('M&A');
  });
});

/*
 * Finnhub, restored.
 *
 * It was removed on the strength of two facts: zero items in 23 days, and the
 * trader's own experience that "it has so much junk news". The first turned
 * out to be that no key had ever been entered. The second is real and is a
 * filtering problem, not a reason to leave a key unused — its company-news
 * endpoint is per-symbol, so it does not have Yahoo's habit of tagging a
 * listing with forty tickers; what it sends instead is volume. The listing
 * filter and the seven-day catalyst window are the instruments for that, and
 * they already run over every source.
 */
describe('Finnhub is filtered like everything else', () => {
  const fhStory = (over = {}) => ({
    headline: 'Company wins FDA clearance', url: 'https://f',
    datetime: Math.floor(Date.now() / 1000), source: 'Reuters', ...over,
  });
  function withKey(items) {
    process.env.FINNHUB_API_KEY = 'test-key';
    jest.spyOn(axios, 'get').mockImplementation((url) => {
      if (url.includes('finnhub.io')) return Promise.resolve({ data: items });
      if (url.includes('yahoo')) return Promise.resolve({ data: { news: [] } });
      if (url.includes('sec.gov')) return Promise.resolve({ data: { hits: { hits: [] } } });
      if (url.includes('news.google.com')) return Promise.resolve({ data: '<rss><channel></channel></rss>' });
      return Promise.resolve({ data: [] });
    });
  }
  afterEach(() => { delete process.env.FINNHUB_API_KEY; });

  test('a key from the environment is used when no tool has its own', async () => {
    withKey([fhStory()]);
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.finnhub.status).toBe('ok');
    expect(news.finnhub).toHaveLength(1);
  });

  test('its listings are dropped on wording, since it sends no symbol list', async () => {
    withKey([fhStory({ headline: 'Top Premarket Gainers' }), fhStory()]);
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.finnhub).toHaveLength(1);
    expect(news.sources.finnhub.dropped).toBe(1);
  });

  test('its old stories age out like any other source', async () => {
    withKey([fhStory({ datetime: Math.floor((Date.now() - 60 * 86400000) / 1000) })]);
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.finnhub).toEqual([]);
    expect(news.agedOut).toBe(1);
  });

  test('it counts toward "not thin", so Google stays unasked', async () => {
    withKey([fhStory(), fhStory({ headline: 'Second real story' })]);
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.google.status).toBe('not-needed');
  });

  test('a body that is not a list is reported, not read as silence', async () => {
    withKey({ error: 'invalid api key' });
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.sources.finnhub.status).toBe('unreadable');
  });

  test('the story URL survives, so the headline can be opened', async () => {
    withKey([fhStory({ url: 'https://finnhub.io/story/1' })]);
    const { news } = await fetchNewsForTicker('AAA', TV);
    expect(news.finnhub[0].url).toBe('https://finnhub.io/story/1');
  });
});
