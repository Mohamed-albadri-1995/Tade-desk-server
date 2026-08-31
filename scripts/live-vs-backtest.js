#!/usr/bin/env node
/*
 * DID IT DO WHAT THE BACKTEST SAID IT WOULD?
 *
 * The last question in the loop, and the one nothing answered.
 *
 *   make a strategy      qp builder
 *   test it              backtest
 *   decide it is good    the result
 *   apply it             parity-check --adopt
 *   GET SIMILAR RESULTS  ← nothing measured this
 *
 * parity-check compares the SETTINGS. This compares the OUTCOMES: the trades
 * the backtest took over a period against the trades the desk actually took,
 * name by name, day by day.
 *
 * WHY NAME-BY-NAME AND NOT JUST P&L. Two books can end at the same number for
 * opposite reasons, and two books that end differently can differ for reasons
 * that need opposite fixes:
 *
 *   SAME NAMES, different money        the selection agreed and the EXECUTION
 *                                      cost the difference — slippage, a late
 *                                      exit, a stop that filled worse than the
 *                                      level. Fixable at the desk.
 *
 *   DIFFERENT NAMES                    the two sides did not even agree on what
 *                                      to trade. No amount of execution work
 *                                      fixes that; something about the decision
 *                                      differs, and parity-check is where to
 *                                      look.
 *
 * A P&L difference alone cannot tell those apart, which is why it is the last
 * thing printed here rather than the first.
 *
 * Usage
 *   node scripts/live-vs-backtest.js --backtest 349
 *   node scripts/live-vs-backtest.js --backtest 349 --account paperA
 *
 * The date range comes from the backtest itself — comparing a run to a period
 * it did not cover is the easiest way to produce a frightening number that
 * means nothing.
 */

