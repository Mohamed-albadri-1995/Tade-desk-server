#!/usr/bin/env node
/*
 * A dress rehearsal: put a real strategy's REAL order set into a paper
 * account, and read back what the broker did with it.
 *
 * WHAT THE EXISTING TEST BUTTON DOES NOT COVER. broker.test() sends one naked
 * share with no stop and no target. That proves the hook is reachable and the
 * account is connected, which is worth knowing at 09:00 — and it proves
 * nothing at all about the thing that has actually gone wrong every time:
 *
 *   · a three-leg strategy that placed one order
 *   · a runner sent WITH a target, which is a strategy that was never tested
 *   · "take_profit.limit_price must be >= base_price + 0.01"
 *   · "asset cannot be sold short"
 *   · a leg rounded down to nothing because the size was too small
 *
 * Every one of those is a property of the bracket and the split, and a naked
 * one-share buy has neither. So this goes through placeOrder — the same
 * function the 09:35 signal goes through, with the same gates in the same
 * order — and puts the whole shape in.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It carries NO setupId. Two reasons, and
 * both matter: a test must not spend a real setup's daily allowance, and it
 * must not trip the once-a-day repeat guard and lock a real signal out of a
 * name for the rest of the session. The cost is that the ledger line says
 * "manual test" rather than a strategy name, which is what you want anyway.
 *
 * SIZE IS THE INTERESTING PART. A ten-percent leg of nine shares is 0.9, which
 * floors to zero and is dropped — so a strategy tested at "a few shares" sends
 * fewer orders than it will in production, passes, and is wrong. The default
 * size here is the SMALLEST count at which every leg survives, computed from
 * the fractions rather than guessed.
 *
 * Usage
 *   node scripts/order-test.js --list
 *   node scripts/order-test.js "Test"                       dry run, real prices
 *   node scripts/order-test.js "Test" --send                actually place it
 *   node scripts/order-test.js "Test" --symbol F --send
 *   node scripts/order-test.js "OR + VWAP 09:35 (Short)" --send
 *
 *   --symbol SYM   what to rehearse with        (default AAPL)
 *   --entry N      entry price                  (default: last bar from Alpaca)
 *   --stop  N      stop price                   (default: 1% the losing side)
 *   --shares N     exact count                  (default: smallest that fills every leg)
 *   --account ID   which destination            (default: the only live one)
 *   --test-hook    use the account's TEST hook instead of its real one
 *   --send         ACTUALLY SEND. Without it, nothing leaves the box.
 *   --qp URL       default http://127.0.0.1:8765
 */

const path = require('path');

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : d;
};
const has = n => process.argv.includes('--' + n);

