#!/usr/bin/env node
/*
 * Connect a qp strategy to a screener, as one command.
 *
 *   node scripts/add-setup.js --list
 *   node scripts/add-setup.js --strategies
 *
 *   node scripts/add-setup.js \
 *     --id T3-SETUP-A --name "T3 setup A" --tool T3 \
 *     --strategy "Setup A" --at 10:00 --top 2 \
 *     --only "bias eq BULLISH" --only "score egreater 70"
 *
 *   node scripts/add-setup.js --remove T3-SETUP-A
 *
 * WHY A COMMAND RATHER THAN AN EDIT. A setup is a binding — which qp strategy
 * decides it, whose card list is the universe, when, how the day's signals are
 * ranked, and which cards are even eligible. That is five short facts, and
 * making somebody write them as a JavaScript object over SSH from a phone is a
 * way of ensuring the second setup never gets added.
 *
 * It writes data/setups.json, which is gitignored, so it survives `git pull`
 * and needs no rebuild. Everything it can express is a binding; none of it is
 * logic, because the logic is the qp strategy and stays there.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const FILE = process.env.SETUPS_FILE || path.join(DIR, 'setups.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const many = (f) => argv.reduce((acc, a, i) =>
  (a === f && argv[i + 1] !== undefined ? [...acc, argv[i + 1]] : acc), []);

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.setups || []);
  } catch { return []; }
}

function write(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

/* ── what already exists ─────────────────────────────────────────────────── */

if (has('--list') || argv.length === 0) {
  const setups = require(path.join(ROOT, 'src', 'setups'));
  const universe = require(path.join(ROOT, 'src', 'setups', 'universe'));
  const added = new Set(read().map(s => s.id));
  console.log('Setups:\n');
  for (const s of setups.all()) {
    console.log(`  ${s.id}${added.has(s.id) ? '  (added)' : '  (built in)'}`);
    console.log(`    ${s.name}`);
    console.log(`    tool ${s.toolId} · ${s.decisionTime} ET · top ${(s.rank || {}).topN || 2}`);
    console.log(`    qp strategy: ${s.strategyId}`);
    const gate = universe.describe(s.universe);
    if (gate) console.log(`    only cards where: ${gate}`);
    console.log();
  }
  if (argv.length === 0) {
    console.log('Add one:   node scripts/add-setup.js --id X --name "…" --tool T3 \\');
    console.log('             --strategy "…" --at 10:00 --top 2 --only "bias eq BULLISH"');
    console.log('See qp\'s strategies:   node scripts/add-setup.js --strategies');
  }
  process.exit(0);
}

/* ── what qp has to offer ────────────────────────────────────────────────── */

if (has('--strategies')) {
  const url = (process.env.QP_URL || 'http://127.0.0.1:8765') + '/api/strategies';
  require('axios').get(url, { timeout: 10000 })
    .then(r => {
      const list = r.data.strategies || r.data || [];
      if (!list.length) return console.log('qp has no saved strategies yet.');
      console.log('Strategies saved in qp — copy the name into --strategy:\n');
      for (const s of list) console.log(`  ${s.name}   (${s.side || '?'})`);
      console.log('\nA setup usually names the SHARED PREFIX of a long/short pair,');
      console.log('so "T2 10:00 VWAP Extension" picks up both (Long) and (Short).');
    })
    .catch(e => {
      console.error(`Could not reach qp at ${url}: ${e.message}`);
      console.error('Is it running?   sudo systemctl status qp-chart');
      process.exit(1);
    });
  return;
}

/* ── removing one ────────────────────────────────────────────────────────── */

if (has('--remove')) {
  const id = val('--remove');
  const list = read();
  const left = list.filter(s => s.id !== id);
  if (left.length === list.length) {
    console.error(`No added setup with id ${id}. Built-in setups cannot be removed here —`);
    console.error('switch one off in the alerts app instead.');
    process.exit(1);
  }
  write(left);
  console.log(`Removed ${id}. Restart the tools to apply:  bash deploy-tools.sh`);
  process.exit(0);
}

