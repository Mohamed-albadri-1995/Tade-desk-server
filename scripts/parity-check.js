#!/usr/bin/env node
/*
 * IS THE LIVE DESK RUNNING THE BACKTEST YOU APPROVED?
 *
 * Point it at a stored backtest id and the setup it was meant to validate, and
 * it prints both sides of every setting that decides what gets traded — the
 * decision bar, the fill model, the ranking, the sizing, the caps, the
 * universe — and says which of them disagree.
 *
 * WHY IT IS NEEDED. The desk was built to reproduce a backtest and, after two
 * weeks of live trading, had not. Nothing had gone wrong in any dramatic way:
 * the settings simply lived in three files, no two of which were ever read
 * together, and the only symptom was a P&L that did not match. That is the
 * least diagnostic symptom there is.
 *
 * The heaviest difference was not a number at all. A setup's entry window pins
 * the FILL bar, so on a ONE-MINUTE window the fill model decides which bar the
 * conditions are read on:
 *
 *     'next_open' / 'desk'   entry at the 09:35 OPEN,  decided on 09:34
 *     'close'                entry at the 09:35 CLOSE, decided on 09:35
 *
 * A different bar's close, VWAP and ATR is a different SIGNAL, not a different
 * price — so the two sides can pick different stocks on the same day with the
 * same rules, which is exactly what happened.
 *
 * Usage
 *   node scripts/parity-check.js --all           # EVERY setup, latest backtest
 *   node scripts/parity-check.js --backtest 349
 *   node scripts/parity-check.js --backtest 349 --setup "OR + VWAP 09:35@09:35"
 *   node scripts/parity-check.js --list          # the setups the desk knows
 *
 * `--all` is the one to run after a deploy and before trusting a morning: it
 * walks every setup the desk would fire and checks it against the most recent
 * finished backtest of its own strategy. A setup with no backtest at all is
 * reported as exactly that, because "never validated" and "validated and
 * matching" must not look the same.
 *
 * Exit code 1 when anything DIFFERS, so it can be run from a deploy script.
 */

