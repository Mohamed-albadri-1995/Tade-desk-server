#!/usr/bin/env node
/*
 * WHICH EXECUTION IS BEST — measured, not argued.
 *
 * The live desk and the backtest were configured differently in three places,
 * and only one of those was a defect. The other two are DIALS: both sides can
 * do either, so there is no "correct" answer to reason out — there is a better
 * one and a worse one on YOUR days, and this is how it gets read off.
 *
 *   MAX POSITION %  — the per-trade cap. Live sends 16.66. Backtest #346 ran
 *                     with none. This is the dial that decides how many names
 *                     a day can afford, so it does not change P&L per trade,
 *                     it changes WHICH TRADES HAPPEN AT ALL.
 *
 *   RISK MODEL      — a percentage of equity (compounds: a winning run sizes
 *                     up) or flat dollars (does not). Live risks a flat $500;
 *                     backtests have used 0.5%, which over the user's own
 *                     fortnight grew the budget from 499.95 to 552.40.
 *
 * WHY "UNCAPPED LOOKS BETTER" IS USUALLY AN ILLUSION. Without a per-trade cap
 * the FIRST tight-stop signal of the day buys the whole balance — ALNY's $0.63
 * stop took $99,966 of a $100k account in backtest #237 — and every later
 * signal that day is then skipped for lack of capital, in ARRIVAL ORDER rather
 * than by rank. So the uncapped run is not the same strategy sized bigger; it
 * is a much smaller sample, chosen by clock rather than by quality. A big
 * number over four trades is not evidence.
 *
 * That is exactly why `skipped_no_capital` and `trades_sized` are printed
 * beside every P&L here, and why the ranking flags a winner that took
 * materially fewer trades than the field.
 *
 * WHAT THIS DOES NOT SWEEP. The fill model is settled — `desk` is the only one
 * describing trades this account could have taken (scripts/fill-compare.js
 * makes that comparison if you want to see it again). And ranking is not a
 * dial at all: it now reads the DECISION price, so it cannot depend on the
 * fill. There is nothing to choose there because the alternative was never
 * reachable live.
 *
 * COST. One full backtest per combination, run one at a time. Four caps by two
 * risk models is eight runs. Start with fewer.
 *
 * Usage
 *   # is the 16.66% cap helping or hurting?
 *   node scripts/exec-compare.js --strategy "T2 09:35 (Short)" \
 *        --start 2026-08-18 --end 2026-08-29 --tool T2 \
 *        --equity 100000 --max-pos 0,16.66,25 --risk usd:500
 *
 *   # flat dollars vs compounding, at the live cap
 *   node scripts/exec-compare.js --strategy "T2 09:35 (Short)" \
 *        --start 2026-08-18 --end 2026-08-29 --tool T2 \
 *        --equity 100000 --max-pos 16.66 --risk usd:500,pct:0.5
 *
 *   # the full grid, with the live ranking applied
 *   node scripts/exec-compare.js … --rank vwap_extension --top-n 3
 */

