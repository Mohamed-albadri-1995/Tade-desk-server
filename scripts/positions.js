#!/usr/bin/env node
/*
 * What is open at Alpaca RIGHT NOW, and what this desk intends to do about it.
 *
 * WHY IT EXISTS. Two positions were found sitting in the account by opening the
 * broker's app. Nothing on this box had said a word about them, and nothing was
 * ever going to: the 15:50 flatten reads the ledger for TODAY, and the ledger
 * is keyed by day — so a position not closed on the day it was opened is
 * invisible to every flatten that follows. The next morning asks about a new
 * date, finds nothing, closes nothing. Not missed once. Missed for good.
 *
 * `today.js` answers "what happened today". This answers the different and more
 * urgent question: "what am I holding, and is anything going to close it".
 *
 * ALPACA ONLY, said every time. TTP5k is behind TraderEvolution with no
 * position feed. A position carried over there is not visible here, and a
 * report that implied otherwise would be worse than none.
 *
 * Usage
 *   node scripts/positions.js
 *   node scripts/positions.js --close-carried    close what this desk left open
 *   node scripts/positions.js --close LHSW       close ONE named position
 */

const ROOT = require('path').join(__dirname, '..');
const broker = require(`${ROOT}/src/broker/signalstack`);
const reconcile = require(`${ROOT}/src/broker/reconcile`);
const alpaca = require(`${ROOT}/src/alpaca/account`);
const { toETDate } = require(`${ROOT}/src/utils/time`);

const CLOSE = process.argv.includes('--close-carried');
/*
 * ONE NAME AT A TIME, spelled out.
 *
 * There is no "close everything". A position this desk never opened may be a
 * trade taken by hand, and a flag that swept the account would eventually take
 * one out on a morning nobody was reading carefully. Naming the symbol is the
 * whole safety mechanism.
 */
const CLOSE_ONE = (() => {
  const i = process.argv.indexOf('--close');
  return i > -1 ? String(process.argv[i + 1] || '').toUpperCase() : null;
})();
const DAY = toETDate(Date.now());

