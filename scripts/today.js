#!/usr/bin/env node
/*
 * What actually happened today — alerts, orders, and whether they match.
 *
 * WHY THIS EXISTS. Four questions get asked after every session and each one
 * was answered from a different place: the alerts page for what fired, an inbox
 * for what the broker refused, a screenshot of the broker's order list for what
 * filled, and the strategy builder for what was supposed to happen. Four
 * sources, read at four different times, is how a strategy that sent the same
 * order sixty times went unnoticed for two hours.
 *
 * They are all on this box already. This prints them side by side, at the point
 * where they can disagree.
 *
 * THE PART THAT MATTERS is the last section. A signal is not "an order" — it is
 * as many orders as the strategy has ways out, because SignalStack places one
 * bracket per order and has no scale-out of its own. So:
 *
 *     Test                    3 orders   10% @3R · 80% @6R · 10% runner
 *     OR + VWAP 09:35         2 orders   50% @2R · 50% runner
 *     T2 10:00                1 order    100% @2R
 *
 * "One order for a strategy that should have sent three" and "sixty orders for
 * a strategy that should have sent one" are the same class of fault, and
 * neither is visible in any single one of the four places above.
 *
 * SAFE TO PASTE. Everything printed goes through scrub() — webhook ids, the
 * callback token and anything shaped like an API key are replaced. The order
 * ledger never held a hook to begin with; settings do, and are read through
 * publicSettings(), which masks them. scrub() is the belt to that pair of
 * braces, because this output is written to be pasted into a chat window.
 *
 * Usage
 *   node scripts/today.js                  today, in New York
 *   node scripts/today.js 2026-08-17       a particular session
 *   node scripts/today.js --full           every alert line, not just a summary
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const LEDGER = process.env.BROKER_LEDGER || path.join(DIR, 'broker-orders.jsonl');

const FULL = process.argv.includes('--full');
const DAY = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
  || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/*
 * Anything that could place an order in a real account, removed.
 *
 * A hook id IS the ability to trade the account behind it — there is no
 * password in front of it — so it is treated the same as a key. The patterns
 * are deliberately loose: a false positive prints [REDACTED] where a harmless
 * string was, which costs a re-run; a false negative publishes a credential.
 */
