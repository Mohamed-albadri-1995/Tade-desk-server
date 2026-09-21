#!/usr/bin/env node
/*
 * TAKE A SCREENER OFF EVERY SETUP THAT RUNS ON IT.
 *
 * WHY THIS IS A SCRIPT AND NOT AN EDIT.
 *
 * Switching a tool off is two separate facts in two separate places, and doing
 * only one of them leaves the desk in a state that looks fine and is not:
 *
 *   tools.config.json      enabled:false — the tool stops SCANNING. Its
 *                          process collects no cards from tomorrow morning.
 *
 *   the strategy in qp     `tools` — which card lists a setup is run against.
 *                          This lives in qp's database, not in this repo, so
 *                          no commit can change it and no deploy carries it.
 *
 * Leave the second one and the setup still names the sleeping tool. Its
 * scheduled run there finds an empty card list every morning and reports "no
 * cards" — which is the same words a live tool says on a quiet day. A setup
 * that is off reads exactly like a setup that found nothing.
 *
 * WHAT IT REFUSES TO DO.
 *
 * A strategy with no tools is not a setup. catalog.js drops it from the list
 * entirely — "something being worked on in qp" — so it stops being scheduled,
 * stops appearing on the Algo page, and does so silently. Taking the last tool
 * off a strategy is therefore a deletion wearing an edit's clothes, and this
 * will not do it. It names them and stops.
 *
 * WHAT IT CANNOT DO FOR YOU.
 *
 * The universe a setup trades is part of what its backtest measured. Changing
 * it from two screeners to one is a change to the thing itself, not a setting:
 * the expectancy, the win rate and the size that came off that backtest were
 * measured on picks this setup will no longer see. parity.js says so on its
 * own — "the backtest ran on T10, T11 and this setup belongs to T11" — and it
 * is right to. Re-run the backtest on the remaining tool.
 *
 *   node scripts/retire-tool.js T10             # say what would change
 *   node scripts/retire-tool.js T10 --apply     # change it
 *
 * Then, on the box: pm2 stop tool-T10, and pull the registry change that marks
 * it asleep.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const qp = require(path.join(ROOT, 'src', 'setups', 'qpClient'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TOOL = (args.find(a => !a.startsWith('--')) || '').toUpperCase();

function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

/*
 * WHAT WOULD CHANGE, decided separately from doing it.
 *
 * Kept as a function of the two lists so it can be run against the shapes qp
 * actually returns — a strategy with one tool, with the tool twice, with the
 * field missing — rather than trusted. Every rule that matters is in here:
 * which strategies are touched, what they are left with, and which are refused
 * because taking the last tool off one deletes it from the desk without
 * saying so.
 */
function planFor(strategies, toolId) {
  const plans = (strategies || [])
    .filter(s => s && Array.isArray(s.tools) && s.tools.includes(toolId))
    .map((s) => {
      const from = s.tools.filter(Boolean);
      // filter, not indexOf+splice: a strategy carrying the tool twice must
      // come back with it gone, not with one copy left.
      const to = from.filter(t => t !== toolId);
      return { s, from, to, refused: !to.length };
    });
  return {
    plans,
    doable: plans.filter(p => !p.refused),
    refused: plans.filter(p => p.refused),
  };
}

async function main() {
  if (!TOOL) {
    die('Which tool? e.g.  node scripts/retire-tool.js T10 [--apply]');
  }

  // The registry first, because a typo here is a script that reports "no setup
  // names T1O" and looks like a clean result.
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
  const entry = (reg.tools || []).find(t => t.id === TOOL);
  if (!entry) {
    die(`${TOOL} is not in tools.config.json. Known: `
      + (reg.tools || []).map(t => t.id).join(', '));
  }

  console.log(`\n${TOOL} — ${entry.name}`);
  console.log(`registry says: ${entry.enabled === false ? 'asleep' : 'SCANNING'}`
    + `${entry.archive ? ', archive readable' : ''}`);
  if (entry.enabled !== false) {
    console.log('  ⚠ still enabled in tools.config.json. Set "enabled": false there '
      + 'and deploy, or it keeps collecting cards.');
  }

  console.log(`\nasking qp at ${qp.baseUrl()} …`);
  let strategies;
  try {
    strategies = await qp.strategies();
  } catch (e) {
    // AN ERROR IS NEVER A ZERO. "qp did not answer" and "no setup uses this
    // tool" are the same empty list and opposite conclusions.
    die(`qp did not answer: ${e.message}\n`
      + 'Nothing was changed. Start qp, or set QP_URL, and run this again.');
  }

  const mine = strategies.filter(s => (s.tools || []).includes(TOOL));
  if (!mine.length) {
    console.log(`\nNo strategy in qp names ${TOOL}. Nothing to change.`);
    console.log(`(qp answered with ${strategies.length} strategies, so that is a `
      + 'real "none", not a failed question.)\n');
    return;
  }

  const { plans, doable, refused: no } = planFor(mine, TOOL);

  console.log(`\n${plans.length} strateg${plans.length === 1 ? 'y' : 'ies'} name${plans.length === 1 ? 's' : ''} it:\n`);
  for (const p of plans) {
    const last = p.refused;
    console.log(`  ${last ? 'REFUSED' : 'change '}  ${p.s.name}`);
    console.log(`            ${p.from.join(', ')}  ->  ${p.to.join(', ') || '(nothing)'}`);
    if (last) {
      console.log('            A strategy with no tools is dropped from the setups');
      console.log('            list entirely — not scheduled, not on the Algo page,');
      console.log('            and silently. Give it another tool in qp first, or');
      console.log('            delete it there on purpose.');
    }
  }

  if (!APPLY) {
    console.log(`\nNothing has been changed. Add --apply to make ${doable.length} `
      + `change${doable.length === 1 ? '' : 's'}`
      + `${no.length ? ` (${no.length} would be refused)` : ''}.\n`);
    return;
  }

  if (!doable.length) {
    die('Every strategy that names this tool would be left with none. '
      + 'Nothing was changed.');
  }

  console.log('');
  let done = 0;
  for (const p of doable) {
    try {
      await qp.setTools(p.s.id, p.to);
      done++;
      console.log(`  ok       ${p.s.name} -> ${p.to.join(', ')}`);
    } catch (e) {
      // Reported per strategy rather than thrown, so one refusal does not hide
      // which of the others went through.
      console.log(`  FAILED   ${p.s.name}: ${e.message}`);
    }
  }

  console.log(`\n${done} of ${doable.length} changed.`);
  if (done) {
    console.log('\nTHE BACKTEST NOW MEASURES A DIFFERENT UNIVERSE than the one');
    console.log('these setups trade. Re-run each one in qp against the tools it');
    console.log('has left — the Algo page will say so until you do.');
  }
  console.log('');
}

/*
 * Run when it is the program, exported when it is required. A script that
 * talks to qp the moment a test loads it is a script no test can load.
 */
if (require.main === module) {
  main().catch((e) => die(`unexpected: ${e.stack || e.message}`));
}

module.exports = { planFor };
