/*
 * ONE CALCULATION, THEN ONE FRACTION EACH.
 *
 * The standard account is a reference and nothing is traded against it. A
 * signal is worked out ONCE against it — entry, stop, target, share count —
 * and only then does anything ask which broker it is going to. Each account
 * says what fraction of the standard it is, a $5,000 account against a
 * $100,000 standard being 0.05, and takes that fraction of the share count.
 *
 * What this replaces: every account carrying its own account size and its own
 * risk per trade, and the whole calculation being run again for each. Two
 * derivations of one number is two chances to disagree, and the position cap
 * interacting with a second balance produced share counts nobody predicted.
 *
 * The stop and the target never appear here, which is the point: they are
 * properties of the TRADE. Where the setup says it is wrong and where it says
 * it is done do not change because the money came from a different account.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const RISK_FILE = path.join(os.tmpdir(), `risk-ratio-${process.pid}.json`);
process.env.RISK_FILE = RISK_FILE;
const risk = require('../src/setups/risk');

/** The standard: $100,000 risking $1,000, no position cap in the way. */
const STANDARD = { accountSize: 100000, riskPerTrade: 1000, maxPositionPct: 100 };
beforeEach(() => risk.save(STANDARD));
afterAll(() => { try { fs.unlinkSync(RISK_FILE); } catch { /* absent */ } });

// A $2 stop on a $50 stock: $1,000 of risk buys exactly 500 shares.
const TRADE = { entry: 50, riskPerShare: 2 };
const std = () => risk.sizeFor(TRADE);
const sharesAt = (ratio) => risk.scaleTo(std(), { id: 'x', ratio }).shares;

describe('the standard account decides the trade', () => {
  test('it is sized once, against the standard', () => {
    expect(std().shares).toBe(500);
    expect(std().riskDollars).toBe(1000);
  });

  test('an account that says nothing is the standard itself', () => {
    expect(risk.scaleTo(std(), null).shares).toBe(500);
    expect(risk.scaleTo(std(), { id: 'x' }).shares).toBe(500);
  });

  test('a hook and a balance change nothing about the size', () => {
    // Buying power is what an account may SPEND today. The share count comes
    // from the standard and the ratio, and from nothing else.
    expect(risk.scaleTo(std(), { id: 'x', webhookUrl: 'x', buyingPower: 3000 }).shares)
      .toBe(500);
  });
});

describe('each account takes its own fraction', () => {
  test('a $5,000 account against a $100,000 standard', () => {
    expect(sharesAt(0.05)).toBe(25);
  });

  test('a fifth, a half, the whole thing', () => {
    expect([sharesAt(0.2), sharesAt(0.5), sharesAt(1)]).toEqual([100, 250, 500]);
  });

  test('two accounts on the SAME signal get different counts', () => {
    expect(sharesAt(0.05)).not.toBe(sharesAt(1));
  });

  test('the fraction is exact — a small account holds the same trade', () => {
    // 5% of the standard's risk, not 5% of something re-derived.
    const small = risk.scaleTo(std(), { id: 'x', ratio: 0.05 });
    expect(small.riskDollars).toBe(50);
    expect(small.riskDollars / std().riskDollars).toBeCloseTo(0.05, 10);
  });

  test('`scale` is still read, so an older config means what it meant', () => {
    expect(risk.scaleTo(std(), { id: 'x', scale: 0.5 }).shares).toBe(250);
  });
});

describe('whole shares, always floored', () => {
  /*
   * 0.05 of 137 shares is 6.85, and a broker takes 6. Asking for 7 is asking
   * for 2% more risk than the account agreed to, on every trade, in the
   * direction that costs money.
   */
  const odd = () => risk.sizeFor({ entry: 50, riskPerShare: 7.3 });   // 136 shares

  test('a fraction is floored, never rounded up', () => {
    expect(odd().shares).toBe(136);
    expect(risk.scaleTo(odd(), { id: 'x', ratio: 0.05 }).shares).toBe(6);   // 6.8
  });

  test('the rounding is stated when it cost something', () => {
    const s = risk.scaleTo(odd(), { id: 'x', ratio: 0.05 });
    expect(s.floored).toMatch(/6\.80 floored to 6/);
    // …and stays silent when it came out even.
    expect(risk.scaleTo(std(), { id: 'x', ratio: 0.5 }).floored).toBeNull();
  });

  test('what the standard said is kept beside what the account gets', () => {
    // "6 of 136" is the only form in which a share count can be checked at a
    // glance against the alert that produced it.
    const s = risk.scaleTo(odd(), { id: 'x', ratio: 0.05 });
    expect(s.standardShares).toBe(136);
    expect(s.shares).toBe(6);
  });

  test('an account too small for one share says so, and sends nothing', () => {
    const s = risk.scaleTo(std(), { id: 'x', ratio: 0.001 });
    expect(s.shares).toBe(0);
    expect(s.reason).toMatch(/under one whole share/);
  });
});

describe('what does NOT change per account', () => {
  test('the risk per share is the trade, not the account', () => {
    // Nothing in scaleTo touches entry, stop or target. If it ever does, the
    // small account is holding a different trade from the one that was
    // alerted, under the same name.
    const s = risk.scaleTo(std(), { id: 'x', ratio: 0.05 });
    expect(s.entry).toBeUndefined();
    expect(s.stop).toBeUndefined();
    expect(s.target).toBeUndefined();
  });

  test('with no standard set, nothing is invented', () => {
    risk.save({ accountSize: null, riskPerTrade: null });
    expect(risk.sizeFor(TRADE)).toBeNull();
    expect(risk.scaleTo(null, { id: 'x', ratio: 0.5 })).toBeNull();
  });
});

test('the account is named on the result, so a preview can say which one', () => {
  expect(risk.scaleTo(std(), { destinationId: 'alpaca', destinationName: 'Alpaca' }).account)
    .toBe('Alpaca');
});
