#!/usr/bin/env node
/*
 * WHICH FILTER IS KILLING THIS SCREENER.
 *
 * A screener that returns nothing looks exactly like a screener whose setup is
 * rare, and the two need opposite responses. T8's breakout screener ran, every
 * day, for twenty recorded days, and put ZERO names into a register — while the
 * pullback beside it produced seventy-three. Both were enabled, TradingView
 * answered both, neither errored. Nothing on the desk could say which of its
 * eight filters was responsible, or whether any of them was.
 *
 * So this asks TradingView the question directly, one filter at a time:
 *
 *     the floor alone          how many tradable stocks there are at all
 *     each filter on its own   how many survive that ONE rule
 *     all but one              how many would match if that rule were dropped
 *     everything               what the screener actually returns
 *
 * The row where "all but one" jumps from nothing to something is the filter
 * doing the killing. If no single filter explains it, the answer is that the
 * combination is genuinely rare — which is also worth knowing, and is a
 * different fact from a broken rule.
 *
 * IT WRITES NOTHING AND CHANGES NOTHING. It reads the screener definition and
 * asks TradingView; no register, no card, no database row is touched.
 *
 *   node scripts/why-empty.js canslim                 (T1's database)
 *   DB_PATH=data/t10.db node scripts/why-empty.js canslim
 *   DB_PATH=data/t11.db node scripts/why-empty.js canslim-pullback
 *
 * A SINGLE DAY IS ONE SAMPLE. A screener asking for something that happens on
 * strong days can be honestly empty on a weak one — so a zero here is the
 * beginning of the answer, and the ARCHIVE (how many days it ever produced a
 * row) is the rest of it. Both are printed.
 */

const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tradedesk.db');

const store = require('../src/sideA/screenerStore');
const { testScreener } = require('../src/sideA/tvScanner');
const db = require('../src/db');

const KEY = (process.argv[2] || '').trim();

/** One filter, as the trader would read it back. */
function describe(f) {
  const op = {
    greater: '>', egreater: '≥', less: '<', eless: '≤',
    equal: '=', nequal: '≠', in_range: 'in', not_in_range: 'not in',
    crosses: 'crosses', above: 'above', below: 'below',
  }[f.operation] || f.operation;
  return `${f.left} ${op} ${f.right}`;
}

/** Ask TradingView, and never let one refusal end the ladder. */
async function count(def) {
  try {
    const r = await testScreener(def);
    /*
     * THE TOTAL, NOT THE PAGE. `count` is how many rows came back, and the
     * request asks for a page — so it saturates at the limit and stops being a
     * measure of anything. The first run of this ladder reported "97" for six
     * different filters on a box where the page was 100: a number that was
     * arithmetically correct and answered a question nobody asked.
     */
    const n = Number.isFinite(r.totalCount) ? r.totalCount : r.count;
    return { n, page: r.count, ms: r.ms, error: null };
  } catch (err) {
    // A REFUSAL IS NOT A ZERO. "TradingView rejected this field" and "no stock
    // matched" are opposite facts and they must never print the same way.
    return { n: null, ms: null, error: err.message };
  }
}

const show = (c) => (c.error ? `ERROR: ${c.error}` : `${c.n}`);

/*
 * THE VERDICT, and it refuses to name a culprit when there is not one.
 *
 * A filter is to blame when removing it turns nothing into something. If
 * removing any single filter still leaves nothing, no one rule is responsible —
 * the COMBINATION is what is rare, and saying otherwise sends you off to
 * rewrite an innocent line.
 *
 * AN ERROR IS NEVER A ZERO. A refused request and "no stock matched" are
 * opposite facts; a ladder that counted a 403 as "this filter matches nothing"
 * would blame whichever rule happened to be asked when the network went.
 *
 * Pure, and separated from the printing, because this is the part that can lie.
 */
function verdictOf(all, rows) {
  if (all.error) {
    return ['VERDICT: TradingView refused the screener itself — fix that first.',
      `  ${all.error}`];
  }
  if (all.n > 0) {
    return [`VERDICT: it matches ${all.n} name(s) right now. If its register is `
      + 'empty, the problem is upstream of the filters — the run window, the '
      + 'schedule, or the tool being paused.'];
  }
  const answered = rows.filter(r => r.without.n !== null);
  if (!answered.length) {
    return ['VERDICT: not one of the leave-one-out probes came back, so nothing '
      + 'here can be blamed on a filter. Ask again when TradingView answers.'];
  }
  const blame = answered.filter(r => r.without.n > 0)
    .sort((a, b) => b.without.n - a.without.n);
  if (!blame.length) {
    const out = ['VERDICT: no single filter explains the zero — dropping any one of '
      + 'them still returns nothing, so it is the COMBINATION that is rare.'];
    const tightest = rows.filter(r => r.alone.n !== null)
      .sort((a, b) => a.alone.n - b.alone.n)[0];
    if (tightest) {
      out.push(`  The tightest on its own is  ${describe(tightest.f)}  `
        + `(${tightest.alone.n} name(s)).`);
    }
    if (answered.length < rows.length) {
      // …and it says how much of the ladder it is standing on.
      out.push(`  ${rows.length - answered.length} probe(s) did not answer, so this `
        + 'is a verdict over the ones that did.');
    }
    return out;
  }
  const top = blame[0];
  const out = [`VERDICT: ${describe(top.f)}`,
    `  Without it the screener returns ${top.without.n} name(s); with it, none.`];
  if (blame.length > 1) {
    out.push(`  ${blame.length - 1} other filter(s) would also open it up — the list `
      + 'above has the numbers.');
  }
  out.push('  Check that rule says what you meant before changing anything else.');
  return out;
}

