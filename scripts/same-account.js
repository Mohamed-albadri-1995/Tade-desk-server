#!/usr/bin/env node
/*
 * Is SignalStack sending orders to the account this desk is reading?
 *
 * WHY THE QUESTION CAN EVEN BE ASKED. There are TWO credentials, and nothing
 * has ever compared them:
 *
 *   the WRITE side   a SignalStack hook URL. SignalStack holds its own
 *                    connection to a broker account, set up in SignalStack's
 *                    own settings. This desk POSTs to a URL and is told
 *                    "accepted". It has never been told which account.
 *
 *   the READ side    an Alpaca API key in the tool database. Everything that
 *                    says what is held, what filled, and what it cost comes
 *                    from this one.
 *
 * They are configured in different places, by hand, at different times. Nothing
 * anywhere checks that they point at the same account, and with two paper
 * accounts on one login that is an easy mistake to make and an almost invisible
 * one to have made: orders go out and are accepted, the reader says the account
 * is flat, and both are telling the truth about different accounts.
 *
 * The symptom that prompted this: two names were open in the Alpaca app and the
 * API answered with two entirely different ones.
 *
 * HOW IT IS SETTLED. In two steps, cheapest first.
 *
 *   1. IDENTITY, free and instant. The account number, equity and holdings the
 *      READ key opens. Compare against each app. If the equity and the
 *      positions match the account you believe you are trading, that half is
 *      confirmed and you have probably just been looking at the other app.
 *
 *   2. A ROUND TRIP, definitive. One share, through the real hook, then the
 *      read key is asked whether it appeared. If SignalStack accepted it and
 *      the reader never sees it, they are different accounts. Nothing else
 *      produces that result.
 *
 * Usage
 *   node scripts/same-account.js              step 1 only — sends nothing
 *   node scripts/same-account.js --send       step 2 as well: places 1 share
 *   node scripts/same-account.js --send --symbol F
 */

const ROOT = require('path').join(__dirname, '..');
const broker = require(`${ROOT}/src/broker/signalstack`);
const alpaca = require(`${ROOT}/src/alpaca/account`);
const reconcile = require(`${ROOT}/src/broker/reconcile`);

const SEND = process.argv.includes('--send');
const SYMBOL = (() => {
  const i = process.argv.indexOf('--symbol');
  return (i > -1 ? String(process.argv[i + 1] || '') : 'AAPL').toUpperCase();
})();
/*
 * How long to watch, and how often. Overridable because a test must not sit
 * through three quarters of a minute to assert a verdict — and because a slow
 * broker on a busy morning may need longer than the default.
 */
const WAIT_MS = Number(process.env.SAME_ACCOUNT_WAIT_MS) || 45000;
const POLL_MS = Number(process.env.SAME_ACCOUNT_POLL_MS) || 3000;

