#!/usr/bin/env node
/*
 * What would actually go on the wire for this strategy, at this price?
 *
 * A signal does not become "an order". It becomes as many orders as the
 * strategy has ways out, because SignalStack places ONE bracket per order and
 * has no scale-out of its own — so a strategy that takes a tenth off at 3R,
 * four fifths at 6R and lets the rest ride is three orders, and the last of
 * them must carry a stop and NO target.
 *
 * Getting that wrong is silent and expensive: a runner sent with the first
 * leg's target is a strategy that was never tested. This prints the exact
 * bodies, byte for byte, before any money is involved — for a strategy that
 * exists, at a price you choose, through the same two functions the live path
 * uses. Nothing here knows the name of any strategy.
 *
 * Usage
 *   node scripts/order-preview.js "Test" --entry 94.04 --stop 93.50 --risk 500
 *   node scripts/order-preview.js "OR + VWAP 09:35 (Long)" --entry 50 --stop 49.40 --shares 833
 *   node scripts/order-preview.js "Test" --entry 94.04 --stop 93.50 --risk 500 --dialect alpaca
 *   node scripts/order-preview.js --list
 *
 *   --entry   the fill price the signal would get          (required)
 *   --stop    the stop the strategy computed               (required)
 *   --risk    dollars of risk -> shares = risk / (entry-stop)
 *   --shares  an exact share count instead of --risk
 *   --side    long | short   (defaults to the strategy's own side)
 *   --dialect ttp | alpaca   (alpaca adds class + duration)
 *   --qp      qp base URL    (default http://127.0.0.1:8765)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

function arg(name, dflt = null) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const has = name => process.argv.includes('--' + name);

const QP = (arg('qp') || process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const NAME = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;

async function qp(pathname, body) {
  const res = await fetch(QP + pathname, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}`);
  return res.json();
}

(async () => {
  if (has('list') || !NAME) {
    const d = await qp('/api/strategies');
    console.log('Strategies on ' + QP + ':\n');
    for (const s of (d.strategies || []).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = s.exit_protocol || {};
      console.log(`  ${s.name.padEnd(34)} ${(s.side || '?').padEnd(5)} ${p.shape || ''}`);
    }
    if (!NAME) console.log('\nName one, with --entry and --stop, to see its orders.');
    return;
  }

  const entry = Number(arg('entry'));
  const stop = Number(arg('stop'));
  if (!(entry > 0) || !(stop > 0)) {
    console.error('--entry and --stop are required, and both must be prices.');
    process.exit(1);
  }

  // The exit plan comes FROM qp. It is the only place that arithmetic lives,
  // and re-deriving it here is exactly how live orders stop matching the
  // backtest that justified them.
  const side = arg('side');
  const r = await qp('/api/strategy/exit_plan',
                     { name: NAME, side, entry, stop, target_r: Number(arg('r', 2)) });
  if (!r.ok) {
    console.error(r.error + (r.have ? '\nStrategies are:\n  ' + r.have.join('\n  ') : ''));
    process.exit(1);
  }

  const perShare = Math.abs(entry - stop);
  const shares = arg('shares')
    ? Math.floor(Number(arg('shares')))
    : Math.floor(Number(arg('risk', 500)) / perShare);

  // A throwaway broker config: this must never read, or touch, the real one.
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'order-preview-'));
  process.env.BROKER_FILE = path.join(DIR, 'broker.json');
  process.env.BROKER_LEDGER = path.join(DIR, 'orders.jsonl');
  const broker = require('../src/broker/signalstack');
  const dialect = arg('dialect', 'ttp');
  broker.save({
    destinations: [{ id: 'preview', name: dialect, dialect,
                     webhookUrl: 'https://app.signalstack.com/hook/PREVIEWonly0000000000',
                     buyingPower: 1e9, ratio: 1, mode: 'auto', setups: [] }],
    enabled: true,
  });
  broker.save({ armed: true, allowShort: true });
  const cfg = broker.destinationCfg('preview');

  const plan = r.plan;
  const p = broker.planOrder({
    symbol: arg('symbol', 'AAAA'), signal: r.side === 'short' ? 'SHORT' : 'LONG',
    quantity: shares, price: entry, stop, target: (plan.legs[0] || {}).price || null,
    date: new Date().toISOString().slice(0, 10), plan, cfg,
  });

  console.log(`\n${r.name}  ·  ${r.side}  ·  ${dialect}`);
  console.log(`entry ${entry}   stop ${stop}   risk/share ${perShare.toFixed(4)}`
    + `   shares ${shares}`);
  console.log(`exit shape: ${plan.legs.length} leg(s)`
    + (plan.runner ? ` + ${Math.round(plan.runner * 100)}% runner` : ' + no runner')
    + `   stop ${plan.stop_kind}`);

  if (p.blocked) {
    console.log(`\nNOTHING WOULD BE SENT — ${p.blocked}: ${p.reason}`);
    fs.rmSync(DIR, { recursive: true, force: true });
    return;
  }

  const bodies = p.orders && p.orders.length ? p.orders : [p.body];
  console.log(`\n=> ${bodies.length} JSON${bodies.length === 1 ? '' : 's'} on the wire:\n`);
  bodies.forEach((b, i) => {
    const kind = b.take_profit_price == null ? 'RUNNER — stop only, rides to the close'
      : `target ${b.take_profit_price}`;
    console.log(`  [${i + 1}] ${kind}`);
    console.log(`      ${JSON.stringify(b)}`);
  });
  const total = bodies.reduce((n, b) => n + b.quantity, 0);
  console.log(`\n  shares ${total} of ${shares}`
    + (total === shares ? '  ✓ every sized share is ordered' : '  ✗ MISMATCH'));
  if (p.unplaceable && p.unplaceable.length) {
    console.log(`  ${p.unplaceable.length} leg(s) had a target no broker can rest — `
      + 'their shares joined the runner');
  }
  fs.rmSync(DIR, { recursive: true, force: true });
})().catch(e => {
  console.error(e.message.includes('fetch') || e.message.includes('ECONNREFUSED')
    ? `Could not reach qp at ${QP} — is qp-chart running? (--qp to point elsewhere)`
    : e.message);
  process.exit(1);
});
