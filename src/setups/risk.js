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
 * THE STANDARD ACCOUNT IS A REFERENCE. NOTHING TRADES AGAINST IT.
 *
 * `settings()` above describes one hypothetical account: a size, a risk per
 * trade, a position cap. No order is ever placed against it. It exists so that
 * every real account can be described in relation to it — "twice the standard",
 * "half of it" — which is how the relationship is actually held in mind, and
 * which means moving the reference moves every account with it instead of
 * leaving five numbers to be retyped one at a time.
 *
 * An account resolves in this order, most specific first:
 *
 *   its own accountSize / riskPerTrade / maxPositionPct   an account that is
 *                                                         not a clean multiple
 *   scale x the standard                                  the normal case
 *   the standard itself                                   scale absent
 *
 * Scale multiplies the size AND the risk together, so the PERCENTAGE risked is
 * identical in a $5,000 account and a $20,000 one. That is the property that
 * makes two accounts one strategy rather than two — and getting it wrong by
 * carrying the dollar figure across is invisible, because it is the same
 * number nobody would look at twice.
 *
 * The position cap is NOT scaled: it is already a percentage, so 25% of a
 * double-sized account is double the money by construction.
 */
function forAccount(dest, base = settings()) {
  if (!dest) return base;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const scale = num(dest.scale) || 1;
  const accountSize = num(dest.accountSize)
    || (base.accountSize ? Math.round(base.accountSize * scale * 100) / 100 : null);
  const riskPerTrade = num(dest.riskPerTrade)
    || (base.riskPerTrade ? Math.round(base.riskPerTrade * scale * 100) / 100 : null);
  return {
    ...base,
    scale,
    accountSize,
    riskPerTrade,
    maxPositionPct: num(dest.maxPositionPct) || base.maxPositionPct,
    // Which account these numbers describe, so an alert or a preview can say so
    // rather than presenting one account's size as everyone's.
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
