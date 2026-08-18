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
  if (!live.length) { say('no broker account is configured'); process.exit(1); }
  /*
   * `--all` rehearses every account, which is what production actually does:
   * a signal routes to every account that lists the setup, sized separately in
   * each. Rehearsing one and inferring the other is how a second account stays
   * untested while reading as a pass — and the sizes are NOT proportional,
   * because each is floored to whole shares against its own ratio.
   */
  const ids = has('all') ? live.map(d => d.id)
    : (arg('account') ? [arg('account')] : (live.length === 1 ? [live[0].id] : null));
  if (!ids) {
    say('There is more than one account, so say which — or --all for every one,');
    say('which is what a real signal does. Copy one of these:');
    say('');
    for (const d of live) {
      say(`  node scripts/order-test.js ${JSON.stringify(NAME)} --account ${d.id}`
        + `${SEND ? ' --send' : ''}      # ${d.name}`);
    }
    say(`  node scripts/order-test.js ${JSON.stringify(NAME)} --all`
      + `${SEND ? ' --send' : ''}`.padEnd(SEND ? 7 : 1) + '           # both, as a signal would');
    process.exit(1);
  }
  for (const one of ids) {
    if (!broker.destinationCfg(one)) { say(`no account called ${one}`); process.exit(1); }
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

  /*
   * The rehearsal size has to clear BOTH floors.
   *
   * The legs need enough shares that none rounds away; the desk needs enough
   * that it will send at all. `OR + VWAP 09:35` splits 50/50, so two shares
   * fills every leg — and two is under the three-share minimum, so a rehearsal
   * sized only from the legs would be refused with "under this account's
   * minimum" and read as a broken strategy rather than a badly sized test.
   */
  const legFloor = smallestWorkingSize(plan);
  const deskFloor = broker.settings().minShares || 1;
  const floor = Math.max(legFloor, deskFloor);
  const shares = arg('shares') ? Math.floor(Number(arg('shares'))) : floor;

  say('');
  say(`REHEARSAL   ${found.name}  ·  ${side}  ·  ${symbol}`);
  say(`prices      entry ${entry}   stop ${stop}   risk/share ${Math.abs(entry - stop).toFixed(4)}`
    + `${arg('entry') ? '' : '   (entry from the last bar)'}`);
  say(`shape       ${plan.legs.length} leg(s)`
    + (plan.runner ? ` + ${Math.round(plan.runner * 100)}% runner` : ' + no runner')
    + `   stop ${plan.stop_kind}`);
  say(`needs       ${floor} share(s)`
    + `   (${legFloor} so no leg rounds away`
    + (deskFloor > legFloor ? `, ${deskFloor} is the desk's minimum position` : '') + ')');

  for (const one of ids) await rehearse(one);

  /*
   * ONE ACCOUNT AT A TIME, in full.
   *
   * Not a shared preview with per-account footnotes: each account has its own
   * ratio, its own buying power and its own dialect, so the share count, the
   * number of bodies and the JSON shape can all differ. TTP5k at ratio 0.05
   * takes ONE share of a $238 stock, and one share cannot be split 50/50 —
   * so the account that looks like a smaller copy of the other is in fact
   * running a strategy with no runner at all.
   */
  async function rehearse(accountId) {
    let cfg = broker.destinationCfg(accountId);
    if (has('test-hook')) {
      if (!cfg.testWebhookUrl) { say(`${cfg.destinationName} has no test hook — skipped`); return; }
      cfg = { ...cfg, webhookUrl: cfg.testWebhookUrl };
    }
    say('');
    say('══════════════════════════════════════════════════════════════════');
    say(`ACCOUNT     ${cfg.destinationName} [${accountId}]  ${cfg.dialect}`
      + `  hook ${has('test-hook') ? 'TEST' : 'live'}`);

    /*
     * TWO DIFFERENT QUESTIONS, kept apart.
     *
     *   1. Does the plumbing carry the whole shape into THIS account?
     *   2. Would a real signal here be big enough to have that shape at all?
     *
     * The rehearsal is question 1, so it uses the floor size — anything less
     * exercises fewer legs than production and passes. Question 2 is answered
     * beside it, from the real risk settings and this account's ratio, because
     * an account whose ratio puts every signal under the floor is running a
     * strategy with fewer ways out than the one that was backtested — and that
     * is invisible from inside a rehearsal that sized itself.
     */
    try {
      const risk = require('../src/setups/risk');
      const std = risk.sizeFor({ entry, riskPerShare: Math.abs(entry - stop) }, risk.settings());
      const real = std && risk.scaleTo(std, cfg);
      if (real) {
        say(`a real signal  ${real.shares} share(s) here`
          + (real.standardShares ? ` (${real.standardShares} at the standard × ${real.ratio})` : '')
          + (real.reason ? ` — ${real.reason}` : ''));
        if (real.shares > 0 && real.shares < floor) {
          say(`               ⚠ UNDER ${floor} — at that size a leg floors to zero, so a`);
          say('                 real signal in this account has FEWER ways out than the');
          say('                 strategy that was tested. It is not a smaller copy.');
        }
      }
    } catch { /* risk settings unreadable — the rehearsal still stands */ }

    say(`rehearsing  ${shares} share(s)   (the floor, so every leg is exercised)`);
    if (arg('shares') && shares < floor) {
      say(`            ⚠ BELOW ${floor} — a leg floors to zero and is dropped, so this`);
      say('              rehearses a DIFFERENT shape from production.');
    }
    await one_(cfg, accountId, shares);
  }

  async function one_(cfg, accountId, shares) {
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
    say('  DRY RUN — nothing was sent. Add --send to place it.');
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
  }
})().catch(e => { console.error(scrub(e.stack || e.message)); process.exit(1); });
