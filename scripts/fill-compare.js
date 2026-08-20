#!/usr/bin/env node
/*
 * The same strategy, the same days, three fill models — side by side.
 *
 * WHY THIS EXISTS. A backtest's number is only meaningful next to the
 * assumption that produced it, and the three assumptions available here are
 * not small variations of each other:
 *
 *   close      the entry is booked at the signal bar's close — a price no
 *              order can reach, because it only becomes knowable at the
 *              instant the bar ends and the market order goes out after that.
 *
 *   next_open  the entry is the next bar's open, which is right, and then the
 *              stop and every target are RE-MEASURED from that fill. That
 *              hands the trade back the exact R the strategy was tested at.
 *
 *   desk       the entry is the next bar's open and the levels are measured
 *              from the DECISION bar's close — the two prices the live desk
 *              really uses, because the bracket is priced and sent before the
 *              fill exists and SignalStack cannot amend it afterwards.
 *
 * The gap between them is not a rounding error. Live on 2026-08-19, WULF was
 * decided at 15.37 and filled at 15.24 against a 15.74 stop: a plan that said
 * 2.00R was a 1.31R trade. Whether that costs the strategy its edge is a
 * question about YOUR strategy on YOUR days, and this is how it gets answered.
 *
 * It is not free: three full backtests, one after another, and qp runs one at
 * a time on a t3.micro. Expect minutes, not seconds.
 *
 * Usage
 *   node scripts/fill-compare.js --strategy "OR + VWAP 09:35 (Long)" \
 *        --start 2026-07-01 --end 2026-08-19
 *   node scripts/fill-compare.js --strategy-id 7 --start … --end … --tool T2
 *   node scripts/fill-compare.js … --symbols SPY,QQQ
 *   node scripts/fill-compare.js … --cost-bps 3
 */

const QP = (process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const MODELS = ['close', 'next_open', 'desk'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const STRATEGY = arg('strategy');
const STRATEGY_ID = arg('strategy-id');
const START = arg('start');
const END = arg('end');
const TOOL = arg('tool');
const SYMBOLS = arg('symbols');
const REGISTER = arg('register', 'R1');
const TF = arg('tf', '1m');
const FEED = arg('feed', 'yahoo');
const COST = Number(arg('cost-bps', '0')) || 0;

if (!START || !END || (!STRATEGY && !STRATEGY_ID)) {
  console.error('need --start, --end and one of --strategy / --strategy-id');
  console.error('  node scripts/fill-compare.js --strategy "OR + VWAP 09:35 (Long)" '
    + '--start 2026-07-01 --end 2026-08-19');
  process.exit(2);
}

async function qp(path, opts) {
  const res = await fetch(`${QP}${path}`, opts);
  const body = await res.json();
  return body;
}

/** Resolve a strategy NAME to its id, so the caller can use the name they see. */
async function strategyId() {
  if (STRATEGY_ID) return Number(STRATEGY_ID);
  const out = await qp('/api/strategies');
  const list = out.strategies || [];
  const hit = list.find(s => s.name === STRATEGY);
  if (!hit) {
    throw new Error(`no strategy called ${JSON.stringify(STRATEGY)} — qp has: `
      + list.map(s => s.name).join(', '));
  }
  return hit.id;
}

function universe() {
  if (SYMBOLS) {
    return { kind: 'symbols',
             symbols: SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) };
  }
  // The setup's own tools, which is the only pairing that will ever happen
  // live. `tools` is optional — qp falls back to the strategy's assignment.
  return TOOL ? { kind: 'tools', register: REGISTER, tools: [TOOL] }
              : { kind: 'tools', register: REGISTER };
}

/*
 * One run, start to finish. qp takes one backtest at a time, so this polls
 * rather than firing all three at once — and reports progress, because on a
 * t3.micro a silent five minutes is indistinguishable from a hang.
 */
async function runOne(sid, fill) {
  const spec = {
    name: `fill-compare ${fill}`,
    strategy_id: sid,
    universe: universe(),
    start: START, end: END, tf: TF, feed: FEED, view: 'all',
    fill, cost_bps: COST, days: 3,
  };
  const started = await qp('/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!started.ok) throw new Error(started.error || 'backtest refused');

  process.stdout.write(`  ${fill.padEnd(10)} #${started.id} `);
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    const g = await qp(`/api/backtest/${started.id}`);
    const row = g.backtest || g;
    if (row.status === 'running') { process.stdout.write('.'); continue; }
    process.stdout.write('\n');
    if (row.status !== 'done') {
      throw new Error(`#${started.id} ended ${row.status}: ${row.error || 'no reason given'}`);
    }
    return { id: started.id, ...(row.summary || {}) };
  }
}

const n = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '—');