const say = (...a) => console.log(...a);
const rule = t => { say(''); say(`── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

const done = (async () => {
  say('');
  say('ARE THE TWO SIDES THE SAME ACCOUNT?');

  // ── step 1: who the READ key opens ──────────────────────────────────────
  rule('THE READ SIDE — the Alpaca key this desk holds');

  const acct = await alpaca.account();
  if (!acct.ok) {
    say(`  could not ask: ${acct.error}`);
    say('  Nothing can be confirmed until the read key works. Fix that first.');
    return;
  }
  const a = acct.account;
  const paper = /paper/i.test(a.base || '');
  say(`  account   ${a.number || '(no number returned)'}`);
  say(`  kind      ${paper ? 'PAPER' : 'LIVE'}   ${a.base}`);
  say(`  equity    ${a.equity}     cash ${a.cash}`);
  say(`  status    ${a.status}${a.tradingBlocked || a.accountBlocked ? '  ⚠ BLOCKED' : ''}`);

  const pos = await alpaca.positions();
  say('');
  if (!pos.ok) {
    say(`  positions: could not ask (${pos.error})`);
  } else if (!pos.positions.length) {
    say('  positions: none. This account is flat.');
  } else {
    say('  positions:');
    for (const p of pos.positions) {
      say(`    ${p.symbol.padEnd(6)} ${String(p.qty).padStart(7)} @ ${p.avgEntry}`);
    }
  }

  say('');
  say('  ── COMPARE THAT AGAINST YOUR APP ──');
  say('  Open each of your paper accounts and look at the account number and the');
  say('  equity. If neither matches the numbers above, the read key belongs to a');
  say(`  third account. If ONE matches, that is the account this desk reads —`);
  say('  and the question is whether SignalStack sends to the same one.');

  // ── the write side, as far as it can be known without sending ───────────
  rule('THE WRITE SIDE — where SignalStack sends');

  const dests = broker.destinations().filter(d => d.enabled && d.webhookUrl);
  if (!dests.length) {
    say('  no destination has a hook configured. Nothing sends anywhere.');
    return;
  }
  for (const d of dests) {
    /*
     * MASKED. A hook id IS the ability to place orders in the account behind
     * it — there is no password in front of it — and this output is written to
     * be pasted into a chat window while working out what is wrong.
     */
    say(`  ${String(d.name || d.id).padEnd(12)} ${d.dialect}  hook ${broker.mask(d.webhookUrl)}`);
  }
  say('');
  /*
   * THE HONEST ANSWER TO "WHICH ACCOUNT IS THAT". There is not one. A hook is
   * an opaque URL; SignalStack holds the broker connection behind it and this
   * side is never told whose it is. Guessing from the hook id would be
   * inventing a fact, so the only way through is to send something and look.
   */
  say('  A hook is an opaque URL. SignalStack holds the broker connection behind');
  say('  it and never tells this side which account that is — so there is no way');
  say('  to read the answer off. The only way to find out is to send one order');
  say('  and see whether the read key above can see it.');

  if (!SEND) {
    say('');
    say('  To do that:  node scripts/same-account.js --send');
    say(`  It buys 1 share of ${SYMBOL} through the live hook, then watches for it.`);
    if (!paper) {
      say('  ⚠ The read key is on a LIVE account. If the hook is on the same one,');
      say('    that share is real money. Check before you run it.');
    }
    return;
  }

  // ── step 2: the round trip ──────────────────────────────────────────────
  rule(`THE ROUND TRIP — 1 share of ${SYMBOL}`);

  const verifiable = reconcile.alpacaDestinations();
  const target = dests.find(d => verifiable.includes(d.id)) || dests[0];
  if (!verifiable.includes(target.id)) {
    say(`  ${target.name || target.id} is a ${target.dialect} account, not Alpaca.`);
    say('  The read key cannot see it whatever happens, so this proves nothing.');
    return;
  }
  say(`  sending to ${target.name || target.id}`);

  /*
   * WHAT WAS THERE BEFORE. The test is "did a NEW order appear", so the orders
   * already present have to be known — an account that traded this symbol
   * earlier would otherwise answer yes to a question nobody asked.
   */
  const before = await alpaca.orders({ status: 'all', limit: 100 });
  const seen = new Set(before.ok ? before.orders.map(o => o.id) : []);
  if (!before.ok) {
    say(`  ⚠ could not read the orders first (${before.error}) — a match below`);
    say('    may be an order that was already there.');
  }

  const out = await broker.test({ symbol: SYMBOL, useTestHook: false,
                                  destination: target.id });
  say(`  SignalStack said: ${out.sent ? 'ACCEPTED' : 'REFUSED'}`
    + `  status ${out.status || '-'}  ${out.message || ''}`);

  if (!out.sent) {
    say('');
    say('  It never left, so this says nothing about which account it would have');
    say('  reached. Fix the refusal above and run it again.');
    return;
  }

  say(`  watching the read side for up to ${WAIT_MS / 1000}s…`);
  let found = null;
  for (let waited = 0; waited < WAIT_MS && !found; waited += POLL_MS) {
    await sleep(POLL_MS);
    const now = await alpaca.orders({ status: 'all', limit: 100 });
    if (!now.ok) continue;
    found = now.orders.find(o => !seen.has(o.id) && o.symbol === SYMBOL);
  }

  rule('THE ANSWER');
  if (found) {
    say(`  SAME ACCOUNT. SignalStack's order appeared on the read side:`);
    say(`    ${found.symbol} ${found.side} ${found.qty} — ${found.status}`
      + `${found.filledAvg ? ` @ ${found.filledAvg}` : ''}`);
    say('');
    say(`  Account ${a.number} is both written to and read from. The two sides`);
    say('  agree, and a position missing from a report is not a wiring problem.');
    say('');
    say(`  You now own 1 share of ${SYMBOL} in it. Close it:`);
    say(`    node scripts/positions.js --close ${SYMBOL}`);
  } else {
    say('  DIFFERENT ACCOUNTS — or the hook is not connected to a broker.');
    say('');
    say(`  SignalStack ACCEPTED the order and account ${a.number} never saw it`);
    say(`  in ${WAIT_MS / 1000} seconds. Those two facts together have only two`);
    say('  explanations:');
    say('');
    say('    1. the hook is wired to your OTHER paper account. Everything this');
    say('       desk reports about positions, fills and P&L is then about an');
    say('       account it never trades.');
    say('    2. the hook has no working broker connection at all, and the');
    say('       "accepted" was SignalStack accepting the message, not an order.');
    say('');
    say('  To tell them apart: open SignalStack and look at which account that');
    say('  hook is connected to, then compare it with the account number above.');
    say('  Whichever it turns out to be, fix it by pointing them at ONE account —');
    say('  either re-point the hook, or put that account\'s API keys in the desk.');
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });

module.exports = done;
