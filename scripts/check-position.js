#!/usr/bin/env node
/*
 * One open position, from the decision to the money.
 *
 * WHY. "Is the delay hurting the strategy, or is this normal?" cannot be
 * answered from a chart, because the gap between what a strategy decided and
 * what the account did has THREE parts and they have different cures:
 *
 *   the DECISION      the bar's close the strategy chose on. If the feed was
 *                     stale, this number was already wrong before anything was
 *                     sent — and no execution improvement fixes it.
 *
 *   the SLIP          the market order goes out 60-90 seconds later. qp's own
 *                     docstring calls fill:'close' optimistic by about a
 *                     spread. On a quiet bar this is pennies; on a bar falling
 *                     a dollar a minute it is not.
 *
 *   the CONSEQUENCE   and this is the part nobody was looking at. The stop and
 *                     the targets are absolute prices derived from the DECISION
 *                     price. The fill does not move them. So a trade filled
 *                     away from its decision price is a trade whose real risk
 *                     and real R-multiples are not the ones that were tested,
 *                     and nothing said so.
 *
 * The third is why this script exists. The first two are costs; the third is a
 * different trade from the one in the backtest.
 *
 * IT ALSO ASKS THE QUESTION A CHART CANNOT: is every share protected? A
 * scale-out is several brackets, and a leg that did not go in leaves shares
 * with no stop behind them — which looks exactly like a smaller position.
 *
 * Usage
 *   node scripts/check-position.js WULF
 */

const ROOT = require('path').join(__dirname, '..');
const broker = require(`${ROOT}/src/broker/signalstack`);
const alpaca = require(`${ROOT}/src/alpaca/account`);
const { toETDate } = require(`${ROOT}/src/utils/time`);

const SYMBOL = String(process.argv[2] || '').toUpperCase();
const DAY = process.argv.slice(3).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
  || toETDate(Date.now());

if (!SYMBOL) {
  console.error('usage: node scripts/check-position.js <SYMBOL> [YYYY-MM-DD]');
  process.exit(1);
}