async function main() {
  if (!KEY) {
    console.error('Usage: node scripts/why-empty.js <screener-key>   '
      + '(DB_PATH=data/t10.db to pick a tool)');
    console.error('\nScreeners in this database:');
    for (const s of store.list()) {
      console.error(`  ${s.key.padEnd(22)} ${s.name}${s.enabled ? '' : '   (switched off)'}`);
    }
    process.exit(1);
  }

  const screener = store.list().find(s => s.key === KEY);
  if (!screener) {
    console.error(`No screener with key '${KEY}' in ${process.env.DB_PATH}.`);
    console.error('Screeners here: ' + store.list().map(s => s.key).join(', '));
    process.exit(1);
  }

  const filters = screener.filters || [];
  console.log(`\n${screener.name}  (${screener.key})`);
  console.log(`${process.env.DB_PATH}${screener.enabled ? '' : '   ⚠ SWITCHED OFF'}`);
  console.log(`${filters.length} filter(s), limit ${screener.limit}\n`);

  /*
   * THE ARCHIVE FIRST, because it is the question a single probe cannot answer.
   * "Nothing today" and "nothing in twenty days" are different findings, and
   * only the second one condemns the rule.
   */
  try {
    const days = db.prepare('SELECT COUNT(DISTINCT date) n FROM r1_frozen').get().n;
    /*
     * PARSED, NOT PATTERN-MATCHED. `data LIKE '%CANSLIM%'` also matches every
     * "CANSLIM Pullback" row — one screener's history counted as another's,
     * printed as a fact. The rows record the screener's DISPLAY NAME in
     * screenerKeys (see src/sideA/merge.js), and older rows may carry the key,
     * so both are accepted — the same rule scripts/split-tool-history.js uses.
     */
    const want = [screener.key, screener.name].filter(Boolean);
    let mine = 0;
    for (const row of db.prepare('SELECT data FROM r1_frozen').all()) {
      let keys;
      try { keys = (JSON.parse(row.data) || {}).screenerKeys; } catch { continue; }
      if (Array.isArray(keys) && keys.some(k => want.includes(k))) mine += 1;
    }
    console.log(`In this tool's archive: ${mine} row(s) carrying "${screener.name}" `
      + `across ${days} recorded day(s).`);
    if (!mine && days) {
      console.log('  → it has never produced a row here. That is what this is for.');
    }
    console.log('');
  } catch { /* a fresh database has no archive yet, which is fine */ }

  /*
   * ONE PLACE THIS LADDER IS NOT THE REAL RUN. testScreener asks under the key
   * 'test', and the liquidity exemption for neglected-name screeners is keyed
   * by the screener's own key — so for those, this applies a floor the real
   * scan does not, and every count below is a floor lower than the truth.
   * Said out loud rather than left to be discovered from a number.
   */
  const { NEGLECTED_KEYS } = require('../src/sideA/seedScreeners');
  if (NEGLECTED_KEYS.has(screener.key)) {
    console.log('NOTE: this screener is exempt from the liquidity floor in a real '
      + 'scan, and this probe cannot ask for that exemption. Every count below is '
      + 'therefore LOWER than what the tool actually sees.\n');
  }

  const base = { name: screener.name, sort: screener.sort, limit: 100 };

  // 1 · the floor alone — the size of the pond before any of the screener's
  //     own rules. If this is small, nothing downstream is surprising.
  const floor = await count({ ...base, filters: [] });
  console.log(`tradable universe (floor only) ......... ${show(floor)}`);
  console.log('  (counts below are how many stocks MATCHED, from TradingView\'s own '
    + 'total — not the page of rows fetched)');

  // 2 · everything — what the screener actually returns today
  const all = await count({ ...base, filters });
  console.log(`this screener, as written .............. ${show(all)}\n`);

  if (!filters.length) {
    console.log('No filters to test — this screener is the floor.');
    return;
  }

  // 3 · one filter at a time, and all-but-one. The second column is the one
  //     that names a culprit; the first says whether that rule is tight on its
  //     own or only in company.
  console.log('  ALONE = how many pass this rule by itself');
  console.log('  WITHOUT = how many the screener would return if this rule went\n');
  const rows = [];
  for (let i = 0; i < filters.length; i += 1) {
    const alone = await count({ ...base, filters: [filters[i]] });
    const without = await count({ ...base, filters: filters.filter((_, j) => j !== i) });
    rows.push({ f: filters[i], alone, without });
    console.log(`  ${describe(filters[i]).padEnd(52)} alone ${String(show(alone)).padStart(6)}`
      + `   without ${String(show(without)).padStart(6)}`);
  }

  /*
   * THE VERDICT, and it refuses to name a culprit when there is not one.
   *
   * A filter is to blame when removing it turns nothing into something. If
   * removing any single filter still leaves nothing, no one rule is
   * responsible — the combination is what is rare, and saying otherwise would
   * send you to rewrite an innocent line.
   */
  console.log('');
  for (const line of verdictOf(all, rows)) console.log(line);
}

/*
 * Run as a script; required as a module by the tests. The verdict is the part
 * that can be wrong in a way nobody notices, so it is checked directly rather
 * than through a network call that cannot be made in a test.
 */
if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('Failed:', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { verdictOf, describe };