const QP = (process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');

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
const FILL = arg('fill', 'desk');
const COST = Number(arg('cost-bps', '0')) || 0;
const EQUITY = Number(arg('equity', '100000')) || 0;
const LEV = Number(arg('leverage', '1')) || 1;
const RANK = arg('rank');
const TOPN = Number(arg('top-n', '0')) || 0;

/*
 * THE CAPS TO TRY. `0` means no cap, and it is worth including precisely
 * because it is the run whose result is most easily misread — see the header.
 */
const CAPS = String(arg('max-pos', '0,16.66,25'))
  .split(',').map(s => Number(s.trim()))
  .filter(v => Number.isFinite(v) && v >= 0);

/*
 * THE RISK MODELS TO TRY, as `usd:500` / `pct:0.5`. Spelled with the unit
 * because "0.5" and "500" are not two settings of one dial — they are two
 * different dials, and a bare number cannot say which was meant.
 */
const RISKS = String(arg('risk', 'pct:0.5')).split(',').map(raw => {
  const s = raw.trim();
  const m = /^(usd|pct):(-?[\d.]+)$/i.exec(s);
  if (!m || !(Number(m[2]) > 0)) {
    console.error(`bad --risk entry ${JSON.stringify(s)} — use usd:500 or pct:0.5`);
    process.exit(2);
  }
  const kind = m[1].toLowerCase();
  const v = Number(m[2]);
  return { kind, v, label: kind === 'usd' ? `$${v}` : `${v}%` };
});

if (!START || !END || (!STRATEGY && !STRATEGY_ID)) {
  console.error('need --start, --end and one of --strategy / --strategy-id');
  process.exit(2);
}
if (!EQUITY) {
  console.error('need --equity — without an account size there is no dollar P&L'
    + ' to compare, and the caps have nothing to be a percentage OF');
  process.exit(2);
}

async function qp(path, opts) {
  const res = await fetch(`${QP}${path}`, opts);
  return res.json();
}

async function strategy() {
  const out = await qp('/api/strategies');
  const list = out.strategies || [];
  if (STRATEGY_ID) {
    const id = Number(STRATEGY_ID);
    const hit = list.find(s => Number(s.id) === id);
    return { id, name: hit ? hit.name : `#${id}` };
  }
  const hit = list.find(s => s.name === STRATEGY.trim());
  if (!hit) {
    throw new Error(`no strategy called ${JSON.stringify(STRATEGY.trim())} — qp has: `
      + list.map(s => s.name).join(', '));
  }
  return { id: hit.id, name: hit.name };
}

function universe() {
  if (SYMBOLS) {
    return { kind: 'symbols',
             symbols: SYMBOLS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) };
  }
  return TOOL ? { kind: 'tools', register: REGISTER, tools: [TOOL] }
              : { kind: 'tools', register: REGISTER };
}

async function runOne(sid, cap, risk) {
  const spec = {
    name: `exec-compare cap=${cap || 'none'} risk=${risk.label}`,
    strategy_id: sid,
    universe: universe(),
    start: START, end: END, tf: TF, feed: FEED, view: 'all',
    fill: FILL, cost_bps: COST, days: 3,
    account_equity: EQUITY,
    max_leverage: LEV,
    max_position_pct: cap || 0,
    // Exactly one of these is ever set. The server refuses both at once
    // rather than quietly preferring one, so send only the one asked for.
    risk_pct: risk.kind === 'pct' ? risk.v : 0,
    risk_usd: risk.kind === 'usd' ? risk.v : 0,
    ...(RANK && TOPN ? { rank_per_day: { metric: RANK, top_n: TOPN } } : {}),
  };
  const started = await qp('/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  });
  if (!started.ok) throw new Error(started.error || 'backtest refused');

  process.stdout.write(`  cap ${String(cap || 'none').padEnd(6)} risk ${risk.label.padEnd(6)}`
    + ` #${started.id} `);
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    const g = await qp(`/api/backtest/${started.id}`);
    const row = g.backtest || g;
    if (row.status === 'running') { process.stdout.write('.'); continue; }
    process.stdout.write('\n');
    if (row.status !== 'done') {
      throw new Error(`#${started.id} ended ${row.status}: ${row.error || 'no reason given'}`);
    }
    const s = row.summary || {};
    // THE ACCOUNT BLOCK IS THE ANSWER HERE, not the summary's percentages.
    // max_position_pct does not change any single trade's return — it changes
    // how many shares were bought and therefore how many later trades could be
    // afforded at all. Reading this off `total_return_pct` would show no
    // difference whatsoever between the caps and conclude the dial does
    // nothing.
    if (!s.account) {
      throw new Error(`#${started.id} produced no account block — nothing was`
        + ' sizable (every trade missing a stop?), so there is no dollar P&L');
    }
    return { id: started.id, dates: s.dates, trades: s.trades, ...s.account };
  }
}

const n = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '—');
const usd = v => (typeof v === 'number'
  ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  : '—');