const QP = (process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const DESK = (process.env.ALERTS_URL || 'http://127.0.0.1:3090').replace(/\/$/, '');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const key = (date, sym) => `${date} ${String(sym).toUpperCase()}`;
const n2 = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
const pad = (s, w) => String(s === null || s === undefined ? '—' : s).padEnd(w);

(async () => {
  const id = arg('backtest');
  if (!id) {
    console.error('need --backtest <id>');
    process.exit(2);
  }
  const wantAccount = arg('account');

  const got = await json(`${QP}/api/backtest/${id}`);
  const bt = got.backtest || got;
  const spec = bt.spec || {};
  const btTrades = bt.trades || [];
  if (!btTrades.length) {
    console.error(`backtest #${id} has no stored trades to compare against`);
    process.exit(2);
  }

  /*
   * THE PERIOD IS THE BACKTEST'S OWN, and only the days it actually covered.
   * A register backtest can only evaluate days the screener froze, so the
   * range typed into the form is not the range that was tested — comparing
   * live days the backtest never saw would report every one of them as
   * "live only", which is a frightening number that means nothing.
   */
  const covered = new Set((bt.summary && bt.summary.dates) || []);
  const dates = [...covered].sort();
  const from = dates[0] || spec.start;
  const to = dates[dates.length - 1] || spec.end;
  if (!from || !to) {
    console.error('this backtest does not record which sessions it covered');
    process.exit(2);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

  const live = await json(`${DESK}/api/broker/journal-trades?from=${from}&days=${days}`);
  if (!live.ok && !(live.trades || []).length) {
    console.error(`the desk could not list its trades: ${live.error || 'no answer'}`);
    process.exit(2);
  }
  let liveTrades = live.trades || [];
  if (wantAccount) liveTrades = liveTrades.filter(t => t.account === wantAccount);
  // Only the sessions the backtest actually covered.
  if (covered.size) liveTrades = liveTrades.filter(t => covered.has(t.date));

  console.log(`backtest  #${id}  ${bt.name || ''}`.trimEnd());
  console.log(`sessions  ${dates.length} covered, ${from} → ${to}`);
  if (wantAccount) console.log(`account   ${wantAccount}`);
  if (live.accounts) console.log(`live from ${live.accounts.join(', ')}`);
  console.log('');

  /*
   * The comparison itself lives in src/setups/outcome.js so it can be tested
   * on fixtures rather than only against a running desk — the matching rule and
   * the signed entry gap are exactly the kind of logic that looks obviously
   * right and is off by a sign.
   */
  const { compareOutcome } = require('../src/setups/outcome');
  const r = compareOutcome({
    backtestTrades: btTrades,
    liveTrades: live.trades || [],
    covered: dates,
    account: wantAccount,
    accountBlock: (bt.summary && bt.summary.account) || null,
  });

  console.log(`${pad('', 4)}${pad('trades', 10)}${pad('backtest', 12)}${pad('live', 12)}`);
  console.log(`${pad('', 4)}${pad('taken', 10)}${pad(r.counts.backtest, 12)}${pad(r.counts.live, 12)}`);
  console.log(`${pad('', 4)}${pad('in both', 10)}${pad(r.counts.both, 12)}`);
  console.log(`${pad('', 4)}${pad('bt only', 10)}${pad(r.counts.btOnly, 12)}`);
  console.log(`${pad('', 4)}${pad('live only', 10)}${pad('', 12)}${pad(r.counts.liveOnly, 12)}`);
  console.log('');

  /*
   * THE SELECTION VERDICT, printed before any money. If the two sides did not
   * agree on WHAT to trade, every P&L difference below is a comparison between
   * two different books and says nothing about execution.
   */
  const largest = Math.max(r.counts.backtest, r.counts.live);
  if (r.verdict === 'no-overlap') {
    console.log('  THE TWO SIDES SHARE NO TRADE AT ALL. Nothing below is a');
    console.log('  comparison of execution — they did not trade the same thing.');
  } else if (r.verdict === 'selection-differs') {
    console.log(`  SELECTION DIFFERS — only ${r.counts.both} of ${largest} names are shared.`);
    console.log('  Fix that before reading the money: run');
    console.log(`    node scripts/parity-check.js --backtest ${id}`);
  } else {
    console.log(`  Selection agrees on ${r.counts.both} of ${largest} names.`);
  }

  if (r.btOnly.length) {
    console.log('');
    console.log('  THE BACKTEST TOOK, THE DESK DID NOT:');
    for (const x of r.btOnly.slice(0, 12)) console.log(`    ${x.key}`);
    if (r.btOnly.length > 12) console.log(`    …and ${r.btOnly.length - 12} more`);
  }
  if (r.liveOnly.length) {
    console.log('');
    console.log('  THE DESK TOOK, THE BACKTEST DID NOT:');
    for (const x of r.liveOnly.slice(0, 12)) {
      console.log(`    ${x.key}${x.live.account ? `  (${x.live.account})` : ''}`);
    }
    if (r.liveOnly.length > 12) console.log(`    …and ${r.liveOnly.length - 12} more`);
  }

  if (r.entryGapPct !== null) {
    console.log('');
    console.log('  ENTRY PRICE, live against backtest, on the shared trades');
    console.log(`    average ${r.entryGapPct}%  (positive = the desk paid worse)`);
    for (const w of r.worstEntries) {
      console.log(`    ${pad(w.key, 22)} backtest ${n2(w.backtest)}  live ${n2(w.live)}  `
        + `${w.pct >= 0 ? '+' : ''}${w.pct}%`);
    }
  }

  console.log('');
  console.log('  MONEY');
  console.log(`    backtest  ${r.money.backtest !== null ? `$${n2(r.money.backtest)}`
    : 'no account block — the run was not sized'}`);
  console.log(`    live      $${n2(r.money.live)} over ${r.money.liveClosed} closed trade(s)`);
  if (r.money.liveOpen) {
    console.log(`    (${r.money.liveOpen} still open — an open trade has a number that `
      + 'is not a result yet)');
  }
  if (r.money.gap !== null) {
    console.log(`    gap       ${r.money.gap >= 0 ? '+' : ''}$${n2(r.money.gap)}`);
    if (r.money.gapIsExecution) {
      console.log('    Selection agreed, so this gap IS the execution — slippage,');
      console.log('    a late exit, or a stop that filled worse than its level.');
    } else {
      console.log('    Selection did NOT agree, so this gap is two different books');
      console.log('    and says nothing about execution.');
    }
  }
  console.log('');
})().catch(err => { console.error(err.message); process.exit(1); });