/* ── adding one ──────────────────────────────────────────────────────────── */

const id = val('--id');
const name = val('--name');
const tool = (val('--tool') || '').toUpperCase();
const strategy = val('--strategy');
const at = val('--at', '10:00');

const problems = [];
if (!id) problems.push('--id is required (a short name, e.g. T3-SETUP-A)');
if (!name) problems.push('--name is required (what it is called in the list)');
if (!/^T[1-9]$/.test(tool)) problems.push('--tool must be T1…T9 — whose card list is the universe');
if (!strategy) problems.push('--strategy is required — the qp strategy name, see --strategies');
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) problems.push('--at must be HH:MM in ET');

/*
 * A filter rule, written as three words: FIELD OPERATOR VALUE.
 *
 *   --only "bias eq BULLISH"
 *   --only "score egreater 70"
 *
 * Deliberately not JSON on the command line. The point of this script is that
 * adding a setup does not require typing punctuation correctly on a phone.
 */
const universe = require(path.join(ROOT, 'src', 'setups', 'universe'));
const rules = many('--only').map(spec => {
  const [left, op, ...rest] = String(spec).trim().split(/\s+/);
  return { left, op, right: rest.join(' ') };
});
if (rules.length) {
  const errs = universe.validate({ rules });
  for (const e of errs) problems.push(`--only: ${e}`);
}

if (problems.length) {
  console.error('Cannot add this setup:\n');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('\nFields you can filter on:');
  console.error('  ' + Object.keys(universe.FIELDS).join(', '));
  console.error('Operators:');
  console.error('  ' + universe.OPERATORS.map(o => o.value).join(', '));
  process.exit(1);
}

const entry = {
  id, name, toolId: tool, strategyId: strategy,
  decisionTime: at,
  // One extra scan just before, so the card list is not five minutes old at the
  // one moment it is read. Free, and the reason it exists is not obvious later.
  universeScanAt: val('--scan', null) || minutesBefore(at, 2),
  rank: { metric: 'vwap_extension', topN: Number(val('--top', 2)) },
  tf: val('--tf', '1m'),
  feed: val('--feed', 'yahoo'),
  targetR: Number(val('--target-r', 2)),
  fill: val('--fill', 'close'),
  liveFeed: val('--feed', 'yahoo'),
  describe: [
    `At ${at} ET, on ${tool}'s card list.`,
    `Decided by the qp strategy "${strategy}".`,
    `Ranked by distance from VWAP, top ${Number(val('--top', 2))}.`,
  ],
  caution: val('--caution', 'Not yet validated live — trade small until the sample grows.'),
};
if (rules.length) {
  entry.universe = { logic: (val('--logic', 'AND') || 'AND').toUpperCase(), rules };
  entry.describe.splice(1, 0, `Only cards where ${universe.describe(entry.universe)}.`);
}

function minutesBefore(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m - mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

const list = read();
const i = list.findIndex(s => s.id === id);
if (i >= 0) list[i] = entry;
else list.push(entry);
write(list);

console.log(`${i >= 0 ? 'Updated' : 'Added'} ${id}\n`);
console.log(`  ${name}`);
console.log(`  tool ${tool} · ${at} ET · top ${entry.rank.topN} · feed ${entry.feed}`);
console.log(`  qp strategy: ${strategy}`);
if (entry.universe) console.log(`  only cards where: ${universe.describe(entry.universe)}`);
console.log(`\n  written to ${path.relative(ROOT, FILE)}`);
console.log('\nNext:');
console.log('  1. bash deploy-tools.sh          restart the tools so it is scheduled');
console.log('  2. check the Setups list in the alerts app — it should be there, switched on');
console.log(`  3. try it on a past session before it runs live:`);
console.log(`     curl -sS "http://127.0.0.1:${toolPort(tool)}/api/setups/${id}/run?date=YYYY-MM-DD"`);

function toolPort(t) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
    const found = (reg.tools || []).find(x => x.id === t);
    return found ? found.port : 3000;
  } catch { return 3000; }
}
