/*
 * SHORT INTEREST — the one card field that has never had a value.
 *
 * It came from TradingView's `short_percentage_of_float`, which returns
 * nothing for any name. Not cosmetic: technical.js gates its Squeeze Setup
 * signal on `shortFloat >= threshold`, so that signal has never fired once.
 *
 * Every US short interest number originates with FINRA — brokers report twice
 * a month and every vendor redistributes the same file — so the question is
 * not which source is right but which is reachable, and how it is denominated.
 */
const si = require('../src/sideC/shortInterest');

describe('Yahoo quoteSummary', () => {
  const YAHOO = {
    quoteSummary: {
      result: [{
        defaultKeyStatistics: {
          shortPercentOfFloat: { raw: 0.1234, fmt: '12.34%' },
          sharesShort: { raw: 5_000_000 },
          sharesShortPriorMonth: { raw: 4_000_000 },
          shortRatio: { raw: 3.2 },
          dateShortInterest: { raw: 1755129600 },
        },
      }],
    },
  };

  test('the fraction becomes a percentage at the edge, once', () => {
    // Yahoo gives 0.1234; the card prints 12.3%. Converting here rather than
    // in the render keeps one representation in the system.
    expect(si.parseYahoo(YAHOO).shortFloat).toBe(12.3);
  });

  test('only `raw` is read, never `fmt`', () => {
    // .fmt is "12.34%" — a string that looks like a number until something
    // does arithmetic on it.
    expect(typeof si.parseYahoo(YAHOO).shortFloat).toBe('number');
  });

  test('a rising short base is reported as rising', () => {
    expect(si.parseYahoo(YAHOO).trend).toBe('rising');
  });

  test('it says the number is a share of FLOAT', () => {
    expect(si.parseYahoo(YAHOO).basis).toBe('float');
  });

  test('an empty or malformed payload is null, not a zero', () => {
    // Zero percent short is a claim about the stock. No data is not.
    expect(si.parseYahoo({})).toBeNull();
    expect(si.parseYahoo(null)).toBeNull();
    expect(si.parseYahoo({ quoteSummary: { result: [{}] } })).toBeNull();
  });
});

describe("FINRA's own file", () => {
  const FINRA = [
    'symbolCode|securityName|currentShortPositionQuantity|settlementDate|averageDailyVolumeQuantity',
    'GME|GameStop|20000000|2026-08-15|4000000',
    'AAPL|Apple|1000000|2026-08-15|50000000',
  ].join('\n');

  test('a symbol is found by COLUMN NAME, not by position', () => {
    // FINRA has inserted columns before. A positional read silently returns
    // the wrong field the first time it happens again.
    expect(si.parseFinra(FINRA, 'GME').sharesShort).toBe(20_000_000);
  });

  test('days to cover is derived from the average daily volume', () => {
    expect(si.parseFinra(FINRA, 'GME').daysToCover).toBe(5);
  });

  test('it reports SHARES, and does not pretend to know a percentage', () => {
    const r = si.parseFinra(FINRA, 'GME');
    expect(r.shortFloat).toBeNull();
    expect(r.basis).toBe('shares');
  });

  test('a symbol that is not in the file is null', () => {
    expect(si.parseFinra(FINRA, 'NOSUCH')).toBeNull();
  });

  test('a truncated file does not throw', () => {
    expect(si.parseFinra('', 'GME')).toBeNull();
    expect(si.parseFinra('header only', 'GME')).toBeNull();
  });
});

describe('the denominator is never fudged', () => {
  const shares = { sharesShort: 20_000_000, shortFloat: null, basis: 'shares' };

  test('given a float, the percentage is of FLOAT and says so', () => {
    const r = si.toPercent(shares, { floatShares: 100_000_000 });
    expect(r.shortFloat).toBe(20);
    expect(r.basis).toBe('float');
  });

  test('given only shares outstanding, it says OUTSTANDING', () => {
    /*
     * Float and shares outstanding are different numbers and outstanding is
     * always the larger, so quoting one as the other understates a squeeze
     * every single time. The basis travels with the value.
     */
    const r = si.toPercent(shares, { sharesOutstanding: 400_000_000 });
    expect(r.shortFloat).toBe(5);
    expect(r.basis).toBe('outstanding');
  });

  test('float WINS when both are available', () => {
    const r = si.toPercent(shares,
      { floatShares: 100_000_000, sharesOutstanding: 400_000_000 });
    expect(r.basis).toBe('float');
  });

  test('with no denominator it stays shares, rather than inventing one', () => {
    expect(si.toPercent(shares, {}).shortFloat).toBeNull();
  });

  test('a value Yahoo already computed is left alone', () => {
    const y = { shortFloat: 12.3, basis: 'float' };
    expect(si.toPercent(y, { floatShares: 1 })).toBe(y);
  });
});