(async () => {
  const sid = await strategyId();
  console.log(`strategy #${sid} ${STRATEGY || ''}`);
  console.log(`${START} → ${END}  ·  ${TF} ${FEED}  ·  costs ${COST} bps/side`);
  console.log(`universe: ${JSON.stringify(universe())}`);
  console.log('');

  const out = {};
  for (const m of MODELS) {
    try { out[m] = await runOne(sid, m); }
    catch (err) { console.log(`  ${m.padEnd(10)} FAILED — ${err.message}`); out[m] = null; }
  }

  /*
   * WHAT THE RUN ACTUALLY COVERED, which is not what was asked for.
   *
   * A register universe can only be evaluated on days the screener FROZE. Ask
   * for five months when the register holds seven weeks and the run reports
   * the range you typed and the trades it had — a 2026-04-01 → 2026-08-19 run
   * came back with the same 16 trades and the same 31.2% win rate as the
   * 2026-07-01 run, because it was the same seven weeks. Nothing said so, and
   * "I widened the window and the result did not change" is the most
   * misleading possible reading of that.
   */
  const covered = (out.desk && out.desk.dates) || (out.close && out.close.dates) || [];
  if (covered.length) {
    const first = covered[0];
    const last = covered[covered.length - 1];
    console.log('');
    console.log(`  sessions with data: ${covered.length}  (${first} → ${last})`);
    if (first !== START || last !== END) {
      console.log(`  ⚠ YOU ASKED FOR ${START} → ${END}. The rest of that range has`
        + ' no frozen register day, so it contributed nothing —'
        + ' the numbers below cover the shorter period only.');
    }
  }

  console.log('');
  console.log(`${'model'.padEnd(11)}${'trades'.padStart(7)}${'win %'.padStart(8)}`
    + `${'net %'.padStart(10)}${'avg %'.padStart(9)}${'max DD'.padStart(9)}${'sharpe'.padStart(8)}`);
  for (const m of MODELS) {
    const s = out[m];
    if (!s) { console.log(`${m.padEnd(11)}${'—'.padStart(7)}`); continue; }
    console.log(`${m.padEnd(11)}${String(s.trades ?? '—').padStart(7)}`
      + `${n(s.win_rate, 1).padStart(8)}${n(s.total_return_pct).padStart(10)}`
      + `${n(s.avg_return_pct, 3).padStart(9)}${n(s.max_drawdown_pct).padStart(9)}`
      + `${n(s.sharpe).padStart(8)}`);
  }

  /*
   * THE ONE LINE THAT MATTERS. 'desk' is the only row that describes trades
   * this account could have taken. The others are there to show how much of
   * the result was assumption — and if 'close' is the only profitable row,
   * the strategy's edge was in the fill model, not in the strategy.
   */
  const d = out.desk;
  const c = out.close;
  console.log('');
  if (d && c && typeof d.total_return_pct === 'number'
      && typeof c.total_return_pct === 'number') {
    const lost = c.total_return_pct - d.total_return_pct;
    console.log(`  the assumption was worth ${lost >= 0 ? '+' : ''}${lost.toFixed(2)}`
      + ` points of return over ${d.trades} trade(s)`
      + (c.trades !== d.trades ? `  (close took ${c.trades}, desk took ${d.trades}`
        + ' — the models do not always take the same trades)' : ''));
    if (c.total_return_pct > 0 && d.total_return_pct <= 0) {
      console.log('  ⚠ PROFITABLE ONLY UNDER THE OPTIMISTIC FILL. The edge was'
        + ' in the assumption.');
    }
  }
  console.log('');
  console.log('  desk = what this account would really have got. Judge on that row.');
})().catch(err => { console.error(err.message); process.exit(1); });
