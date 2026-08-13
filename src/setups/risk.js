/*
 * Account size and risk per trade, and the share count that falls out of them.
 *
 * WHY THE SETUP CANNOT SIZE ITSELF WITHOUT THESE. Risk per share ranges from
 * roughly 0.3% to 5% of price across the candidates this setup produces. Buying
 * a fixed dollar amount of each would mean risking fifteen times more on one
 * than another for no reason anybody chose. So the number of shares is derived
 * from the one thing that should be constant — what you lose if the stop is
 * hit — and that number has to come from the trader.
 *
 *     shares = floor(riskPerTrade / risk per share)
 *
 * Kept in data/risk.json beside the alert rules, for the same reason: it is a
 * property of the desk and not of T2. The setup runs inside one screener but
 * the account it sizes against is the same account whichever tool signalled.
 *
 * Nothing here is a default worth trading. accountSize and riskPerTrade start
 * unset, and an unset value produces no share count rather than a made-up one —
 * a plausible-looking size derived from a number nobody entered is worse than
 * no size at all.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = process.env.RISK_FILE || path.join(DIR, 'risk.json');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** The settings, with everything absent reported as absent. */
function settings() {
  const s = read();
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    accountSize: num(s.accountSize),
    riskPerTrade: num(s.riskPerTrade),
    // A ceiling on the position itself, separate from the risk. A 0.3%-risk
    // candidate sized purely on risk can come out as a position several times
    // the account, which is not a position anyone can take. Percent of account.
    maxPositionPct: num(s.maxPositionPct) || 100,
    updatedAt: s.updatedAt || null,
  };
}

function save(patch) {
  const current = read();
  const next = { ...current };
  for (const key of ['accountSize', 'riskPerTrade', 'maxPositionPct']) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (raw === '' || raw === null) { delete next[key]; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${key} must be a positive number`);
    }
    next[key] = n;
  }
  if (next.riskPerTrade && next.accountSize && next.riskPerTrade > next.accountSize) {
    throw new Error('risk per trade cannot exceed the account size');
  }
  next.updatedAt = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  return settings();
}

/*
 * THE SAME TRADE IS A DIFFERENT NUMBER OF SHARES IN A DIFFERENT ACCOUNT.
 *
 * The settings above are the desk's: one account size, one risk per trade, one
 * position cap. That was the whole truth while there was one broker. It stopped
 * being true the moment a $5,000 prop-firm account and a $20,000 Alpaca account
 * were both live — sizing both against one balance means the small one is
 * over-ordered and refused, or the large one is under-used, and either way the
 * number on the alert belongs to neither.
 *
 * So a destination may carry its own accountSize, riskPerTrade and
 * maxPositionPct, and this merges them over the desk's. Field by field rather
 * than all-or-nothing: two accounts of different sizes often risk the same
 * percentage, and having to restate a figure that has not changed is how the
 * two drift apart.
 *
 * Absent everywhere means the desk's, so one account behaves exactly as it did.
 */
function forAccount(dest, base = settings()) {
  if (!dest) return base;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const accountSize = num(dest.accountSize) || base.accountSize;
  const riskPerTrade = num(dest.riskPerTrade)
    // A risk per trade sized for a $20,000 account, applied to a $5,000 one, is
    // four times the intended risk. When the account says its own size but not
    // its own risk, the desk's PERCENTAGE is what carries over, not its dollars.
    || (accountSize && base.accountSize && base.riskPerTrade
        ? Math.round(base.riskPerTrade * (accountSize / base.accountSize) * 100) / 100
        : base.riskPerTrade);
  return {
    ...base,
    accountSize,
    riskPerTrade,
    maxPositionPct: num(dest.maxPositionPct) || base.maxPositionPct,
    // Which account these numbers describe, so an alert or a preview can say so
    // rather than presenting one account's size as the desk's.
    account: dest.destinationName || dest.name || dest.destinationId || dest.id || null,
  };
}

/**
 * Shares for one trade, and why it is that many.
 *
 * Returns null when the settings are not set — the alert then carries the plan
 * without a size, which is the honest output. It also returns the reason a size
 * was capped, because "risk says 4,000 shares, the account says 300" is
 * something to know before placing the order rather than after.
 */
function sizeFor({ entry, riskPerShare }, cfg = settings()) {
  if (!cfg.riskPerTrade) return null;
  if (!(riskPerShare > 0) || !(entry > 0)) return null;

  const byRisk = Math.floor(cfg.riskPerTrade / riskPerShare);
  if (byRisk < 1) {
    return {
      shares: 0,
      reason: `one share risks $${riskPerShare.toFixed(2)}, more than the `
        + `$${cfg.riskPerTrade} you risk per trade`,
    };
  }

  let shares = byRisk;
  let capped = null;
  if (cfg.accountSize) {
    const maxValue = cfg.accountSize * (cfg.maxPositionPct / 100);
    const byValue = Math.floor(maxValue / entry);
    if (byValue < shares) {
      shares = byValue;
      capped = `capped by position size — risk allows ${byRisk}, `
        + `${cfg.maxPositionPct}% of the account allows ${byValue}`;
    }
  }

  return {
    shares,
    riskDollars: shares * riskPerShare,
    positionValue: shares * entry,
    // What it actually risks after any cap, which is not what was asked for
    // when a cap bit. Stating both is the point.
    intendedRisk: cfg.riskPerTrade,
    capped,
  };
}

module.exports = { FILE, settings, save, sizeFor, forAccount };