function scrub(s) {
  return String(s)
    .replace(/(signalstack\.com\/hook\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/(\/api\/broker\/callback\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]')
    .replace(/\b(PK|SK)[A-Z0-9]{16,}\b/g, '[REDACTED-KEY]')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED-KEY]')
    .replace(/\b[a-f0-9]{32,}\b/g, '[REDACTED-KEY]');
}
const say = (...a) => console.log(scrub(a.join(' ')));
const rule = t => { console.log(''); console.log(`── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); };

const nowET = new Date().toLocaleString('en-GB', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

say(`SESSION ${DAY}   ·   it is now ${nowET} in New York`);
say(`data dir: ${DIR}`);

// ── 1. the desk's own switches ─────────────────────────────────────────────
/*
 * Printed FIRST because every other section is read differently depending on
 * it. "No orders today" means nothing until you know whether the desk was
 * armed, and an alert feed full of trades on a disarmed desk is the system
 * working exactly as asked.
 */
rule('THE DESK');
let broker = null;
try {
  broker = require('../src/broker/signalstack');
  const s = broker.publicSettings();
  say(`orders enabled: ${s.enabled ? 'YES' : 'no'}      armed: ${s.armed ? '⚡ YES — real orders' : 'no'}`);
  say(`shorting: ${s.allowShort ? 'allowed' : 'off'}   flatten: ${s.flatten ? `at ${s.flattenAt} ET` : 'OFF — positions can go overnight'}`);
  if (s.maxTradesPerDay) say(`account cap: ${s.maxTradesPerDay} order(s)/day`);
  for (const d of s.destinations || []) {
    say(`  · ${d.name} [${d.id}] ${d.dialect}  ratio ${d.ratio}  buying power ${d.buyingPower}`
      + `  mode ${d.mode}  hook ${d.hasWebhook ? 'set' : 'MISSING'}`
      + (d.setups && d.setups.length ? `  setups: ${d.setups.join(', ')}` : '  setups: (all, auto)'));
  }
} catch (err) { say(`could not read broker settings: ${err.message}`); }

// ── 2. what the strategies were supposed to do ─────────────────────────────
/*
 * From qp, which is the only place a strategy is defined. Read through the
 * catalog so this shows what the RUNNER would have used, not what a seed file
 * on disk says — those two have been different before, and the difference is
 * exactly the kind of thing this script exists to surface.
 */
const expectedLegs = {};                       // setup id -> orders per signal

/*
 * How many orders one signal becomes, from the strategy's exit protocol.
 *
 * NOT from the catalog: a setup's exit_plan is priced at decision time from the
 * entry and stop, so it does not exist until there is a signal. The SHAPE does
 * — legs plus a runner if it has one — and the shape is what says how many
 * bodies go on the wire.
 *
 * A floor of one: a strategy with no protocol at all still sends its single
 * bracket. Anything else would report "expected 0 orders" for the simplest
 * case there is.
 */
function ordersPerSignal(proto) {
  if (!proto) return 1;
  const legs = Array.isArray(proto.legs) ? proto.legs.length : 0;
  const runner = proto.runner && Number(proto.runner.fraction) > 0 ? 1 : 0;
  return Math.max(1, legs + runner);
}

rule('WHAT SHOULD RUN TODAY');
async function setups() {
  const QP = (process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
  const shapes = {};                           // strategy NAME -> { n, shape }
  try {
    const res = await fetch(`${QP}/api/strategies`);
    for (const s of (await res.json()).strategies || []) {
      shapes[s.name] = { n: ordersPerSignal(s.exit_protocol),
                         shape: (s.exit_protocol || {}).shape || '' };
    }
  } catch (err) { say(`qp not reachable at ${QP} (${err.message}) — order counts unknown`); }

  try {
    const catalog = require('../src/setups/catalog');
    const list = await catalog.list();
    if (!list.length) return say('no setups — qp returned nothing, or no strategy has tools');
    for (const s of list.sort((a, b) => String(a.decisionTime).localeCompare(String(b.decisionTime)))) {
      /*
       * A setup GROUPS its long and its short — they are one idea decided at
       * one time. The two halves normally share a shape; if they ever do not,
       * saying so is better than picking one and calling it the answer.
       */
      const ns = (s.strategies || []).map(n => shapes[n]).filter(Boolean);
      const counts = [...new Set(ns.map(x => x.n))];
      const n = counts.length === 1 ? counts[0] : null;
      if (n) expectedLegs[s.id] = n;
      const win = s.windowEnd && s.windowEnd !== s.decisionTime
        ? `${s.decisionTime}–${s.windowEnd} (watch, every bar)` : `${s.decisionTime} (once)`;
      say(`${s.enabled ? '  on' : ' OFF'}  ${String(s.name).padEnd(32)} ${String(win).padEnd(34)}`
        + `${n ? `${n} order(s)/signal` : `${counts.join(' or ')} orders — THE TWO SIDES DISAGREE`}`
        + `   [${s.stage}]  tools ${(s.tools || []).join(',') || '(none)'}`);
      const shape = [...new Set(ns.map(x => x.shape))].filter(Boolean).join(' / ');
      if (shape) say(`        ${shape}`);
      if (s.readiness && s.readiness.orderOk === false) {
        say(`        ALERT ONLY — ${(s.readiness.orderBlocking || []).join('; ')}`);
      }
    }
  } catch (err) {
    say(`could not read the setups: ${err.message}`);
    say('(is qp running? pm2 list | grep qp)');
  }
}

// ── 3. what actually fired ─────────────────────────────────────────────────
function alerts() {
  rule('WHAT FIRED');
  let fires = [];
  try {
    const store = require('../src/alerts/store');
    fires = store.recentFires(DAY, 5000);
    if (!fires.length) fires = store.history({ date: DAY, limit: 5000 }).fires || [];
  } catch (err) { say(`could not read the alert feed: ${err.message}`); return []; }
  if (!fires.length) { say('nothing at all today'); return []; }

  const trades = fires.filter(f => f.level === 'trade');
  const errors = fires.filter(f => f.level === 'error');
  say(`${fires.length} line(s): ${trades.length} trade, ${errors.length} error, `
    + `${fires.length - trades.length - errors.length} info`);

  /*
   * Errors first and in full. An error repeated forty-six times is one fault,
   * and printing it forty-six times buries the other three.
   */
  if (errors.length) {
    /*
     * Timed from `at`, not from `atET`.
     *
     * atET is stamped when a fire is written to HISTORY, not when it is
     * published, so a live fire has only `at` — reading atET alone printed
     * "first    last" with nothing between them, on exactly the lines you most
     * want timed.
     *
     * Undated ones are counted separately rather than sorted in among the
     * numbers, where one bad value silently becomes the "first" or the "last"
     * and quietly moves the window the reader is being shown.
     */
    const by = {};
    for (const e of errors) {
      const k = `${e.toolId}/${e.ruleId}: ${e.detail}`;
      const b = (by[k] = by[k] || { at: [], undated: 0 });
      const t = Number(e.at);
      if (Number.isFinite(t) && t > 0) b.at.push(t); else b.undated += 1;
    }
    const hhmmss = t => new Date(t).toLocaleTimeString('en-GB',
      { timeZone: 'America/New_York', hour12: false });
    say('');
    say('ERRORS');
    const total = b => b.at.length + b.undated;
    for (const [k, b] of Object.entries(by).sort((x, y) => total(y[1]) - total(x[1]))) {
      say(`  ${total(b)}×  ${k}`);
      if (b.at.length) {
        say(`        first ${hhmmss(Math.min(...b.at))}   last ${hhmmss(Math.max(...b.at))}`
          + (b.undated ? `   (+${b.undated} with no timestamp)` : ''));
      } else {
        say('        no usable timestamps on any of them');
      }
    }
  }

  if (trades.length) {
    say('');
    say('TRADE SIGNALS');
    const seen = {};
    for (const f of trades.slice().reverse()) {
      const k = `${f.ruleId}|${f.ticker}`;
      seen[k] = (seen[k] || 0) + 1;
      if (FULL || seen[k] === 1) {
        say(`  ${(f.atET || '').slice(-8)}  ${String(f.toolId).padEnd(3)} ${String(f.ruleId).padEnd(24)} `
          + `${String(f.ticker || '-').padEnd(6)} ${f.detail}`);
      }
    }
    /*
     * THE REPEAT COUNT. A watch setup alerting twice on one name in one session
     * is the latch failing, and it is the single most expensive thing on this
     * page — each repeat is another order at another per-order fee.
     */
    const repeats = Object.entries(seen).filter(([, n]) => n > 1);
    if (repeats.length) {
      say('');
      say('  ⚠ THE SAME NAME ALERTED MORE THAN ONCE — the once-a-day latch did not hold:');
      for (const [k, n] of repeats.sort((a, b) => b[1] - a[1])) say(`      ${n}×  ${k.replace('|', '  ')}`);
      if (!FULL) say('      (--full prints every line)');
    }
  }
  return fires;
}

// ── 4. what went on the wire ───────────────────────────────────────────────
function ledger() {
  rule('WHAT WENT TO THE BROKER');
  let rows = [];
  try {
    rows = fs.readFileSync(LEDGER, 'utf8').split('\n')
      .filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(o => o && o.date === DAY);
  } catch { say(`no ledger at ${LEDGER}`); return []; }
  if (!rows.length) { say('the ledger has nothing for today — NOTHING was sent'); return []; }

  /*
   * INTENTS ARE NOT ATTEMPTS. One is written before the first POST and an
   * outcome after the last, both carrying the same id, so counting both would
   * report every order twice.
   */
  const intents = rows.filter(o => o.kind === 'intent');
  rows = rows.filter(o => o.kind !== 'intent');

  const sent = rows.filter(o => o.sent);
  say(`${rows.length} attempt(s): ${sent.length} sent, ${rows.length - sent.length} not`);

  /*
   * A CALL THAT STARTED AND NEVER FINISHED — the loudest thing in this file.
   *
   * The intent went down, the outcome never did, which means the process died
   * between the first POST and the record of what became of it. An order may
   * exist at the broker that nothing here knows about, and the repeat guard —
   * which reads `sent` — will happily let the setup take the name again.
   */
  const orphans = require('../src/broker/signalstack').orphanIntents(DAY);
  if (orphans.length) {
    say('');
    say(`  ⚠⚠ ${orphans.length} ORDER(S) STARTED AND NEVER FINISHED. Check the broker`);
    say('     BY HAND for each of these before trading the name again:');
    for (const o of orphans) {
      say(`      ${o.symbol} ${o.action || o.signal || ''} [${o.destination || '-'}]`
        + ` ${o.setupId || ''} — was about to send `
        + `${(o.legs || []).map(l => l.quantity).join(' + ') || o.asked} share(s)`);
    }
  } else if (intents.length) {
    say(`  every one of ${intents.length} order call(s) recorded its own outcome`);
  }

  /*
   * DID THE BROKER EVER CONFIRM, and what did the fill actually cost?
   *
   * An order is recorded sent on SignalStack's HTTP reply, which means
   * "accepted for delivery" and not "the broker has it" — both live rejections
   * so far arrived by email hours later. reconciled() joins the callbacks back
   * on, so "accepted, never heard from again" is answerable; it just was not
   * being asked.
   */
  try {
    const back = require('../src/broker/signalstack').reconciled(DAY)
      .filter(o => o.sent && o.kind !== 'callback');
    const unconfirmed = back.filter(o => !o.confirmed);
    const slips = back.map(o => o.slip).filter(v => typeof v === 'number');
    if (back.length) {
      say('');
      if (unconfirmed.length) {
        say(`  ⚠ ${unconfirmed.length} of ${back.length} sent order(s) were NEVER CONFIRMED`
          + ' by the broker — accepted, then silence:');
        for (const o of unconfirmed.slice(0, 8)) {
          // A flatten carries no quantity — `close` takes none, it flattens the
          // symbol — so printing o.quantity gave "WULF undefined", which reads
          // as a missing number rather than as an absent one.
          const qty = o.kind === 'flatten' ? 'whole position'
            : (Number.isFinite(o.quantity) ? String(o.quantity) : '?');
          say(`      ${o.symbol} ${qty} [${o.destination || '-'}] ${o.setupId || o.source || ''}`);
        }
      } else {
        say(`  all ${back.length} sent order(s) came back confirmed`);
      }
      if (slips.length) {
        // Signed against the position: positive is worse than the decision
        // assumed, whichever way the trade faces.
        const worst = slips.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
        const avg = slips.reduce((a, b) => a + b, 0) / slips.length;
        say(`  fill vs the price the decision used: average ${avg >= 0 ? '+' : ''}`
          + `${avg.toFixed(4)}, worst ${worst >= 0 ? '+' : ''}${worst.toFixed(4)}`
          + '   (+ = worse than assumed)');
      } else {
        say('  no fill prices came back, so the cost of the delay is unmeasured');
      }
    }
  } catch (err) { say(`  could not reconcile the callbacks: ${err.message}`); }

  say('');
  for (const o of rows) {
    const t = new Date(o.at).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false });
    const legs = o.legs ? `  legs[${o.legs.map(l => `${l.quantity}${l.target ? '@' + l.target : '→runner'}${l.sent ? '' : ' FAILED'}`).join(' ')}]` : '';
    // A close carries no quantity — it flattens whatever is there. Printing
    // "sent 0" for one reads as a failure, which is the opposite of the truth.
    const qty = o.kind === 'flatten'
      ? 'whole position    '
      : `asked ${String(o.asked ?? '-').padEnd(5)} sent ${String(o.quantity ?? 0).padEnd(5)}`;
    say(`  ${t}  ${String(o.symbol || '-').padEnd(6)} ${String(o.action || o.kind || '').padEnd(6)}`
      + ` ${qty}`
      + ` ${o.sent ? (o.status || 'sent') : 'NOT SENT'}`
      + ` [${o.destination || '-'}] ${o.setupId || o.source || ''}`
      + (o.skipped ? `  skipped: ${o.skipped}` : '')
      + (o.error ? `  ERROR: ${o.error}` : '')
      + (o.reduced ? `  reduced: ${o.reduced}` : '')
      + legs);
  }

  const refused = rows.filter(o => !o.sent);
  if (refused.length) {
    const why = {};
    for (const o of refused) {
      const k = o.skipped || o.error || 'unknown';
      why[k] = (why[k] || 0) + 1;
    }
    say('');
    say('  WHY THE REST DID NOT GO:');
    for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) say(`      ${n}×  ${k}`);
  }
  return rows;
}

// ── 4b. what the BROKER says, rather than what we believe ──────────────────
/*
 * The ledger is a record of intentions. Alpaca is a record of positions, and it
 * answers three things the ledger can only guess at: what is actually held, what
 * a fill really cost, and whether the account is blocked.
 *
 * ONE ACCOUNT. TTP5k is behind TraderEvolution and invisible to this. Said out
 * loud every time, because a reconciliation that silently covered half a desk
 * would be worse than none.
 */
async function broker_truth() {
  rule('WHAT THE BROKER SAYS (Alpaca only)');
  let reconcile;
  try { reconcile = require('../src/broker/reconcile'); }
  catch (err) { return say(`could not load the reconciler: ${err.message}`); }

  let cmp;
  try { cmp = await reconcile.compare(DAY); }
  catch (err) { return say(`could not ask Alpaca: ${err.message}`); }

  if (cmp.unverifiable && cmp.unverifiable.length) {
    say(`not covered here: ${cmp.unverifiable.join(', ')} — a different broker, `
      + 'no position feed');
  }
  if (!cmp.reachable) {
    say(`Alpaca did not answer: ${cmp.error}`);
    say('Everything above is what THIS SIDE believes, unverified.');
    return;
  }

  if (cmp.account) {
    const a = cmp.account;
    say(`account ${a.status}   equity ${a.equity}   buying power ${a.buyingPower}`
      + `   day trades ${a.daytradeCount}`);
  }
  say('');
  if (!cmp.positions.length) say('Alpaca holds NOTHING right now.');
  else {
    say('Alpaca holds:');
    for (const p of cmp.positions) {
      say(`  ${String(p.symbol).padEnd(6)} ${String(p.qty).padStart(6)} @ ${p.avgEntry}`
        + `   now ${p.current}   unrealised ${p.unrealised >= 0 ? '+' : ''}${p.unrealised}`);
    }
  }

  if (cmp.findings.length) {
    say('');
    // Errors first: one of them is an overnight position nothing here will close.
    const order = { error: 0, warn: 1, info: 2 };
    for (const f of cmp.findings.sort((x, y) => order[x.level] - order[y.level])) {
      say(`  ${f.level === 'error' ? '✗' : f.level === 'warn' ? '⚠' : '·'} ${f.detail}`);
    }
  } else {
    say('');
    say('  ✓ what this side believes and what Alpaca holds agree.');
  }

  // ── the fills, which are what a journal actually wants ──────────────────
  let f;
  try { f = await reconcile.fillsFor(DAY); } catch (err) { f = { ok: false, error: err.message }; }
  if (!f.ok) { say(''); say(`  fills unavailable: ${f.error}`); return; }
  if (!f.symbols.length) { say(''); say('  no fills today.'); return; }

  say('');
  say('FILLS — what the account actually paid, not what the decision assumed:');
  for (const g of f.symbols) {
    say(`  ${g.symbol.padEnd(6)} bought ${String(g.bought).padStart(5)} @ ${g.avgBuy ?? '-'}`
      + `   sold ${String(g.sold).padStart(5)} @ ${g.avgSell ?? '-'}`
      + (g.closed ? `   realised ${g.realised >= 0 ? '+' : ''}${g.realised}`
                  : (g.halfWindow
                      // Opened before this window, or still running. The fills
                      // cannot tell which, and saying "STILL OPEN" picked one.
                      ? '   only one side is in today — the other leg is on'
                        + ' another date, so no result can be computed here'
                      : '   STILL OPEN — no result yet')));
  }
}

// ── 4c. how each position was actually managed, minute by minute ───────────
/*
 * THE SECTION THAT ANSWERS "WHY DIDN'T IT CLOSE?"
 *
 * Everything above is what the desk SENT. This is what it SAW and chose not to
 * act on, which for a position that ran from 09:36 to 15:50 is the entire day.
 * Before the session log existed the answer to "where was the trailing stop at
 * 11:00" was not hard to find — it did not exist anywhere.
 *
 * Collapsed to the CHANGES. 390 near-identical lines hide the shape of a day as
 * thoroughly as no file at all, so a run of passes that all said the same thing
 * prints once.
 */
function managed() {
  const log = require('../src/setups/sessionLog');
  rule('HOW EACH POSITION WAS MANAGED');

  const passes = log.read(DAY);
  if (!passes.length) {
    say('no manager passes recorded.');
    say('  Either nothing was open, or the alerts app was not running — those are');
    say('  different facts and this file cannot tell them apart. Cross-check the');
    say('  ORDERS section: rows there with nothing here means the manager was down.');
    return;
  }

  const first = passes[0].at;
  const last = passes[passes.length - 1].at;
  const hhmm = ms => new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
  say(`${passes.length} pass(es), ${hhmm(first)} to ${hhmm(last)} ET.`);

  for (const sym of log.symbolsOn(DAY)) {
    const track = log.trackOf(DAY, sym);
    if (!track.length) continue;
    say('');
    say(`  ${sym}  ${track[0].setupId || '(no setup)'}  ${track[0].side || ''}`
      + (track[0].entry != null ? ` from ${track[0].entry}` : ''));
    for (const t of track) {
      const bits = [];
      if (t.stop != null) bits.push(`stop ${t.stop}${t.stopMoved ? ' (moved)' : ''}`);
      if (t.breached) bits.push('BREACHED');
      if (t.exitNow) {
        bits.push(`EXIT RULE FIRED${t.exitBarsAgo ? ` ${t.exitBarsAgo} bar(s) earlier` : ''}`);
      }
      if (t.wrongSide) bits.push('stop on the WRONG SIDE of entry — not acted on');
      if (t.error) bits.push(`could not judge: ${t.error}`);
      if (t.skipped) bits.push(`skipped: ${t.skipped}`);
      // The loop's own answer to "is the broker still holding this", which is
      // the one that says whether a close was even needed.
      if (t.heldAtBroker === null) bits.push('Alpaca not asked');
      else if (!t.heldAtBroker) bits.push('flat at Alpaca');
      if (t.managed === false) bits.push('nothing to manage — the broker holds it');
      say(`    ${hhmm(t.at)}  ${bits.join(' · ') || 'holding'}`);
    }
  }

  const acted = [];
  for (const p of passes) for (const a of p.acted || []) acted.push({ at: p.at, ...a });
  if (acted.length) {
    say('');
    say('  ACTED ON:');
    for (const a of acted) {
      say(`    ${hhmm(a.at)}  ${a.symbol} — ${a.why}`
        + (a.dryRun ? '  (dry run, nothing sent)'
                    : `  sent ${a.sent}${a.alreadyFlat ? `, ${a.alreadyFlat} already flat` : ''}`));
    }
  }
}

// ── 5. the reconciliation ──────────────────────────────────────────────────
/*
 * The only section that can find a fault nobody reported.
 *
 * Alerts and orders are each self-consistent — the alert feed says a signal
 * fired, the ledger says an order went — and the mistake lives BETWEEN them:
 * a three-leg strategy that sent one order looks perfectly healthy in both.
 */
function reconcile(fires, rows) {
  rule('DID EACH SIGNAL SEND WHAT IT SHOULD HAVE?');
  const trades = fires.filter(f => f.level === 'trade' && f.ticker);
  if (!trades.length && !rows.length) return say('nothing to reconcile — no signals and no orders');

  const signals = {};
  for (const f of trades) {
    const k = `${f.ruleId}|${String(f.ticker).toUpperCase()}`;
    signals[k] = (signals[k] || 0) + 1;
  }
  /*
   * ONE SIGNAL IS ONE ORDER PER ACCOUNT, NOT ONE ORDER.
   *
   * A setup names the accounts that trade it, and the same signal is the same
   * trade in each of them — sized separately, sent separately, one ledger row
   * each. The first version of this section compared the whole day's wire
   * count against "legs × alerts" and so accused every healthy two-account
   * signal of sending too many. It cried wolf on the one section that is
   * supposed to be worth reading.
   *
   * So the unit is the CALL: one placeOrder per account per signal, each of
   * which should put `legs` bodies on the wire. Counted per account, because
   * that is also what makes a genuine duplicate visible — two sent calls for
   * one name in ONE account is an entry taken twice, whatever the other
   * account did.
   */
  const placed = {};
  for (const o of rows) {
    if (!o.setupId || !o.sent || o.kind === 'flatten' || o.kind === 'callback') continue;
    const k = `${o.setupId}|${String(o.symbol || '').toUpperCase()}`;
    const p = (placed[k] = placed[k] || { calls: 0, wire: 0, byDest: {} });
    p.calls += 1;
    // A scale-out is ONE call that puts several bodies on the wire.
    p.wire += o.scaleOut || 1;
    const d = o.destination || '-';
    p.byDest[d] = (p.byDest[d] || 0) + 1;
  }

  const keys = [...new Set([...Object.keys(signals), ...Object.keys(placed)])].sort();
  if (!keys.length) return say('signals fired but none carried a setup id — nothing to match on');

  let bad = 0;
  for (const k of keys) {
    const [setupId, sym] = k.split('|');
    const alerted = signals[k] || 0;
    const p = placed[k] || { calls: 0, wire: 0, byDest: {} };
    const want = expectedLegs[setupId] || null;
    const accounts = Object.keys(p.byDest).length;
    const wantWire = want ? want * p.calls : null;

    const notes = [];

    /*
     * THE EXPENSIVE FAULT, and the one that has actually happened: the same
     * name entered more than once in the SAME account. Two accounts taking one
     * signal is correct; one account taking it six times is six positions
     * where the strategy asked for one.
     */
    const dupes = Object.entries(p.byDest).filter(([, n]) => n > 1);
    if (dupes.length) {
      notes.push(`ENTERED MORE THAN ONCE — ${dupes.map(([d, n]) => `${n}× in ${d}`).join(', ')}.`
        + ' One signal is one entry per account.');
    }
    if (alerted > 1) notes.push(`ALERTED ${alerted}× — should be once a day`);
    if (alerted && !p.calls) notes.push('signalled but NOTHING was sent');
    /*
     * Orders with no alert behind them is the signature of the crash: the order
     * goes first, the alert is written after, and anything that throws in
     * between leaves exactly this.
     */
    if (!alerted && p.calls) {
      notes.push(`${p.calls} order(s) with NO alert behind them — the alert was`
        + ' written after the order and did not survive. Look in the ERRORS above.');
    }
    /*
     * MORE bodies per call than the strategy has legs is always a fault. FEWER
     * can be legitimate: a leg too small to be a whole share is dropped, and a
     * leg whose target is an indicator rather than a price is folded into the
     * runner. Both are said out loud rather than passed silently, because the
     * innocent explanations and the real one look identical from here.
     */
    if (want && p.calls && p.wire > wantWire) {
      notes.push(`${p.wire} order(s) on the wire from ${p.calls} call(s), expected `
        + `${wantWire} (${want} per call) — too many`);
    } else if (want && p.calls && p.wire < wantWire) {
      notes.push(`${p.wire} order(s) on the wire from ${p.calls} call(s), expected `
        + `${wantWire} — a leg was dropped. Either it was under one whole share,`
        + ' or its target had no price and joined the runner. Check the size.');
    }
    if (notes.length) bad += 1;
    say(`  ${notes.length ? '⚠' : '✓'} ${String(sym).padEnd(6)} ${String(setupId).padEnd(26)}`
      + ` alerts ${alerted}  entries ${p.calls}`
      + (accounts ? ` in ${accounts} account(s)` : '')
      + `  orders ${p.wire}`
      + (want ? `  (${want}/entry)` : '  (shape unknown)'));
    for (const n of notes) say(`        → ${n}`);
  }
  say('');
  say(bad ? `  ${bad} of ${keys.length} do not line up.`
          : `  all ${keys.length} line up.`);
}

(async () => {
  await setups();
  const fires = alerts();
  const rows = ledger();
  await broker_truth();
  managed();
  reconcile(fires, rows);
  console.log('');
})();
