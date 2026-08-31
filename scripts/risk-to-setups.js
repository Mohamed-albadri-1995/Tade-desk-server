#!/usr/bin/env node
/*
 * MOVE THE MONEY RULES OFF THE ACCOUNT AND ONTO THE SETUPS.
 *
 * WHY THERE SHOULD BE ONE LEVEL. Money management is what a strategy's winning
 * backtest specified, so it belongs to that strategy. The account is shared by
 * every setup on the desk: a risk rule written there is not any strategy's
 * setting, it is a default that quietly sizes whichever strategy has not been
 * adopted yet — by a number nobody chose for it. And two levels holding the
 * same setting is how one of them wins silently.
 *
 * What stays on the account, and only this:
 *
 *   accountSize   the balance a PERCENTAGE is a percentage OF. There is one of
 *                 it and every setup is sized against the same money, so it is
 *                 genuinely shared rather than shared by accident.
 *
 * What stays on the DESTINATION — the Alpaca or prop account an order is sent
 * to — is execution capacity, not money management:
 *
 *   buyingPower · maxOrderValue · minShares · maxTradesPerDay · ratio
 *
 *   "can this account actually execute the trade the setup decided on, and at
 *   what fraction of the standard size". That is a different question from
 *   "how much should this strategy risk", and it is why the two are apart.
 *
 * NOTHING CHANGES SIZE. Each setup that has no rule of its own is given the
 * account's current one — the exact number sizing it today — and only then is
 * the account's cleared. A setup that already has its own is left alone.
 *
 * Usage
 *   node scripts/risk-to-setups.js          # show what would move
 *   node scripts/risk-to-setups.js --yes    # move it
 */

const risk = require('../src/setups/risk');
const prefs = require('../src/setups/prefs');
const catalog = require('../src/setups/catalog');

const has = (name) => process.argv.includes(`--${name}`);

(async () => {
  const account = risk.settings();
  const rule = account.riskPerTrade
    ? { riskPerTrade: account.riskPerTrade, riskPct: null }
    : (account.riskPct ? { riskPct: account.riskPct, riskPerTrade: null } : null);
  const cap = account.maxPositionPct;

  if (!rule && (!cap || cap === 100)) {
    console.log('The account holds no money rules — nothing to move.');
    console.log('Every setup already owns its own sizing.');
    process.exit(0);
  }

  const label = rule
    ? (rule.riskPerTrade ? `$${rule.riskPerTrade} per trade` : `${rule.riskPct}% per trade`)
    : null;

  const setups = await catalog.list();
  const moving = [];
  const keeping = [];
  for (const s of setups) {
    const own = prefs.settingsFor(s.id) || {};
    // A setup with its OWN rule is the point of the exercise — never overwritten.
    const hasOwnRule = !!(own.riskPerTrade || own.riskPct);
    const hasOwnCap = !!own.maxPositionPct;
    if (hasOwnRule && hasOwnCap) { keeping.push(s.id); continue; }
    moving.push({ id: s.id, hasOwnRule, hasOwnCap });
  }

  console.log('THE ACCOUNT CURRENTLY HOLDS');
  if (rule) console.log(`  risk           ${label}`);
  if (cap && cap !== 100) console.log(`  max position   ${cap}%`);
  console.log(`  account size   ${account.accountSize || '—'}   (STAYS — a percentage`
    + ' has to be a percentage of something)');
  console.log('');

  if (!moving.length) {
    console.log('Every setup already owns its sizing. The account\'s rules are');
    console.log('doing nothing, and --yes will simply clear them.');
  } else {
    console.log('WOULD BE COPIED ONTO');
    for (const m of moving) {
      const what = [!m.hasOwnRule && rule ? label : null,
                    !m.hasOwnCap && cap && cap !== 100 ? `cap ${cap}%` : null]
        .filter(Boolean).join(', ');
      if (what) console.log(`  ${m.id.padEnd(34)} ${what}`);
    }
  }
  if (keeping.length) {
    console.log('');
    console.log('LEFT ALONE — these already own their sizing:');
    for (const id of keeping) console.log(`  ${id}`);
  }

  console.log('');
  if (!has('yes')) {
    console.log('  Nothing written. Re-run with --yes to move them.');
    console.log('  Sizes do not change: each setup is given the number that is');
    console.log('  sizing it today, and only then is the account\'s cleared.');
    process.exit(1);
  }

  for (const m of moving) {
    const patch = {};
    if (!m.hasOwnRule && rule) Object.assign(patch, rule);
    if (!m.hasOwnCap && cap) patch.maxPositionPct = cap;
    if (Object.keys(patch).length) prefs.saveSettings(m.id, patch);
  }
  /*
   * THE ACCOUNT IS CLEARED LAST. If a setup write failed halfway, the account
   * still holds the rule and every setup is still sized exactly as it was —
   * the run can simply be repeated. Cleared first, a failure would leave setups
   * with no rule at all and nothing sizing them.
   */
  risk.save({ riskPerTrade: null, riskPct: null, maxPositionPct: null });

  console.log(`  Moved onto ${moving.length} setup(s). The account now holds only its`);
  console.log('  balance, and every setup owns its own money management.');
  console.log('');
  console.log('  Check it: node scripts/parity-check.js --all');
})().catch(err => { console.error(err.message); process.exit(2); });