const QP = (arg('qp') || process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const NAME = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const SEND = has('send');

/* Same redactor as scripts/today.js — this output gets pasted too. */
const scrub = s => String(s)
  .replace(/(signalstack\.com\/hook\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
  .replace(/\b(PK|SK)[A-Z0-9]{16,}\b/g, '[REDACTED-KEY]')
  .replace(/\b[a-f0-9]{32,}\b/g, '[REDACTED-KEY]');
const say = (...a) => console.log(scrub(a.join(' ')));

async function qp(pathname, body) {
  const res = await fetch(QP + pathname, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
  return res.json();
}

/*
 * The smallest position at which no leg rounds away.
 *
 * splitLegs floors each leg to whole shares, so a fraction f needs at least
 * ceil(1/f) shares to survive. Take the worst fraction and the whole shape
 * survives. Rehearsing below this number tests a DIFFERENT strategy — fewer
 * orders, different total — and it passes, which is the trap.
 */
function smallestWorkingSize(plan) {
  const fracs = (plan.legs || []).map(l => Number(l.fraction) || 0)
    .concat(Number(plan.runner) > 0 ? [Number(plan.runner)] : [])
    .filter(f => f > 0);
  if (!fracs.length) return 1;
  return Math.ceil(1 / Math.min(...fracs));
}

/** Today's last traded price, from the feed the screeners already use. */
async function lastPrice(symbol) {
  try {
    const alpaca = require('../src/alpaca/client');
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const bars = await alpaca.fetchIntradayBars([symbol], day);
    const rows = (bars && (bars[symbol] || bars[symbol.toUpperCase()])) || [];
    const last = rows[rows.length - 1];
    return last ? Number(last.c ?? last.close) : null;
  } catch { return null; }
}

(async () => {
  const broker = require('../src/broker/signalstack');

  if (has('list') || !NAME) {
    const d = await qp('/api/strategies');
    say('Strategies on ' + QP + ':\n');
    for (const s of (d.strategies || []).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = s.exit_protocol || {};
      const legs = (p.legs || []).length + (p.runner && p.runner.fraction > 0 ? 1 : 0);
      say(`  ${s.name.padEnd(34)} ${String(s.side || '?').padEnd(6)}`
        + `${String(Math.max(1, legs)).padStart(2)} order(s)   ${p.shape || ''}`);
    }
    say('\nName one to rehearse it. Add --send to place it for real.');
    return;
  }

  // ── which account ────────────────────────────────────────────────────────
  /*
   * Never a silent first-of-many. A rehearsal that quietly only ever exercised
   * one account would leave the other untested while reading as a pass — the
   * same reasoning as broker.test(), for the same reason.
   */
  const live = broker.destinations().filter(d => d.enabled && d.webhookUrl);
  const id = arg('account') || (live.length === 1 ? live[0].id : null);
  if (!id) {
    say(live.length ? `say which account with --account: ${live.map(d => `${d.id} (${d.name})`).join(', ')}`
                    : 'no broker account is configured');
    process.exit(1);
  }
  let cfg = broker.destinationCfg(id);
  if (!cfg) { say(`no account called ${id}`); process.exit(1); }

  if (has('test-hook')) {
    if (!cfg.testWebhookUrl) { say(`${cfg.destinationName} has no test hook configured`); process.exit(1); }
    cfg = { ...cfg, webhookUrl: cfg.testWebhookUrl };
  }

  // ── the prices ───────────────────────────────────────────────────────────
  const symbol = String(arg('symbol', 'AAPL')).toUpperCase();
  const strategies = (await qp('/api/strategies')).strategies || [];
  const found = strategies.find(s => s.name === NAME)
    || strategies.find(s => s.name.toLowerCase() === NAME.toLowerCase());
  if (!found) {
    say(`no strategy called "${NAME}". They are:`);
    for (const s of strategies) say('  ' + s.name);
    process.exit(1);
  }
  const side = (arg('side') || found.side || 'long').toLowerCase();

  let entry = Number(arg('entry')) || await lastPrice(symbol);
  if (!(entry > 0)) {
    say(`could not get a price for ${symbol} — pass --entry and --stop`);
    process.exit(1);
  }
  entry = Number(entry.toFixed(2));
  /*
   * A stop 1% on the LOSING side — below entry for a long, above for a short.
   * Getting this backwards produces a negative risk-per-share, which sizes the
   * position to nonsense and is rejected downstream with a message about
   * quantity rather than about the stop.
   */
  const stop = Number(arg('stop')) || Number(
    (side === 'short' ? entry * 1.01 : entry * 0.99).toFixed(2));

  const r = await qp('/api/strategy/exit_plan', { name: found.name, side, entry, stop });
  if (!r.ok) { say(r.error || 'qp could not price the exit plan'); process.exit(1); }
  const plan = r.plan;

  const floor = smallestWorkingSize(plan);
  const shares = arg('shares') ? Math.floor(Number(arg('shares'))) : floor;

  // ── say what is about to happen, before it happens ───────────────────────
  say('');
  say(`REHEARSAL   ${found.name}  ·  ${side}  ·  ${symbol}`);
  say(`account     ${cfg.destinationName} [${id}]  ${cfg.dialect}`
    + `  hook ${has('test-hook') ? 'TEST' : 'live'}`);
  say(`prices      entry ${entry}   stop ${stop}   risk/share ${Math.abs(entry - stop).toFixed(4)}`
    + `${arg('entry') ? '' : '   (entry from the last bar)'}`);
  say(`shape       ${plan.legs.length} leg(s)`
    + (plan.runner ? ` + ${Math.round(plan.runner * 100)}% runner` : ' + no runner')
    + `   stop ${plan.stop_kind}`);
  say(`size        ${shares} share(s)`
    + (arg('shares') ? '' : `   (the smallest at which no leg rounds to zero)`));
  if (arg('shares') && shares < floor) {
    say(`            ⚠ BELOW ${floor} — at this size a leg floors to zero and is`);
    say(`              dropped, so this rehearses a DIFFERENT shape from production.`);
  }

  const p = broker.planOrder({
    symbol, signal: side === 'short' ? 'SHORT' : 'LONG',
    quantity: shares, price: entry, stop,
    target: (plan.legs[0] || {}).price || null,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    plan, cfg,
  });

  if (p.blocked) {
    say('');
    say(`NOTHING WOULD BE SENT — ${p.blocked}: ${p.reason}`);
    return;
  }

  const bodies = p.orders && p.orders.length ? p.orders : [p.body];
  say('');
  say(`=> ${bodies.length} JSON${bodies.length === 1 ? '' : 's'} would go on the wire:`);
  say('');
  bodies.forEach((b, i) => {
    say(`  [${i + 1}] ${b.take_profit_price == null
      ? 'RUNNER — stop only, rides to the flatten' : `target ${b.take_profit_price}`}`);
    say(`      ${JSON.stringify(b)}`);
  });
  const total = bodies.reduce((n, b) => n + b.quantity, 0);
  say('');
  say(`  ${total} of ${shares} share(s) ordered`
    + (total === shares ? '  ✓' : '  ✗ MISMATCH — some shares are unaccounted for'));
  if (p.unplaceable && p.unplaceable.length) {
    say(`  ${p.unplaceable.length} leg(s) had a target no broker can rest — their shares joined the runner`);
  }

  if (!SEND) {
    say('');
    say('DRY RUN — nothing was sent. Add --send to place it.');
    return;
  }

  // ── send it ──────────────────────────────────────────────────────────────
  say('');
  say('── SENDING ───────────────────────────────────────────────────────');
  const out = await broker.placeOrder({
    symbol, signal: side === 'short' ? 'SHORT' : 'LONG',
    quantity: shares, price: entry, stop,
    target: (plan.legs[0] || {}).price || null,
    date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    source: `rehearsal: ${found.name}`,
    // No setupId, deliberately — see the note at the top.
    setupId: null, maxPerDay: null,
    plan, cfg,
  });

  say('');
  say(`result      ${out.sent ? 'SENT' : 'NOT SENT'}`
    + `   ${out.status || ''} ${out.error || out.skipped || ''}`);
  if (out.legs) {
    for (const [i, l] of out.legs.entries()) {
      say(`  leg ${i + 1}   ${String(l.quantity).padStart(5)} `
        + `${l.target ? `@ ${l.target}` : 'runner (no target)'}   `
        + `${l.sent ? (l.status || 'sent') : `FAILED — ${l.message || 'refused'}`}`);
    }
  }
  if (out.partial) say('  ⚠ PARTIAL — some legs went in and some did not. The position is not the tested shape.');
  if (out.reduced) say(`  reduced: ${out.reduced}`);

  say('');
  say('NOW CHECK THE BROKER. What should be there:');
  say(`  · ${bodies.length} order(s) on ${symbol}`);
  say(`  · every one with a stop at ${stop}`);
  bodies.forEach((b, i) => say(`  · #${i + 1}: ${b.quantity} share(s), `
    + (b.take_profit_price == null ? 'NO take-profit — this is the runner'
                                   : `take-profit ${b.take_profit_price}`)));
  say('');
  say('Then close them by hand, or let the end-of-session flatten do it.');
  say('  node scripts/today.js       to see this in the ledger');
})().catch(e => { console.error(scrub(e.stack || e.message)); process.exit(1); });
