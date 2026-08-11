const { classifyCatalyst, classifyCatalysts } = require('../src/sideC/news');
const { detectTechnicalCatalysts, combineCatalyst } = require('../src/sideC/technical');
const { resolveAutoBias } = require('../src/sideC/bias');

describe('Side C — Catalyst Classification', () => {
  test('FDA approval headline → FDA Approval', () => {
    const r = classifyCatalyst(['Company receives FDA approval for drug XYZ']);
    expect(r).not.toBeNull();
    expect(r.label).toBe('FDA Approval');
    expect(r.sentiment).toBe('bull');
    expect(r.tier).toBe(1);
  });

  test('FDA CRL headline → FDA Rejection', () => {
    const r = classifyCatalyst(['Company receives FDA CRL for proposed drug']);
    expect(r.label).toBe('FDA Rejection');
    expect(r.sentiment).toBe('bear');
  });

  test('earnings beat → Earnings Beat', () => {
    const r = classifyCatalyst(['Company reports earnings beat of analyst estimates']);
    expect(r.label).toBe('Earnings Beat');
    expect(r.sentiment).toBe('bull');
  });

  test('earnings miss → Earnings Miss', () => {
    const r = classifyCatalyst(['Company reports earnings miss']);
    expect(r.label).toBe('Earnings Miss');
    expect(r.sentiment).toBe('bear');
  });

  /*
   * This asserted M&A/bull, which was the old single label for both sides of a
   * deal. A company announcing it is buying a rival is the one paying the
   * premium — that is not the bullish event a takeover target is, and calling
   * them the same thing told the card the wrong story half the time. See the
   * "one event, one name" block below.
   */
  test('announcing an acquisition → Acquiring, and not bullish', () => {
    const r = classifyCatalyst(['Company announces acquisition of rival']);
    expect(r.label).toBe('Acquiring');
    expect(r.sentiment).toBe('neutral');
  });

  test('being the target → Takeover Target (bull)', () => {
    const r = classifyCatalyst(['Company receives buyout offer at $40 per share']);
    expect(r.label).toBe('Takeover Target');
    expect(r.sentiment).toBe('bull');
  });

  test('offering → Dilution (bear)', () => {
    const r = classifyCatalyst(['Company announces secondary offering of shares']);
    expect(r.label).toBe('Dilution');
    expect(r.sentiment).toBe('bear');
  });

  test('higher priority wins', () => {
    // FDA approval vs M&A — both tier 1, FDA outranks on tie-break
    const r = classifyCatalyst(['Company gets FDA approval and announces acquisition of rival']);
    expect(r.label).toBe('FDA Approval');
  });

  test('no match → null', () => {
    const r = classifyCatalyst(['Company announces quarterly dividend']);
    expect(r).toBeNull();
  });

  test('lawsuit → Legal Risk (bear)', () => {
    const r = classifyCatalyst(['Company faces lawsuit from class action attorneys']);
    expect(r.label).toBe('Legal Risk');
    expect(r.sentiment).toBe('bear');
  });
});

describe('Side C — calendar/scheduled earnings are NOT a catalyst', () => {
  test('earnings date announcement → null', () => {
    expect(classifyCatalyst(['ACME to report Q2 earnings on Tuesday'])).toBeNull();
    expect(classifyCatalyst(['ACME announces date of second quarter earnings call'])).toBeNull();
    expect(classifyCatalyst(['What to expect from ACME earnings this week'])).toBeNull();
    expect(classifyCatalyst(['ACME schedules conference call to discuss Q3 results'])).toBeNull();
  });

  test('actual reported results without direction → neutral tier-2 Earnings', () => {
    const r = classifyCatalyst(['ACME reports second-quarter results']);
    expect(r.label).toBe('Earnings');
    expect(r.sentiment).toBe('neutral');
    expect(r.tier).toBe(2);
  });

  test('beat suppresses the generic Earnings sibling — one event, one catalyst', () => {
    const r = classifyCatalyst([
      'ACME reports second-quarter results',
      'ACME Q2 earnings beat analyst estimates',
    ]);
    expect(r.label).toBe('Earnings Beat');
    expect(r.others.map(o => o.label)).not.toContain('Earnings');
  });
});

