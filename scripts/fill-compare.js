#!/usr/bin/env node
/*
 * Which strategies work, and how much of the answer was the fill assumption.
 *
 * Two axes: one or more STRATEGIES against one or more FILL MODELS.
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
 *   # how much of this result was the fill assumption — 3 runs
 *   node scripts/fill-compare.js --strategy "OR + VWAP 09:35 (Long)" \
 *        --start 2026-07-01 --end 2026-08-19 --tool T2
 *
 *   # WHICH STRATEGY WORKS — one run each, on the only honest model
 *   node scripts/fill-compare.js --models desk --cost-bps 3 \
 *        --start 2026-07-01 --end 2026-08-19 \
 *        --strategy "Test,T2 10:00 VWAP Extension (Long),T2 10:00 VWAP Extension (Short)"
 *
 *   node scripts/fill-compare.js --strategy-id 7 --start … --end … --tool T2
 *   node scripts/fill-compare.js … --symbols SPY,QQQ
 */

const QP = (process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const ALL_MODELS = ['close', 'next_open', 'desk'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/*
 * TWO AXES, ONE SCRIPT.
 *
 * "How much of this result was the fill assumption" needs one strategy across
 * three models. "Which of my strategies works" needs several strategies across
 * ONE model — and the model is settled: `desk` is the only row describing
 * trades this account could have taken, so comparing strategies on the other
 * two would be comparing two fictions.
 *
 * qp runs one backtest at a time, so the second question costs one run per
 * strategy rather than three. `--models desk` is what makes that affordable.
 */
const MODELS = String(arg('models', ALL_MODELS.join(',')))
  .split(',').map(s => s.trim()).filter(Boolean);
for (const m of MODELS) {
  if (!ALL_MODELS.includes(m)) {
    console.error(`unknown fill model ${JSON.stringify(m)} — known: ${ALL_MODELS.join(', ')}`);
    process.exit(2);
  }
}

// Comma-separated, because a strategy name never contains one:
// "OR + VWAP 09:35 (Long),T2 10:00 VWAP Extension (Long)".
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

/** Resolve the named strategies to ids, so the caller can use names they see. */
async function strategies() {
  const out = await qp('/api/strategies');
  const list = out.strategies || [];
  if (STRATEGY_ID) {
    const id = Number(STRATEGY_ID);
    const hit = list.find(s => Number(s.id) === id);
    return [{ id, name: hit ? hit.name : `#${id}` }];
  }
  // Named one at a time so a typo names ITSELF. Resolving the batch and
  // reporting "one of these did not match" would leave the reader comparing
  // the list they typed against the list qp has, by eye, on a phone.
  return String(STRATEGY).split(',').map(raw => {
    const want = raw.trim();
    const hit = list.find(s => s.name === want);
    if (!hit) {
      throw new Error(`no strategy called ${JSON.stringify(want)} — qp has: `
        + list.map(s => s.name).join(', '));
    }
    return { id: hit.id, name: hit.name };
  });
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
  const strats = await strategies();
  console.log(`${START} → ${END}  ·  ${TF} ${FEED}  ·  costs ${COST} bps/side`);
  console.log(`universe: ${JSON.stringify(universe())}`);
  console.log(`models: ${MODELS.join(', ')}`);
  console.log('');

  // strategy name -> { model -> summary }
  const results = {};
  let covered = [];
  for (const st of strats) {
    console.log(`strategy #${st.id} ${st.name}`);
    results[st.name] = {};
    for (const m of MODELS) {
      try {
        const r = await runOne(st.id, m);
        results[st.name][m] = r;
        if (!covered.length && Array.isArray(r.dates)) covered = r.dates;
      } catch (err) {
        console.log(`  ${m.padEnd(10)} FAILED — ${err.message}`);
        results[st.name][m] = null;
      }
    }
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

  const W = Math.max(12, ...strats.map(s => s.name.length));
  const head = (label) => `${label.padEnd(W)}${'model'.padEnd(11)}`
    + `${'trades'.padStart(7)}${'win %'.padStart(8)}${'net %'.padStart(10)}`
    + `${'avg %'.padStart(9)}${'max DD'.padStart(9)}${'sharpe'.padStart(8)}`;
  const line = (label, m, s) => `${label.padEnd(W)}${m.padEnd(11)}`
    + `${String((s && s.trades) ?? '—').padStart(7)}`
    + `${n(s && s.win_rate, 1).padStart(8)}${n(s && s.total_return_pct).padStart(10)}`
    + `${n(s && s.avg_return_pct, 3).padStart(9)}`
    + `${n(s && s.max_drawdown_pct).padStart(9)}${n(s && s.sharpe).padStart(8)}`;

  console.log('');
  console.log(head('strategy'));
  for (const st of strats) {
    for (const m of MODELS) console.log(line(st.name, m, results[st.name][m]));
  }

  /*
   * THE ASSUMPTION'S PRICE, per strategy — only sayable when both ends were run.
   * If 'close' is the only profitable row, the edge was in the fill model.
   */
  if (MODELS.includes('desk') && MODELS.includes('close')) {
    console.log('');
    for (const st of strats) {
      const d = results[st.name].desk;
      const c = results[st.name].close;
      if (!d || !c || typeof d.total_return_pct !== 'number'
          || typeof c.total_return_pct !== 'number') continue;
      const lost = c.total_return_pct - d.total_return_pct;
      console.log(`  ${st.name}: the assumption was worth `
        + `${lost >= 0 ? '+' : ''}${lost.toFixed(2)} points over ${d.trades} trade(s)`
        + (c.trades !== d.trades
            ? `  (close took ${c.trades}, desk took ${d.trades} — the models do not`
              + ' always take the same trades)' : ''));
      if (c.total_return_pct > 0 && d.total_return_pct <= 0) {
        console.log('    ⚠ PROFITABLE ONLY UNDER THE OPTIMISTIC FILL. The edge was'
          + ' in the assumption.');
      }
    }
  }

  /*
   * RANKED, when there is more than one strategy — on `desk`, because it is the
   * only row describing trades this account could have taken.
   *
   * NET RETURN IS NOT THE RANKING ON ITS OWN. A strategy that made half a point
   * through a six-point drawdown is not beating one that made a quarter point
   * through one, and reading a column of net returns invites exactly that
   * conclusion. So the drawdown rides beside every line, and a result smaller
   * than its own drawdown is called what it is: too small to read.
   */
  if (strats.length > 1 && MODELS.includes('desk')) {
    const rows = strats
      .map(st => ({ name: st.name, s: results[st.name].desk }))
      .filter(r => r.s && typeof r.s.total_return_pct === 'number')
      .sort((a, b) => b.s.total_return_pct - a.s.total_return_pct);
    if (rows.length) {
      console.log('');
      console.log('  on the desk fill, best first:');
      for (const r of rows) {
        const dd = r.s.max_drawdown_pct;
        const net = r.s.total_return_pct;
        const thin = typeof dd === 'number' && Math.abs(net) < dd;
        console.log(`    ${n(net).padStart(7)}%  over ${String(r.s.trades).padStart(3)}`
          + ` trade(s), max drawdown ${n(dd)}%   ${r.name}`
          + (thin ? '   ← smaller than its own drawdown: too few trades to read' : ''));
      }
    }
  }

  console.log('');
  console.log('  desk = what this account would really have got. Judge on that row.');
})().catch(err => { console.error(err.message); process.exit(1); });