const say = (...a) => console.log(...a);
const rule = t => { say(''); say(`── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); };

const done = (async () => {
  say('');
  say(`OPEN POSITIONS — ${DAY}, New York`);

  /*
   * WHICH ACCOUNT THESE KEYS OPEN, printed before anything else.
   *
   * Two names were reported open in the Alpaca app and the API answered with
   * two entirely different ones. That has two possible causes and they need
   * opposite responses: the keys on this box point at a different account from
   * the screen being read, or the screen was misread. The account number
   * settles it in one line, and nothing below means anything without it.
   */
  const acct = await alpaca.account();
  if (acct.ok) {
    say(`account ${acct.account.number || '(no number returned)'}`
      + `  ${/paper/i.test(acct.account.base || '') ? 'PAPER' : 'LIVE'}`
      + `  equity ${acct.account.equity}`);
    say(`  ${acct.account.base}`);
    say('  If that is not the account you are looking at, nothing below is either.');
    if (acct.account.tradingBlocked || acct.account.accountBlocked) {
      say('  ⚠ THIS ACCOUNT IS BLOCKED — every order will be refused.');
    }
  }

  const r = await reconcile.carriedOver(DAY);
  if (!r.ok) {
    say('');
    say(`Alpaca did not answer: ${r.error}`);
    say('Nothing below can be trusted. Check the account by hand.');
    return;
  }

  const all = [...r.carried, ...r.foreign, ...r.running];
  if (!all.length) {
    say('');
    say('Alpaca is holding nothing. The account is flat.');
    say('(Trade The Pool is not covered — it has no position feed.)');
    return;
  }

  // ── opened today, running normally ────────────────────────────────────────
  if (r.running.length) {
    rule('OPEN TODAY — normal');
    for (const p of r.running) {
      say(`  ${p.symbol.padEnd(6)} ${String(p.qty).padStart(6)}  ${p.setupId || ''}`);
    }
    say('');
    say(`  These close at ${broker.settings().flattenAt} if they are still on.`);
  }

  // ── the ones that should not be there ─────────────────────────────────────
  if (r.carried.length) {
    rule('LEFT OVER FROM AN EARLIER SESSION');
    say('  This desk opened these and never closed them. Each one means a session');
    say('  ended without the flatten running — find out which, or it repeats.');
    say('');
    for (const p of r.carried) {
      say(`  ${p.symbol.padEnd(6)} ${String(p.qty).padStart(6)}  opened ${p.openedOn}`
        + `  ${p.setupId || ''}  → ${(p.destinations || []).join(', ') || 'no Alpaca account on the row'}`);
    }
    say('');
    say(`  They WILL be closed at ${broker.settings().flattenAt} today.`);
    if (CLOSE) {
      say('  Closing them now, as asked:');
      for (const p of r.carried) {
        const dests = (p.destinations || []).length ? p.destinations : [null];
        for (const d of dests) {
          const cfg = (d && broker.destinationCfg(d)) || broker.settings();
          const out = await broker.closePosition(p.symbol, DAY, cfg);
          say(`    ${p.symbol} → ${out.sent ? 'sent' : `NOT SENT: ${out.error || out.skipped}`}`);
        }
      }
    } else {
      say('  To close them now instead: node scripts/positions.js --close-carried');
    }
  } else if (CLOSE) {
    /*
     * ASKED TO CLOSE, AND THERE WAS NOTHING TO CLOSE. Silence here reads as
     * "done" — the flag was typed because something was expected to happen, and
     * printing the same report twice does not say that nothing did.
     */
    say('');
    say('  --close-carried: nothing to do. Nothing below was opened by this desk,');
    say('  so there is no leftover of its own to close. Use --close <SYMBOL> to');
    say('  close one of them deliberately.');
  }

  // ── the ones nothing here will touch ──────────────────────────────────────
  if (r.foreign.length) {
    rule('HELD, AND NOT THIS DESK\'S TO CLOSE');
    say('  Nothing in this ledger opened these. They will NOT be closed');
    say('  automatically — a position this desk did not open may be one you took');
    say('  by hand, and flattening that without being asked would be worse than');
    say('  leaving it. If you want them flat, do it yourself.');
    say('');
    for (const p of r.foreign) {
      say(`  ${p.symbol.padEnd(6)} ${String(p.qty).padStart(6)}  ${p.why || ''}`);
    }
    say('');
    say('  To close one deliberately: node scripts/positions.js --close '
      + r.foreign[0].symbol);
  }

  // ── one named position, closed on purpose ────────────────────────────────
  if (CLOSE_ONE) {
    rule(`CLOSING ${CLOSE_ONE}`);
    const p = all.find(x => x.symbol === CLOSE_ONE);
    if (!p) {
      say(`  Alpaca is not holding ${CLOSE_ONE}. Nothing sent.`);
      say(`  It is holding: ${all.map(x => x.symbol).join(', ')}`);
    } else {
      /*
       * TO THE ACCOUNT THAT HOLDS IT. For a foreign position there is no ledger
       * row saying which that was, so it goes to the Alpaca destinations —
       * `close` is a no-op at an account that is already flat, and this whole
       * report is built on an Alpaca position query.
       */
      const dests = (p.destinations || []).length
        ? p.destinations : reconcile.alpacaDestinations();
      if (!dests.length) {
        say('  No Alpaca account is configured to send through. Close it in the app.');
      }
      for (const d of dests) {
        const cfg = broker.destinationCfg(d);
        const out = await broker.closePosition(CLOSE_ONE, DAY, cfg);
        say(`  ${(cfg && cfg.destinationName) || d} → `
          + (out.sent ? 'close sent' : `NOT SENT: ${out.error || out.skipped}`));
      }
      say('');
      say('  `close` flattens the whole symbol and takes no quantity. Check the app:');
      say('  SignalStack accepting it is not the broker having done it.');
    }
  }

  say('');
  say('Alpaca only. Trade The Pool has no position feed and is not covered here.');
})().catch(err => { console.error(err.message); process.exitCode = 1; });

/*
 * Exported so it can be awaited.
 *
 * This script sends orders. Testing it by shelling out would mean testing it
 * against a real account or not at all, so it is required in-process with the
 * Alpaca transport stubbed — which needs something to wait on.
 */
module.exports = done;