const say = (...a) => console.log(...a);
const rule = t => { say(''); say(`── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); };
const n2 = v => (v == null ? '—' : Number(v).toFixed(2));
const n4 = v => (v == null ? '—' : Number(v).toFixed(4));
const signed = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(4)}`);

const done = (async () => {
  say('');
  say(`${SYMBOL} — decision against execution, ${DAY}`);

  // ── what this side decided and sent ─────────────────────────────────────
  const rows = broker.orders(DAY).filter(o =>
    String(o.symbol || '').toUpperCase() === SYMBOL
    && o.kind !== 'callback' && o.kind !== 'intent');
  const entries = rows.filter(o => o.sent && o.kind !== 'flatten');

  rule('WHAT THE STRATEGY DECIDED');
  if (!entries.length) {
    say(`  nothing in the ledger for ${SYMBOL} on ${DAY}.`);
    say('  Either it was opened by hand, or it was opened on another date.');
  }
  const first = entries[0];
  if (first) {
    say(`  setup       ${first.setupId || '—'}   ${first.signal}`);
    say(`  bar         ${first.decisionBar || '(not recorded — the send time was used)'}`);
    say(`  price used  ${n2(first.price)}      <- the bar's CLOSE, not a traded price`);
    say(`  stop        ${n2(first.stop)}`);
    say(`  target      ${n2(first.target)}`);
    const shares = entries.reduce((s, o) => s + (Number(o.quantity) || 0), 0);
    say(`  sent        ${shares} share(s) in ${entries.length} call(s)`);
    for (const o of entries) {
      for (const l of o.legs || []) {
        say(`                leg ${l.quantity} ${l.sent ? 'sent' : 'NOT SENT'}`
          + `${l.target ? ` target ${n2(l.target)}` : ' runner (no target)'}`);
      }
    }
  }

  // ── what the account actually did ───────────────────────────────────────
  rule('WHAT THE ACCOUNT ACTUALLY DID');
  const [pos, ord] = await Promise.all([
    alpaca.positions(),
    alpaca.orders({ status: 'all', limit: 200 }),
  ]);
  if (!pos.ok) { say(`  could not ask Alpaca: ${pos.error}`); return; }

  const held = pos.positions.find(p => p.symbol === SYMBOL);
  if (!held) {
    say(`  Alpaca is FLAT in ${SYMBOL}. Nothing is open in the account these`);
    say('  keys read. If your app shows a position, it is a different account —');
    say('  run: node scripts/same-account.js');
    return;
  }
  const short = held.qty < 0;
  say(`  position    ${held.qty} @ ${n4(held.avgEntry)}   (${short ? 'SHORT' : 'LONG'})`);
  say(`  now         ${n2(held.current)}      open P&L ${signed(held.unrealised)}`);

  // ── the three parts of the gap ──────────────────────────────────────────
  if (first && first.price > 0 && held.avgEntry > 0) {
    rule('THE GAP, AND WHICH PART IS WHICH');
    const want = Number(first.price);
    const got = Number(held.avgEntry);
    const raw = got - want;
    // Signed against the position: + is always worse, whichever way it faces.
    const slip = short ? -raw : raw;
    say(`  decided at  ${n4(want)}`);
    say(`  filled at   ${n4(got)}`);
    say(`  slip        ${signed(slip)} a share   (+ = worse than the decision assumed)`);
    say(`              ${signed(slip * Math.abs(held.qty))} across ${Math.abs(held.qty)} shares`);

    /*
     * THE PART THAT MATTERS MORE THAN THE SLIP ITSELF.
     *
     * The stop is an absolute price computed from the DECISION price and the
     * fill does not move it. So a fill away from the decision changes the real
     * risk per share — and every R-multiple in the plan is measured from a
     * number the trade never traded at.
     */
    const stop = Number(first.stop);
    if (stop > 0) {
      const plannedR = Math.abs(stop - want);
      const realR = Math.abs(stop - got);
      say('');
      say(`  risk/share  planned ${n4(plannedR)}   ACTUAL ${n4(realR)}`
        + `   (${realR > plannedR ? '+' : ''}${(((realR / plannedR) - 1) * 100).toFixed(0)}%)`);
      say(`  risk total  planned ${n2(plannedR * Math.abs(held.qty))}`
        + `   ACTUAL ${n2(realR * Math.abs(held.qty))}`);
      say(`  slip as R   ${(Math.abs(slip) / plannedR * 100).toFixed(0)}% of one planned R`);

      const target = Number(first.target);
      if (target > 0) {
        const plannedRR = Math.abs(target - want) / plannedR;
        const realRR = Math.abs(target - got) / realR;
        say('');
        say(`  reward:risk planned ${plannedRR.toFixed(2)}   ACTUAL ${realRR.toFixed(2)}`);
        if (realRR < plannedRR * 0.9) {
          say('  ⚠ The target is a fixed price from the decision, so a worse fill');
          say('    shrinks the reward AND widens the risk at the same time. This is');
          say('    not the trade the backtest measured.');
        }
      }
    }
  }

  // ── is every share protected? ───────────────────────────────────────────
  rule('IS THE WHOLE POSITION PROTECTED?');
  if (!ord.ok) {
    say(`  could not read the orders: ${ord.error}`);
  } else {
    const live = [];
    const walk = o => {
      if (['new', 'accepted', 'held', 'pending_new', 'partially_filled'].includes(o.status)
          && o.symbol === SYMBOL) live.push(o);
      (o.legs || []).forEach(walk);
    };
    ord.orders.forEach(walk);

    const stops = live.filter(o => /stop/.test(o.type || ''));
    const limits = live.filter(o => /limit/.test(o.type || ''));
    const stopQty = stops.reduce((s, o) => s + (o.qty || 0), 0);
    const size = Math.abs(held.qty);

    for (const o of live) {
      say(`  ${String(o.type).padEnd(12)} ${String(o.qty).padStart(5)} @ `
        + `${n2(o.stopPrice ?? o.limitPrice)}   ${o.status}`);
    }
    if (!live.length) say('  NO resting orders at all.');

    say('');
    say(`  position ${size} · stops cover ${stopQty} · targets cover `
      + `${limits.reduce((s, o) => s + (o.qty || 0), 0)}`);
    if (stopQty < size) {
      /*
       * THE ONE A CHART WILL NOT TELL YOU. A scale-out is several brackets, and
       * a leg that never went in leaves shares behind it with no stop —
       * indistinguishable, on a broker screen, from a smaller position.
       */
      say(`  ⚠⚠ ${size - stopQty} SHARE(S) HAVE NO STOP BEHIND THEM.`);
      say('     That is an unprotected position, not a smaller one. Put a stop on');
      say('     it by hand, or close it.');
    } else {
      say('  ✓ every share has a stop behind it.');
    }
  }

  // ── who is minding it ───────────────────────────────────────────────────
  rule('WHO IS MINDING IT');
  const cfg = broker.settings();
  say(`  flatten at  ${cfg.flattenAt} ET  (${cfg.flatten ? 'on' : 'OFF'})`);
  say('  The stop at the broker is a FIXED level. If this setup\'s stop follows');
  say('  an indicator, or it leaves on a rule, only the manager loop does that —');
  say('  and only while the alerts process is running the code that has it.');
  say('  Check:  pm2 logs alerts --lines 50 | grep Manager');
})().catch(err => { console.error(err.message); process.exitCode = 1; });

module.exports = done;