const QP = (process.env.QP_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const parity = require('../src/setups/parity');
const catalog = require('../src/setups/catalog');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

async function qp(path) {
  const res = await fetch(`${QP}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

const pad = (s, n) => String(s === null || s === undefined ? '—' : s).padEnd(n);
const MARK = { match: '  ok  ', differ: 'DIFFER', unknown: '  ?   ' };

(async () => {
  const setups = await catalog.list();

  if (has('list')) {
    console.log('setups the desk knows:');
    for (const s of setups) {
      console.log(`  ${s.id}`
        + `   decides ${s.decisionTime}${s.windowEnd !== s.decisionTime ? `–${s.windowEnd}` : ''}`
        + `   tools ${(s.tools || []).join(',') || '—'}`);
    }
    return;
  }

  // The strategy list, needed to tie a backtest to a setup and to read the
  // entry window the decision bar is derived from.
  const all = await qp('/api/strategies');
  const strategies = all.strategies || [];
  const baseName = (n) => String(n).replace(/\s*\((Long|Short)\)\s*$/i, '').trim();
  const fullStrategy = async (st) => (st && st.risk ? st
    : ((await qp(`/api/strategies/${st.id}`)).strategy || st));

  /* Print one comparison. Shared by the single and the --all paths so the two
   * can never drift into showing different things. */
  const report = (setup, id, name, strategyName, res) => {
    console.log(`setup     ${setup.id}`);
    console.log(`backtest  #${id}  ${name || ''}`.trimEnd());
    console.log(`strategy  ${strategyName}`);
    console.log('');
    console.log(`${pad('', 6)} ${pad('what', 20)} ${pad('live', 16)} ${pad('backtest', 16)}`);
    for (const r of res.rows) {
      console.log(`${MARK[r.status]} ${pad(r.what, 20)} ${pad(r.live, 16)} ${pad(r.backtest, 16)}`);
    }
    const lines = parity.summarise(res);
    if (lines.length) {
      console.log('');
      for (const l of lines) console.log(`  ${l}`);
    }
    console.log('');
    if (res.differs.length) {
      console.log(`  ${res.differs.length} setting(s) DIFFER. This backtest does not`
        + ' describe what the desk is doing.');
      if (res.differs.some(d => d.what === 'decision bar')) {
        console.log('  The decision bar is the one to fix first: a different bar is a');
        console.log('  different signal, so the two sides can pick different stocks on');
        console.log('  the same day with identical rules.');
      }
    } else {
      console.log('  Every comparable setting agrees.');
    }
    if (res.unknown.length) {
      console.log(`  ${res.unknown.length} could not be compared — shown as "?" above.`);
    }
  };

  /*
   * EVERY SETUP, against the most recent finished backtest of its own strategy.
   *
   * The single-setup mode answers "does this run match". This answers the
   * question that actually matters before a session: "is anything the desk
   * will fire this morning running something nobody validated". A setup with
   * NO backtest is reported as exactly that — never validated and validated-
   * and-matching must not look the same.
   */
  if (has('all')) {
    const listed = await qp('/api/backtests');
    // Newest first. The list endpoint carries the summary but NOT the spec —
    // the spec is what holds the fill model and the sizing, so the match is
    // made on the summary's strategy name and the spec is fetched only for the
    // one run that is actually going to be compared.
    const runs = (listed.backtests || [])
      .filter(b => (b.status || 'done') === 'done')
      .sort((a, b) => Number(b.id) - Number(a.id));
    let bad = 0;
    let unchecked = 0;
    for (const setup of setups) {
      const st = strategies.find(x => baseName(x.name) === setup.name);
      console.log('='.repeat(72));
      if (!st) {
        console.log(`${setup.id}\n  no qp strategy by that name — cannot compare`);
        unchecked += 1;
        continue;
      }
      // `strategy_name` is "Long + Short" for a paired run, so match on the
      // base name appearing in it rather than on equality.
      const mine = runs.filter(b => {
        const nm = (b.summary || {}).strategy_name || b.name || '';
        return String(nm).includes(setup.name);
      });
      if (!mine.length) {
        console.log(`${setup.id}\n  NEVER BACKTESTED. The desk would fire this setup`
          + ' and there is no run to compare it against.');
        unchecked += 1;
        continue;
      }
      const detail = await qp(`/api/backtest/${mine[0].id}`);
      const row = detail.backtest || detail;
      const spec = row.spec || {};
      if (!Object.keys(spec).length) {
        console.log(`${setup.id}\n  backtest #${mine[0].id} stored no spec —`
          + ' nothing to compare against');
        unchecked += 1;
        continue;
      }
      const res = parity.compare({ setup, spec, strategy: await fullStrategy(st) });
      report(setup, mine[0].id, row.name, st.name, res);
      if (res.differs.length) bad += 1;
    }
    console.log('='.repeat(72));
    console.log(`${setups.length} setup(s) · ${bad} with differences`
      + `${unchecked ? ` · ${unchecked} with nothing to compare against` : ''}`);
    process.exit(bad ? 1 : 0);
  }

  const id = arg('backtest');
  if (!id) {
    console.error('need --backtest <id>, or --all for every setup'
      + '   (or --list to see the setups)');
    process.exit(2);
  }

  const got = await qp(`/api/backtest/${id}`);
  const bt = got.backtest || got;
  const spec = bt.spec || {};
  if (!spec || !Object.keys(spec).length) {
    console.error(`backtest #${id} has no stored spec — nothing to compare against`);
    process.exit(2);
  }

  /*
   * WHICH SETUP THIS BACKTEST WAS ABOUT. Named explicitly when it can be;
   * otherwise matched on the strategy the run used. Guessing wrong here would
   * compare a real backtest against the wrong desk configuration and report
   * confident nonsense, so an ambiguous match is refused rather than picked.
   */
  const want = arg('setup');
  let setup = want ? setups.find(s => s.id === want || s.name === want) : null;
  if (want && !setup) {
    console.error(`no setup called ${JSON.stringify(want)} — try --list`);
    process.exit(2);
  }
  if (!setup) {
    const sid = spec.strategy_id || (spec.strategy_ids || [])[0];
    const st = strategies.find(x => Number(x.id) === Number(sid));
    const base = st ? baseName(st.name) : null;
    const hits = base ? setups.filter(s => s.name === base) : [];
    if (hits.length !== 1) {
      console.error(`could not tell which setup backtest #${id} belongs to`
        + (base ? ` (strategy "${base}" matched ${hits.length} setups)` : '')
        + ' — name it with --setup, or --list to see them');
      process.exit(2);
    }
    setup = hits[0];
  }

  // The qp strategy, for its risk block — window_start/window_end are what make
  // the decision bar computable, and they live only in qp.
  const strategy = strategies.find(x => Number(x.id) === Number(spec.strategy_id))
    || strategies.find(x => baseName(x.name) === setup.name)
    || null;
  if (!strategy) {
    console.error('could not load the qp strategy behind this setup — the'
      + ' decision-bar comparison needs its entry window');
    process.exit(2);
  }
  // /api/strategies may list without the body; fetch the full one if so.
  const full = await fullStrategy(strategy);
  const res = parity.compare({ setup, spec, strategy: full });
  report(setup, id, bt.name, full.name, res);
  process.exit(res.differs.length ? 1 : 0);
})().catch(err => { console.error(err.message); process.exit(2); });