(async () => {
  const st = await strategy();
  console.log(`${st.name}  (#${st.id})`);
  console.log(`${START} → ${END}  ·  ${TF} ${FEED}  ·  fill ${FILL}  ·  costs ${COST} bps/side`);
  console.log(`account ${usd(EQUITY)}  ·  leverage ${LEV}×`
    + (RANK && TOPN ? `  ·  rank ${RANK} top ${TOPN}` : '  ·  no ranking'));
  console.log(`caps: ${CAPS.map(c => c || 'none').join(', ')}   risk: ${RISKS.map(r => r.label).join(', ')}`);
  console.log('');

  const rows = [];
  let covered = [];
  for (const cap of CAPS) {
    for (const risk of RISKS) {
      try {
        const r = await runOne(st.id, cap, risk);
        rows.push({ cap, risk, r });
        if (!covered.length && Array.isArray(r.dates)) covered = r.dates;
      } catch (err) {
        console.log(`    FAILED — ${err.message}`);
        rows.push({ cap, risk, r: null });
      }
    }
  }

  if (covered.length) {
    console.log('');
    console.log(`  sessions with data: ${covered.length}`
      + `  (${covered[0]} → ${covered[covered.length - 1]})`);
    if (covered[0] !== START || covered[covered.length - 1] !== END) {
      console.log(`  ⚠ YOU ASKED FOR ${START} → ${END}. The rest has no frozen`
        + ' register day and contributed nothing.');
    }
  }

  console.log('');
  console.log(`${'cap'.padEnd(7)}${'risk'.padEnd(8)}${'net $'.padStart(11)}`
    + `${'return'.padStart(9)}${'max DD'.padStart(9)}${'sized'.padStart(7)}`
    + `${'capped'.padStart(8)}${'no cash'.padStart(9)}${'win %'.padStart(8)}`);
  for (const { cap, risk, r } of rows) {
    if (!r) {
      console.log(`${String(cap || 'none').padEnd(7)}${risk.label.padEnd(8)}`
        + `${'failed'.padStart(11)}`);
      continue;
    }
    console.log(`${String(cap || 'none').padEnd(7)}${risk.label.padEnd(8)}`
      + `${usd(r.net_pnl_usd).padStart(11)}`
      + `${n(r.return_pct, 2).padStart(8)}%`
      + `${n(r.max_drawdown_pct, 2).padStart(8)}%`
      + `${String(r.trades_sized ?? '—').padStart(7)}`
      + `${String(r.size_capped_by_position ?? 0).padStart(8)}`
      + `${String(r.skipped_no_capital ?? 0).padStart(9)}`
      + `${n(r.win_rate_pct, 1).padStart(8)}`);
  }
  console.log('');
  console.log('  sized   = trades the account could actually pay for');
  console.log('  capped  = trades cut down by the per-trade cap');
  console.log('  no cash = trades SKIPPED entirely — the balance was already committed');

  const good = rows.filter(x => x.r && typeof x.r.net_pnl_usd === 'number');
  if (good.length > 1) {
    const best = [...good].sort((a, b) => b.r.net_pnl_usd - a.r.net_pnl_usd);
    console.log('');
    console.log('  best first:');
    const most = Math.max(...good.map(x => x.r.trades_sized || 0));
    for (const x of best) {
      const sized = x.r.trades_sized || 0;
      console.log(`    ${usd(x.r.net_pnl_usd).padStart(10)}  over ${String(sized).padStart(3)}`
        + ` trade(s), max DD ${n(x.r.max_drawdown_pct, 2)}%`
        + `   cap ${x.cap || 'none'}, risk ${x.risk.label}`);
    }
    /*
     * THE ONE WARNING THAT MATTERS. If the winner traded far less than the
     * field, it did not beat them — it played a different, shorter game, and
     * the difference is usually one uncapped position that happened to work.
     * Said out loud because the table above cannot say it, and the P&L column
     * on its own is exactly the thing that misleads here.
     */
    const w = best[0];
    const wn = w.r.trades_sized || 0;
    if (most && wn < most * 0.75) {
      console.log('');
      console.log(`  ⚠ THE WINNER TOOK ${wn} TRADES; another setting took ${most}.`
        + ' That is not the same strategy sized differently, it is a smaller');
      console.log('    sample — and with no per-trade cap the trades it kept were'
        + ' chosen by ARRIVAL ORDER, not by rank. Check the "no cash" column:');
      console.log('    those are ranked signals the account could not pay for.');
    }
    if (w.r.skipped_no_capital) {
      console.log('');
      console.log(`  ⚠ the winning setting skipped ${w.r.skipped_no_capital} signal(s)`
        + ' for lack of capital. Live, those are trades the desk WOULD have');
      console.log('    sent and the broker WOULD have rejected.');
    }
  }
  console.log('');
})().catch(err => { console.error(err.message); process.exit(1); });
