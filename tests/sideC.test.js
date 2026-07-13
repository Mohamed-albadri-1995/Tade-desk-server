const { classifyCatalyst, classifyCatalysts } = require('../src/sideC/news');

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

  test('acquisition → M&A (bull)', () => {
    const r = classifyCatalyst(['Company announces acquisition of rival']);
    expect(r.label).toBe('M&A');
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