describe('Side C — same event reworded → one catalyst, corroborated', () => {
  test('two wordings of one beat merge into a single catalyst', () => {
    const r = classifyCatalyst([
      'ACME beats Q2 estimates',
      'ACME tops expectations in second quarter',
    ]);
    expect(r.label).toBe('Earnings Beat');
    expect(r.corroboration).toBe(2);
    expect(r.others).toHaveLength(0);
  });

  test('identical headline from two feeds counted once', () => {
    const r = classifyCatalyst([
      'ACME wins $50 million defense contract',
      'ACME Wins $50 Million Defense Contract',
    ]);
    expect(r.label).toBe('Contract Win');
    expect(r.corroboration).toBe(1);
  });

  test('phrases never match across headline boundaries', () => {
    // Old joined-text classifier saw "...earnings" + "Beat..." as "earnings beat"
    const r = classifyCatalyst(['Strong quarter ahead for earnings', 'Beat the drum on ACME']);
    expect(r).toBeNull();
  });
});

describe('Side C — loose-word false positives are guarded', () => {
  test('"offering" in a product sense does not mean dilution', () => {
    expect(classifyCatalyst(['ACME now offering customers same-day delivery'])).toBeNull();
    expect(classifyCatalyst(['ACME expands its product offering in Europe'])).toBeNull();
  });

  test('real securities offerings still match', () => {
    expect(classifyCatalyst(['ACME prices upsized offering of common stock']).label).toBe('Dilution');
    expect(classifyCatalyst(['ACME announces registered direct offering']).label).toBe('Dilution');
    expect(classifyCatalyst(['ACME announces $10M private placement']).label).toBe('Dilution');
  });

  test('bare "deal"/"contract" chatter does not fire; real awards do', () => {
    expect(classifyCatalyst(['Is ACME stock a good deal right now?'])).toBeNull();
    expect(classifyCatalyst(['ACME awarded $25 million contract by US Navy']).label).toBe('Contract Win');
  });

  test('law-firm class-action solicitation spam is ignored', () => {
    expect(classifyCatalyst(['ROSEN LAW reminds investors of lead plaintiff deadline in ACME class action'])).toBeNull();
  });

  test('customer/talent acquisition is not M&A', () => {
    expect(classifyCatalyst(['ACME improves customer acquisition costs'])).toBeNull();
  });
});

describe('Side C — expanded coverage', () => {
  const cases = [
    ['ACME raises full-year guidance', 'Guidance Raise', 'bull', 1],
    ['ACME cuts fiscal 2026 outlook', 'Guidance Cut', 'bear', 1],
    ['ACME issues profit warning', 'Guidance Cut', 'bear', 1],
    ['Hindenburg Research publishes report on ACME', 'Short Report', 'bear', 1],
    ['ACME files for Chapter 11 bankruptcy protection', 'Bankruptcy', 'bear', 1],
    ['ACME phase 3 trial met its primary endpoint', 'Trial Win', 'bull', 1],
    ['ACME drug failed to meet primary endpoint', 'Trial Fail', 'bear', 1],
    ['ACME granted FDA fast-track designation', 'FDA Designation', 'bull', 2],
    ['ACME announces $500 million share repurchase program', 'Buyback', 'bull', 2],
    ['ACME announces 1-for-10 reverse stock split', 'Reverse Split', 'bear', 2],
    ['ACME announces 3-for-1 stock split', 'Stock Split', 'bull', 2],
    ['ACME set to join the S&P 500', 'Index Add', 'bull', 2],
    ['ACME approved for listing on Nasdaq', 'Uplisting', 'bull', 2],
    ['ACME receives non-compliance notice from Nasdaq', 'Delisting Risk', 'bear', 2],
    ['ACME suspends its quarterly dividend', 'Dividend Cut', 'bear', 2],
    ['ACME signs strategic partnership with MegaCorp', 'Partnership', 'bull', 2],
    ['ACME files mixed shelf registration', 'Shelf Filing', 'bear', 3],
    ['ACME CEO bought 100,000 shares', 'Insider Buy', 'bull', 3],
    ['ACME cuts 15% of its workforce', 'Restructuring', 'neutral', 3],
  ];
  test.each(cases)('%s → %s', (headline, label, sentiment, tier) => {
    const r = classifyCatalyst([headline]);
    expect(r).not.toBeNull();
    expect(r.label).toBe(label);
    expect(r.sentiment).toBe(sentiment);
    expect(r.tier).toBe(tier);
  });
});

