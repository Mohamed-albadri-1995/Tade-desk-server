/*
 * THE SAME TRADE IS A DIFFERENT NUMBER OF SHARES IN A DIFFERENT ACCOUNT.
 *
 * One account size, one risk per trade and one position cap were the whole
 * truth while there was one broker. With a $5,000 prop-firm account and a
 * $20,000 Alpaca account both live, sizing against a single figure means one
 * of them is over-ordered and refused by the broker while the other is barely
 * used — and the share count on the alert belongs to neither of them.
 *
 * The fallback is what makes this safe to ship: an account that states nothing
 * of its own sizes exactly as the desk always did, so a single-broker setup is
 * bit-for-bit unchanged.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const RISK_FILE = path.join(os.tmpdir(), `risk-acct-${process.pid}.json`);
process.env.RISK_FILE = RISK_FILE;
const risk = require('../src/setups/risk');

/** The STANDARD account: $10,000, risking $100, a quarter of it per position.
 *  A reference — no order is ever placed against it. */
const STANDARD = { accountSize: 10000, riskPerTrade: 100, maxPositionPct: 25 };
beforeEach(() => risk.save(STANDARD));
afterAll(() => { try { fs.unlinkSync(RISK_FILE); } catch { /* absent */ } });

// A $2 stop on a $50 stock: the desk's $100 buys exactly 50 shares.
const TRADE = { entry: 50, riskPerShare: 2 };
const shares = (dest) => risk.sizeFor(TRADE, risk.forAccount(dest)).shares;

describe('an account that says nothing of its own', () => {
  test('sizes exactly as the standard does', () => {
    expect(shares(null)).toBe(50);
    expect(shares({ id: 'ttp' })).toBe(50);
    // …and that is the same number sizeFor gives with no cfg at all, which is
    // the path every single-broker install has always taken.
    expect(risk.sizeFor(TRADE).shares).toBe(50);
  });

  test('a destination with only a hook and a balance changes nothing', () => {
    expect(shares({ id: 'ttp', webhookUrl: 'x', buyingPower: 3000 })).toBe(50);
  });
});

describe('an account with its own capital', () => {
  test('a smaller account buys fewer shares', () => {
    // Half the standard halves the risk with it: $50 / $2 = 25.
    expect(shares({ id: 'ttp', scale: 0.5 })).toBe(25);
  });

  test('an absolute size is taken literally, not as a multiplier', () => {
    // $20,000 stated outright says what the account IS. It does not say what
    // is risked in it — that is riskPerTrade or scale, and inferring one from
    // the other would be this code choosing a risk nobody entered.
    const cfg = risk.forAccount({ id: 'alpaca', accountSize: 20000 });
    expect(cfg.accountSize).toBe(20000);
    expect(cfg.riskPerTrade).toBe(100);        // the standard's, untouched
  });

  test('a stated risk is used as stated, not scaled', () => {
    // Scaling is only a fallback for an account that named a size and no risk.
    // $100 / $2 is 50 shares by risk — but 25% of a $5,000 account is $1,250,
    // which at $50 is 25 shares, so the POSITION cap decides and says so. Both
    // caps are per account, and this is what it looks like when the second one
    // is the binding one.
    const sized = risk.sizeFor(TRADE, risk.forAccount(
      { id: 'x', accountSize: 5000, riskPerTrade: 100 }));
    expect(sized.shares).toBe(25);
    expect(sized.capped).toMatch(/risk allows 50, 25% of the account allows 25/);
    // The same stated risk in a big enough account is not capped at all.
    expect(shares({ id: 'x', accountSize: 40000, riskPerTrade: 100 })).toBe(50);
  });

  test('a risk with no size is used against the standard balance', () => {
    expect(shares({ id: 'x', riskPerTrade: 40 })).toBe(20);
  });
});

describe('an account described as a MULTIPLE of the standard', () => {
  /*
   * The trap this closes: a risk-per-trade chosen for a $20,000 account,
   * applied unchanged to a $5,000 one, is four times the intended risk — 2% of
   * the account instead of 0.5%. It is the same dollar figure, which is exactly
   * why nobody would notice it. Scale moves the size and the risk together, so
   * the percentage cannot drift.
   */
  test('half the standard is half the size and half the risk', () => {
    const cfg = risk.forAccount({ id: 'ttp', scale: 0.5 });
    expect(cfg.accountSize).toBe(5000);
    expect(cfg.riskPerTrade).toBe(50);
  });

  test('twice the standard is twice both', () => {
    const cfg = risk.forAccount({ id: 'alpaca', scale: 2 });
    expect(cfg.accountSize).toBe(20000);
    expect(cfg.riskPerTrade).toBe(200);
  });

  test('the PERCENTAGE risked is identical at every scale', () => {
    // The property that makes two accounts one strategy rather than two.
    const pct = c => c.riskPerTrade / c.accountSize;
    const std = pct(risk.forAccount(null));
    for (const scale of [0.25, 0.5, 1, 2, 3]) {
      expect(pct(risk.forAccount({ id: 'x', scale }))).toBeCloseTo(std, 10);
    }
  });

  test('two accounts on the SAME signal get different counts', () => {
    // The whole point, in one line.
    expect(shares({ id: 'ttp', scale: 0.5 })).not.toBe(shares({ id: 'alpaca', scale: 2 }));
  });

  test('an absolute figure beats the scale', () => {
    // For an account that is not a clean multiple of anything.
    expect(risk.forAccount({ id: 'x', scale: 2, riskPerTrade: 75 }).riskPerTrade).toBe(75);
    expect(risk.forAccount({ id: 'x', scale: 2, riskPerTrade: 75 }).accountSize).toBe(20000);
  });

  test('the position cap is NOT scaled — it is already a percentage', () => {
    // 25% of a doubled account is double the money by construction. Scaling it
    // too would compound the multiplier and make 25% mean 50%.
    expect(risk.forAccount({ id: 'x', scale: 2 }).maxPositionPct).toBe(25);
  });

  test('with no standard to scale from, nothing is invented', () => {
    risk.save({ accountSize: null, riskPerTrade: null });
    expect(risk.forAccount({ id: 'x', scale: 2 }).riskPerTrade).toBeNull();
    // …and no risk means no size, rather than a made-up one.
    expect(risk.sizeFor(TRADE, risk.forAccount({ id: 'x', scale: 2 }))).toBeNull();
  });
});

describe('the position cap is per account too', () => {
  test('a tighter cap on one account bites only there', () => {
    // 10% of $10,000 is $1,000, which at $50 is 20 shares — under the 50 the
    // risk allows, so the cap is what decides.
    const capped = risk.sizeFor(TRADE, risk.forAccount({ id: 'a', maxPositionPct: 10 }));
    expect(capped.shares).toBe(20);
    expect(capped.capped).toMatch(/capped by position size/);
    expect(shares({ id: 'b' })).toBe(50);
  });

  test('it is a percent of THIS account, not of the desk', () => {
    // 25% of $4,000 is $1,000 → 20 shares, even though 25% of the desk is 50.
    expect(shares({ id: 'a', accountSize: 4000, riskPerTrade: 100 })).toBe(20);
  });
});

test('the account is named on the cfg, so a preview can say which one it is', () => {
  expect(risk.forAccount({ destinationId: 'alpaca', destinationName: 'Alpaca' }).account)
    .toBe('Alpaca');
});