describe('Nasdaq, the third source', () => {
  const NAS = {
    data: {
      shortInterestTable: {
        rows: [
          { settlementDate: '08/15/2026', interest: '20,000,000', daysToCover: '5.2' },
          { settlementDate: '07/31/2026', interest: '18,000,000', daysToCover: '4.8' },
        ],
      },
    },
  };

  test('the newest settlement row is the current figure', () => {
    expect(si.parseNasdaq(NAS).sharesShort).toBe(20_000_000);
    expect(si.parseNasdaq(NAS).asOf).toBe('08/15/2026');
  });

  test('commas and symbols are stripped, not parsed as NaN', () => {
    expect(si.parseNasdaq(NAS).daysToCover).toBe(5.2);
  });

  test('the previous settlement gives the direction', () => {
    expect(si.parseNasdaq(NAS).trend).toBe('rising');
  });

  test('it reports SHARES, like FINRA — a float still has to come from us', () => {
    expect(si.parseNasdaq(NAS).basis).toBe('shares');
    expect(si.parseNasdaq(NAS).shortFloat).toBeNull();
  });

  test('an empty table is null, not zero', () => {
    expect(si.parseNasdaq({ data: { shortInterestTable: { rows: [] } } })).toBeNull();
    expect(si.parseNasdaq({})).toBeNull();
  });
});

describe('the order was earned by measurement', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../src/sideC/shortInterest.js'), 'utf8');
  const fn = src.match(/async function lookup[\s\S]*?\n\}/)[0];

  test('FINRA is tried FIRST', () => {
    /*
     * It was third, on the assumption that a ready-made percentage beat raw
     * shares. Measured on the real box, Yahoo 401'd and Nasdaq returned an
     * unexpected shape, so every symbol paid for two failures before reaching
     * the only source that answered — 300 wasted requests on a register day.
     */
    expect(fn.indexOf('fetchFinraFile')).toBeGreaterThan(-1);
    expect(fn.indexOf('fetchFinraFile')).toBeLessThan(fn.indexOf('fetchYahoo'));
    expect(fn.indexOf('fetchYahoo')).toBeLessThan(fn.indexOf('fetchNasdaq'));
  });

  test('...and the reason is ONE FILE for every symbol, not one per symbol', () => {
    expect(fn).toContain('ONE FILE');
    expect(fn).toContain('costs one request instead of 150');
  });

  test('the probe can be given a float, or its percentage reads as a failure', () => {
    const route = fs.readFileSync(
      path.join(__dirname, '../src/routes/market.js'), 'utf8');
    expect(route).toContain('req.query.float');
  });
});

describe('it can never be the reason a scan fails', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../src/sideC/shortInterest.js'), 'utf8');
  const pipeline = fs.readFileSync(
    path.join(__dirname, '../src/pipeline.js'), 'utf8');

  test('the stage is SOFT', () => {
    expect(pipeline).toMatch(/stageWrapSoft\(report, 'shortInterest'/);
  });

  test('lookup swallows its own errors and records the reason', () => {
    expect(src).toMatch(/catch \(e\) \{ diag\.error/);
    expect(src).toMatch(/rec = null;/);
  });

  test('a FAILURE is not cached, only an answer', () => {
    // Caching a miss would mean a source that recovered five minutes later
    // still reported nothing until tomorrow — and would make the probe
    // useless for debugging exactly the thing it exists to debug.
    expect(src).toContain('A CACHED FAILURE IS NOT CACHED');
    expect(src).toMatch(/hit\.day === day && hit\.rec/);
  });

  test('every source records WHY it failed', () => {
    // "No source answered" left three different problems looking identical:
    // Yahoo's cookie wall, a moved FINRA file, and a stock with genuinely no
    // reported short position.
    expect(src).toMatch(/diag\.yahoo =/);
    expect(src).toMatch(/diag\.nasdaq =/);
    expect(src).toMatch(/diag\.finra =/);
  });

  test('only rows MISSING the field are looked up', () => {
    // If the scanner ever starts serving the column, its value wins.
    expect(src).toContain('r.stock.shortFloat == null');
  });

  test('a per-symbol lookup is bounded, not fired 150 at once', () => {
    expect(src).toContain('concurrency');
  });

  test('cached for the day, because it only changes twice a month', () => {
    expect(src).toMatch(/TWICE A MONTH/);
  });
});
