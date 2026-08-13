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
 * THE STANDARD ACCOUNT IS THE ONLY THING SIZING IS DONE AGAINST.
 *
 * `settings()` above describes one hypothetical account — a size, a risk per
 * trade, a position cap. No order is ever placed against it. It exists so that
 * a signal can be worked out ONCE, completely, before anything knows which
 * broker it is going to.
 *
 * The whole pipeline, in order:
 *
 *   1  a setup fires and produces a signal
 *   2  entry, STOP, TARGET and SHARES are computed against the standard
 *   3  the algo master switch decides whether anything is sent at all
 *   4  each account scales the SHARE COUNT by its own ratio, and picks the
 *      JSON shape its broker expects
 *   5  the account's own mode decides send-now or hold-ready
 *
 * Step 2 is finished before step 4 begins, and that is the point. The stop and
 * the target are properties of the TRADE — where the setup says it is wrong,
 * and where it says it is done. They do not change because the money came out
 * of a different account. Only the number of shares does.
 *
 * An account says what fraction of the standard it is — a $5,000 account
 * against a $100,000 standard is 0.05 — and that one number is the whole of
 * its money management. Scaling the share count directly, rather than
 * re-deriving it from a second account size and a second risk figure, means
 * one calculation and one rounding for every account: the small account holds
 * the same trade as the large one, exactly 5% of it.
 */

/** What fraction of the standard account this one is. 1 when it says nothing. */
function ratioOf(dest) {
  if (!dest) return 1;
  const n = Number(dest.ratio !== undefined && dest.ratio !== null ? dest.ratio : dest.scale);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The standard trade, resized for one account.
 *
 * FLOORED, never rounded. 0.05 of 137 shares is 6.85, and a broker takes 6 —
 * asking for 7 is asking for 2% more risk than the account agreed to, on every
 * trade, in the direction that costs money.
 *
 * A ratio small enough to floor to zero is a real answer: the account is too
 * small for this trade at this stop. It comes back as 0 shares with a reason,
 * so the alert can say so rather than sending nothing and staying quiet.
 */
function scaleTo(standard, dest) {
  if (!standard) return null;
  const ratio = ratioOf(dest);
  const name = (dest && (dest.destinationName || dest.name || dest.destinationId || dest.id)) || null;
  if (!(standard.shares > 0)) return { ...standard, account: name, ratio };
  const shares = Math.floor(standard.shares * ratio);
  if (shares < 1) {
    return {
      shares: 0, ratio, account: name,
      standardShares: standard.shares,
      reason: `${standard.shares} shares at the standard × ${ratio} is `
        + `${(standard.shares * ratio).toFixed(2)} — under one whole share`,
    };
  }
  return {
    shares,
    ratio,
    account: name,
    // What the standard said, kept beside what this account gets. "12 of 240"
    // is the only form in which a share count can be checked at a glance.
    standardShares: standard.shares,
    riskDollars: standard.riskDollars != null
      ? Math.round(standard.riskDollars * (shares / standard.shares) * 100) / 100 : null,
    positionValue: standard.positionValue != null
      ? Math.round(standard.positionValue * (shares / standard.shares) * 100) / 100 : null,
    // The rounding, stated whenever it cost something. Silence would make a
    // 6.85 → 6 look like the arithmetic simply came out even.
    floored: Math.abs(standard.shares * ratio - shares) > 1e-9
      ? `${(standard.shares * ratio).toFixed(2)} floored to ${shares}` : null,
    capped: standard.capped || null,
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

module.exports = { FILE, settings, save, sizeFor, scaleTo, ratioOf };