describe('Side C — importance ranking & secondary catalysts', () => {
  test('tier-1 dilution outranks tier-3 insider buy; both are surfaced', () => {
    const r = classifyCatalyst([
      'ACME CEO bought 10,000 shares',
      'ACME prices public offering of common stock',
    ]);
    expect(r.label).toBe('Dilution');
    expect(r.tier).toBe(1);
    expect(r.others.map(o => o.label)).toContain('Insider Buy');
  });

  test('a priced offering (tier 1) silences its own shelf-filing sibling', () => {
    const r = classifyCatalyst([
      'ACME files shelf registration',
      'ACME announces underwritten offering of common stock',
    ]);
    expect(r.label).toBe('Dilution');
    expect(r.others.map(o => o.label)).not.toContain('Shelf Filing');
  });

  test('fresh news scores above week-old news of equal tier', () => {
    const now = Date.now();
    const hits = classifyCatalysts([
      { headline: 'ACME announces acquisition of rival', ts: now - 6 * 86400000 },
      { headline: 'ACME receives FDA approval for device', ts: now - 2 * 3600000 },
    ], now);
    expect(hits[0].def.label).toBe('FDA Approval');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  test('stale flag set on week-old evidence', () => {
    const now = Date.now();
    const r = classifyCatalyst(
      [{ headline: 'ACME announces acquisition of rival', ts: now - 6 * 86400000 }],
      now
    );
    expect(r.stale).toBe(true);
    expect(r.confidence).not.toBe('high');
  });

  test('confidence: fresh corroborated tier-1 is high', () => {
    const now = Date.now();
    const r = classifyCatalyst([
      { headline: 'ACME Q2 earnings beat estimates', ts: now - 3600000 },
      { headline: 'ACME tops expectations for the quarter', ts: now - 7200000 },
    ], now);
    expect(r.confidence).toBe('high');
  });
});

describe('Side C — one event, one catalyst (all categories, not just earnings)', () => {
  test('FDA approval + trial data in one headline → single catalyst', () => {
    const r = classifyCatalyst(['FDA grants approval to ACME after positive topline results']);
    expect(r.label).toBe('FDA Approval');
    expect(r.others.map(o => o.label)).not.toContain('Trial Win');
  });

  test('opposite directions from one headline both survive', () => {
    const r = classifyCatalyst(['ACME earnings beat estimates but company cuts full-year guidance']);
    expect(r.label).toBe('Earnings Beat');
    expect(r.others.map(o => o.label)).toContain('Guidance Cut');
  });

  test('separate events on separate headlines both survive', () => {
    const r = classifyCatalyst([
      'ACME wins $30 million defense contract',
      'ACME announces $200 million buyback program',
    ]);
    const labels = [r.label, ...r.others.map(o => o.label)];
    expect(labels).toContain('Contract Win');
    expect(labels).toContain('Buyback');
  });

  test('upgrade and downgrade from different analysts both survive', () => {
    const r = classifyCatalyst([
      'BigBank upgrades ACME to buy',
      'OtherBank downgrades ACME on valuation',
    ]);
    const labels = [r.label, ...r.others.map(o => o.label)];
    expect(labels).toContain('Upgrade');
    expect(labels).toContain('Downgrade');
  });

  test('a won lawsuit is not Legal Risk', () => {
    const r = classifyCatalyst(['ACME wins lawsuit against rival']);
    expect(r.label).toBe('Legal Win');
    expect(r.sentiment).toBe('bull');
  });
});

describe('Side C — technical catalysts', () => {
  const quiet = { gapPct: 0.5, rvol: 1.1, change: 0.4, price: 50, monthHigh: 60, monthLow: 40, adrPct: 3, shortFloat: 4 };
  const gapper = { gapPct: 8, rvol: 6, change: 9, price: 50, monthHigh: 60, monthLow: 40, adrPct: 3, shortFloat: 4 };

  test('quiet tape → no technical catalyst', () => {
    expect(detectTechnicalCatalysts(quiet)).toHaveLength(0);
  });

  test('missing data → no technical catalyst, no crash', () => {
    expect(detectTechnicalCatalysts(null)).toHaveLength(0);
    expect(detectTechnicalCatalysts({})).toHaveLength(0);
  });

  test('big gap on volume → Gap Up, and the move family yields only one', () => {
    const t = detectTechnicalCatalysts(gapper);
    const moveLabels = t.map(x => x.label).filter(l => ['Gap Up', 'Big Move Up', 'Volume Surge'].includes(l));
    expect(moveLabels).toEqual(['Gap Up']);
    expect(t[0].source).toBe('technical');
  });

  test('breakout above monthly high detected', () => {
    const t = detectTechnicalCatalysts({ ...quiet, price: 61, rvol: 3, change: 6 });
    expect(t.map(x => x.label)).toContain('Monthly Breakout');
  });

  test('no news → technical becomes primary with capped confidence', () => {
    const c = combineCatalyst(null, gapper);
    expect(c.label).toBe('Gap Up');
    expect(c.source).toBe('technical');
    expect(c.confidence).toBe('medium');
  });

  test('news always outranks technicals; aligned technical goes to others', () => {
    const news = classifyCatalyst(['ACME receives FDA approval for device']);
    const c = combineCatalyst(news, gapper);
    expect(c.label).toBe('FDA Approval');
    expect(c.others.map(o => o.label)).toContain('Gap Up');
  });

  test('technical contradicting the news primary is dropped — no fighting', () => {
    const news = classifyCatalyst(['ACME announces public offering of common stock']); // bear
    const c = combineCatalyst(news, gapper); // gap UP (bull)
    expect(c.label).toBe('Dilution');
    expect((c.others || []).map(o => o.label)).not.toContain('Gap Up');
  });

  test('neutral news primary accepts a directional technical', () => {
    const news = classifyCatalyst(['ACME reports second-quarter results']); // neutral
    const c = combineCatalyst(news, gapper);
    expect(c.label).toBe('Earnings');
    expect(c.others.map(o => o.label)).toContain('Gap Up');
  });
});

describe('Side C — auto bias from catalyst type', () => {
  const bullCtx = { shortTerm: 'BULLISH', secBias: 'BULLISH', longTerm: 'BULLISH' };
  const bearCtx = { shortTerm: 'BEARISH', secBias: 'BEARISH', longTerm: 'BEARISH' };

  test('manual bias always wins', () => {
    const r = resolveAutoBias({ bias: 'short', catalyst: { sentiment: 'bull', tier: 1 }, context: bullCtx });
    expect(r).toMatchObject({ bias: 'short', source: 'manual' });
  });

  test('tier-1 catalyst overrides even a fully opposed tape', () => {
    const r = resolveAutoBias({ bias: 'auto', catalyst: { label: 'FDA Rejection', sentiment: 'bear', tier: 1, stale: false }, context: bullCtx });
    expect(r).toMatchObject({ bias: 'short', source: 'catalyst' });
  });

  test('tier-2 catalyst follows unless trend AND sector both oppose', () => {
    const cat = { label: 'Contract Win', sentiment: 'bull', tier: 2, stale: false };
    expect(resolveAutoBias({ bias: 'auto', catalyst: cat, context: { shortTerm: 'BEARISH', secBias: 'NEUTRAL' } }))
      .toMatchObject({ bias: 'long', source: 'catalyst' });
    expect(resolveAutoBias({ bias: 'auto', catalyst: cat, context: bearCtx }))
      .toMatchObject({ bias: 'short', source: 'context' });
  });

  test('tier-3, neutral, or stale catalysts fall back to context', () => {
    expect(resolveAutoBias({ bias: 'auto', catalyst: { sentiment: 'bull', tier: 3, stale: false }, context: bearCtx }).source).toBe('context');
    expect(resolveAutoBias({ bias: 'auto', catalyst: { sentiment: 'neutral', tier: 2, stale: false }, context: bearCtx }).source).toBe('context');
    expect(resolveAutoBias({ bias: 'auto', catalyst: { sentiment: 'bear', tier: 1, stale: true }, context: bullCtx }))
      .toMatchObject({ bias: 'long', source: 'context' });
  });

  test('no catalyst → the tape decides, when the tape says anything', () => {
    expect(resolveAutoBias({ bias: 'auto', context: bearCtx }).bias).toBe('short');
    expect(resolveAutoBias({ bias: 'auto', context: bullCtx }).bias).toBe('long');
  });

  /*
   * This used to end `return 'long'` and this test used to assert it. An empty
   * context means the short-term trend, the sector and the long-term view all
   * declined to answer — that is the absence of a bias, and returning one
   * anyway made it indistinguishable on the card from a read that was earned.
   * The nine cards biased this way in the backups went 0 for 9.
   */
  test('nothing to go on → no bias, rather than a default', () => {
    const r = resolveAutoBias({ bias: 'auto', context: {} });
    expect(r.bias).toBeNull();
    expect(r.source).toBe('none');
  });

  test('a partial context still answers when one leg is clear', () => {
    expect(resolveAutoBias({ bias: 'auto', context: { shortTerm: 'BULLISH' } }).bias).toBe('long');
    expect(resolveAutoBias({ bias: 'auto', context: { secBias: 'BEARISH' } }).bias).toBe('short');
    expect(resolveAutoBias({ bias: 'auto', context: { shortTerm: 'NEUTRAL', secBias: 'NEUTRAL' } }).bias).toBeNull();
  });

  /*
   * The long-term market view no longer sets a stock's direction.
   *
   * Measured across all nine tools: longTerm was BULLISH on every row of every
   * tool for the whole sample — it is SPY above its 200-day with a golden
   * cross, which simply did not change. As the last rung it therefore fired
   * whenever the others declined and always said "long", so the ladder
   * answered on 100% of rows and matched always-long exactly in six of nine
   * tools.
   *
   * The claim it was making is the real objection: "the index is above its
   * 200-day, therefore THIS stock is a long" says nothing about the stock, and
   * it was the default answer for every card without a catalyst.
   */
  test('the long-term market view alone is no longer a direction', () => {
    expect(resolveAutoBias({ bias: 'auto', context: { longTerm: 'BULLISH' } }).bias).toBeNull();
    expect(resolveAutoBias({ bias: 'auto', context: { longTerm: 'BEARISH' } }).bias).toBeNull();
  });

  test('…and it cannot overturn what the stock and its sector say', () => {
    // The failure mode being guarded against is removing it from the ladder but
    // leaving it able to tip a decision somewhere else.
    const bullTape = { shortTerm: 'BULLISH', secBias: 'NEUTRAL' };
    for (const lt of ['BULLISH', 'BEARISH', 'RECOVERING', 'WEAKENING', undefined]) {
      expect({ lt, bias: resolveAutoBias({ bias: 'auto', context: { ...bullTape, longTerm: lt } }).bias })
        .toEqual({ lt, bias: 'long' });
    }
  });

  test('a card with only the market to go on now says nothing at all', () => {
    // This is the change that makes the earlier "no default" fix real: with the
    // long-term rung in place it never once took effect on live data.
    const r = resolveAutoBias({ bias: 'auto', context: { longTerm: 'BULLISH', shortTerm: 'NEUTRAL', secBias: 'NEUTRAL' } });
    expect(r.bias).toBeNull();
    expect(r.source).toBe('none');
  });

  /*
   * A technical catalyst is the screener's own filter restated — "Gap Up" on a
   * gap screener, where every stock gapped. 39 of 100 catalysts in the backups
   * were technicals, 30 of them Gap Up, and each set a bias at tier 2.
   */
  test('a technical catalyst does not set bias', () => {
    const tech = { label: 'Gap Up', sentiment: 'bull', tier: 2, stale: false, source: 'technical' };
    // …even when the tape would not have given a direction on its own
    const r = resolveAutoBias({ bias: 'auto', catalyst: tech, context: {} });
    expect(r.bias).toBeNull();
    expect(r.source).toBe('none');
    // …and even at tier 1
    const major = { ...tech, tier: 1 };
    expect(resolveAutoBias({ bias: 'auto', catalyst: major, context: {} }).bias).toBeNull();
    // the same catalyst from a story still does
    const story = { ...tech, source: 'news' };
    expect(resolveAutoBias({ bias: 'auto', catalyst: story, context: {} }))
      .toMatchObject({ bias: 'long', source: 'catalyst' });
  });

  test('a technical catalyst never overrides the tape either', () => {
    const tech = { label: 'Gap Up', sentiment: 'bull', tier: 1, stale: false, source: 'technical' };
    expect(resolveAutoBias({ bias: 'auto', catalyst: tech, context: bearCtx }))
      .toMatchObject({ bias: 'short', source: 'context' });
  });
});

describe('Side C — live-deploy findings (2026-07-13)', () => {
  test('coverage initiation with company name in between still classifies', () => {
    expect(classifyCatalyst(['Zacks Initiates Coverage of SUNation With Underperform Recommendation']).label).toBe('Downgrade');
    expect(classifyCatalyst(['BigBank initiates coverage of ACME Corp with a Buy rating']).label).toBe('Upgrade');
  });

  test('stale news catalyst yields primary to a fresh technical, stays visible', () => {
    const now = Date.now();
    // Reverse split announced weeks ago; stock gapping up huge today
    const news = classifyCatalyst(
      [{ headline: 'ACME announces 1-for-100 reverse stock split', ts: now - 25 * 86400000 }], now);
    expect(news.stale).toBe(true);
    const c = combineCatalyst(news, { gapPct: 38, rvol: 1800, change: 85, price: 2.2, monthHigh: 3.2, monthLow: 1.0, adrPct: 15 });
    expect(c.label).toBe('Gap Up');
    expect(c.source).toBe('technical');
    expect(c.others.map(o => o.label)).toContain('Reverse Split');
  });

  test('fresh news catalyst still outranks the technical', () => {
    const now = Date.now();
    const news = classifyCatalyst(
      [{ headline: 'ACME announces 1-for-100 reverse stock split', ts: now - 2 * 3600000 }], now);
    const c = combineCatalyst(news, { gapPct: -12, rvol: 8, change: -14, price: 2.2, monthHigh: 12, monthLow: 2.5, adrPct: 15 });
    expect(c.label).toBe('Reverse Split');
    expect(c.others.map(o => o.label)).toContain('Gap Down');
  });
});

/*
 * Two ways a classifier can be wrong about names, both raised from live use:
 * giving one event two names because it was worded differently, and giving two
 * different events the same name because they share a word.
 */
describe('Side C — one event, one name; one name, one event', () => {
  const ts = Date.now();
  const labels = (h) => classifyCatalysts([{ headline: h, ts }]).map(x => x.def.label);
  const label = (h) => labels(h)[0] || null;

  // ── the same event, said five ways ──────────────────────────────────────
  test.each([
    ['Company prices $100M public offering'],
    ['Company announces at-the-market program'],
    ['Company completes private placement'],
    ['Company announces registered direct offering'],
    ['Company prices upsized offering of common stock'],
  ])('%s → Dilution', (h) => expect(label(h)).toBe('Dilution'));

  test.each([
    ['Q2 earnings beat estimates'],
    ['Company tops Wall Street consensus'],
    ['Blowout quarter as revenue surpasses forecasts'],
    ['Earnings exceed analyst expectations'],
  ])('%s → Earnings Beat', (h) => expect(label(h)).toBe('Earnings Beat'));

  /*
   * A European marketing authorisation is an FDA approval with a different
   * agency's name on it. It gets the same label, because inventing a second
   * one would be two names for one event — which is the thing this describe
   * block exists to prevent.
   */
  test.each([
    ['FDA grants approval for lead drug'],
    ['Arrowhead Reports Marketing Authorization for Redemplo in EU'],
    ['Company receives CE mark for its device'],
    ['Drug approved in Japan'],
  ])('%s → FDA Approval', (h) => expect(label(h)).toBe('FDA Approval'));

  // Late filing puts a company on the same clock to the same delisting.
  test.each([
    ['Company receives deficiency notice from Nasdaq'],
    ['INVO Fertility Receives Nasdaq Notification Regarding Late Filing of Quarterly Report'],
    ['Company unable to timely file its annual report'],
  ])('%s → Delisting Risk', (h) => expect(label(h)).toBe('Delisting Risk'));

  // ── different events that share a word ──────────────────────────────────
  /*
   * Being bought and doing the buying are opposite trades: a target gaps to
   * the offer price, an acquirer sells off because it is paying the premium.
   * One label marked bullish told the card the wrong thing half the time.
   */
  test('being acquired and acquiring are not the same catalyst', () => {
    expect(label('Company receives unsolicited buyout offer at $40/share')).toBe('Takeover Target');
    expect(label('Company agrees to be acquired by X')).toBe('Takeover Target');
    expect(label('Company to acquire rival for $2B')).toBe('Acquiring');
    expect(label('Company completes acquisition of SmallCo')).toBe('Acquiring');
  });

  test('the target reading is bullish, the acquirer reading is not', () => {
    const t = classifyCatalysts([{ headline: 'Company agrees to be acquired by X', ts }])[0];
    const a = classifyCatalysts([{ headline: 'Company to acquire rival for $2B', ts }])[0];
    expect(t.def.sentiment).toBe('bull');
    expect(a.def.sentiment).toBe('neutral');
    expect(t.def.tier).toBeLessThan(a.def.tier);   // the target moves harder
  });

  test('wording that does not say which side stays neutral rather than guessing', () => {
    expect(label('Company merges with peer in all-stock deal')).toBe('M&A');
  });

  test('one merger story still yields one catalyst, not three', () => {
    // All three live in the same family precisely so this cannot happen.
    expect(labels('Company agrees to be acquired by X in a merger agreement')).toHaveLength(1);
  });

  /*
   * "Halted" is two unrelated events. A biotech stopping a study is a failed
   * drug; a stock stopping on a circuit breaker is volatility, and it was on
   * the WYHG card the day it moved 205%.
   */
  test('a trial halt and a trading halt are different catalysts', () => {
    expect(label('Company halts enrollment in its Phase 3 trial')).toBe('Trial Fail');
    expect(label('Shares halted on circuit breaker to the downside')).toBe('Trading Halt');
    expect(label('Trading halted pending news')).toBe('Trading Halt');
    expect(label('FDA places lead program on clinical hold')).toBe('FDA Rejection');
  });

  test('a trading halt takes no direction — the exchange did not say which way', () => {
    const h = classifyCatalysts([{ headline: 'Shares halted on circuit breaker', ts }])[0];
    expect(h.def.sentiment).toBe('neutral');
  });

  test('buying back your own shares is not buying a company', () => {
    expect(label('Company announces $50M share repurchase program')).toBe('Buyback');
    expect(label('Company announces $50M registered direct offering')).toBe('Dilution');
  });

  /*
   * "buys" was briefly in the acquisition pattern and matched fifty-eight
   * headlines, most of them brokers rating shares. One loose verb is enough to
   * fill a category with the wrong events.
   */
  test.each([
    ['UBS Adjusts JFrog Price Target to $92 From $80, Maintains Buy Rating'],
    ['Is Lexicon Pharmaceuticals (LXRX) A Good Stock To Buy Now?'],
    ['1 Russell 2000 Stock on Our Buy List and 2 That Underwhelm'],
    ['Lexicon vs. Pfizer: Which Drugmaker Stock Is a Better Buy in 2026?'],
  ])('analyst language is not an acquisition: %s', (h) => {
    expect(label(h)).not.toBe('Acquiring');
  });

  test('a real acquisition still lands', () => {
    expect(label('Rocket Lab to acquire Iridium in $8bn cash and stock deal')).toBe('Acquiring');
    expect(label('Sadot Completes Acquisition of Anira Consulting')).toBe('Acquiring');
  });

  test('index inclusion is caught however the index is named', () => {
    expect(label('AtaiBeckley to Join the Russell Indexes')).toBe('Index Add');
    expect(label('Company added to the S&P 500')).toBe('Index Add');
  });

  // The guards that were already there must survive all of the above.
  test('regaining compliance is not delisting risk', () => {
    expect(label('Company regains compliance with Nasdaq minimum bid price')).toBeNull();
  });

  test('a scheduled earnings date is still not a catalyst', () => {
    expect(label('Company to report Q2 earnings Tuesday')).toBeNull();
  });
});
