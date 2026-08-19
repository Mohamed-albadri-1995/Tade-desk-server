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
 *   node scripts/positions.js --close-carried    actually send the closes
 */

const ROOT = require('path').join(__dirname, '..');
const broker = require(`${ROOT}/src/broker/signalstack`);
const reconcile = require(`${ROOT}/src/broker/reconcile`);
const { toETDate } = require(`${ROOT}/src/utils/time`);

const CLOSE = process.argv.includes('--close-carried');
const DAY = toETDate(Date.now());

const say = (...a) => console.log(...a);
const rule = t => { say(''); say(`── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); };

(async () => {
  say('');
  say(`OPEN POSITIONS — ${DAY}, New York`);

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
  }

  say('');
  say('Alpaca only. Trade The Pool has no position feed and is not covered here.');
})().catch(err => { console.error(err.message); process.exit(1); });
