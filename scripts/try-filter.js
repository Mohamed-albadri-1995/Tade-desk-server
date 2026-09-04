#!/usr/bin/env node
/*
 * WHAT WOULD FIX THIS FILTER — measured, not argued.
 *
 * why-empty.js names the rule that empties a screener. That is where the
 * useful part starts and where, on 2026-09-04, I stopped: I said
 * `close ≥ price_52_week_high` was impossible and proposed "within 1–2% of the
 * high" WITHOUT TESTING EITHER THE DIAGNOSIS OR THE CURE. The trader was right
 * to push back. TradingView cannot even express "within 2%" — there is no
 * column-times-a-constant in its filter language — so the proposal was not just
 * untested, it was unbuildable.
 *
 * So this takes the rule apart and asks TradingView about each alternative:
 *
 *     alone     how many stocks pass this ONE rule, over the tradability floor
 *     in full   how many the whole screener returns with this rule in place of
 *               the current one
 *
 * `in full` is the number that decides anything. A candidate that matches four
 * hundred stocks alone and still leaves the screener empty has not fixed it.
 *
 * THE ONE THAT MATTERS FOR A BREAKOUT, and the reason this exists:
 *
 *     close ≥ price_52_week_high   closed at the very top of its year — a stock
 *                                  that prints a new high at 10:00 and closes a
 *                                  cent below it FAILS. Near-zero, every day.
 *     high  ≥ price_52_week_high   PRINTED a new 52-week high today, which is
 *                                  what "breakout" means in every book.
 *
 * Those are one word apart and they are different screeners. Which is right is
 * the trader's call; what this does is put the counts next to both.
 *
 * IT WRITES NOTHING. It reads the definition and asks TradingView. Nothing is
 * saved, and the screener is not modified — the winning rule is applied by hand
 * afterwards, or by asking for it.
 *
 *   node scripts/try-filter.js canslim 4
 *   DB_PATH=data/t10.db node scripts/try-filter.js canslim 4
 *   DB_PATH=data/t10.db node scripts/try-filter.js canslim 4 "high>=price_52_week_high"
 */

const path = require('path');

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tradedesk.db');

const store = require('../src/sideA/screenerStore');
const { testScreener } = require('../src/sideA/tvScanner');
const { describe: describeFilter } = require('./why-empty');

/*
 * WHAT TO TRY, BY THE SHAPE OF THE RULE.
 *
 * Only rules TradingView can actually evaluate. Every candidate here is a
 * column-vs-column or column-vs-number comparison, because that is the whole
 * of its filter language — see the note in src/sideA/tradable.js about there
 * being no way to compare a column against another column times a constant.
 */
const HIGH_LADDER = ['price_52_week_high', 'High.3M', 'High.1M'];
const LOW_LADDER = ['price_52_week_low', 'Low.3M', 'Low.1M'];

/** Sensible alternatives for one filter. Never includes the rule itself. */
function candidatesFor(f) {
  const out = [];
  const add = (left, operation, right, why) => {
    if (left === f.left && operation === f.operation && right === f.right) return;
    if (out.some(c => c.left === left && c.operation === operation && c.right === right)) return;
    out.push({ left, operation, right, why });
  };

  const right = f.right;
  const isColumn = typeof right === 'string' && Number.isNaN(Number(right));

  const ladder = HIGH_LADDER.includes(right) ? HIGH_LADDER
    : LOW_LADDER.includes(right) ? LOW_LADDER : null;

  if (isColumn) {
    /*
     * THE ONE-WORD DIFFERENCE. `close ≥ <a high>` asks the stock to CLOSE at
     * the top of that window; `high ≥ <a high>` asks it to have TRADED there
     * today. For a breakout the second is what the phrase means, and it is the
     * candidate that was never tried.
     */
    /*
     * THE TOUCH VERSION USES THE MATCHING EXTREME. A breakout asks whether the
     * DAY'S HIGH reached the high; a breakdown asks whether the day's LOW
     * reached the low. Taking the high for both would offer, for a 52-week low
     * rule, "did today's high get down to the yearly low" — a question about
     * nothing.
     */
    const touch = ladder === LOW_LADDER ? 'low' : 'high';
    if (f.left === 'close') {
      add(touch, f.operation, right,
        `did it PRINT that ${touch === 'low' ? 'low' : 'high'} today, `
        + 'rather than close at it');
    }
    if (ladder) {
      // …and the same question over a shorter window, which is a different
      // strategy rather than a looser one — said plainly, not slipped in.
      for (const alt of ladder) {
        if (alt === right) continue;
        add(f.left, f.operation, alt, `the same rule over a ${alt} window`);
        if (f.left === 'close') {
          add(touch, f.operation, alt, `printed the ${alt} level today`);
        }
      }
    }
    return out;
  }

  const n = Number(right);
  if (!Number.isFinite(n) || n === 0) return out;
  /*
   * A NUMERIC THRESHOLD, RELAXED IN THE DIRECTION THAT ADMITS MORE STOCKS.
   * `>` and `≥` relax downward, `<` and `≤` upward. Three steps, so the shape
   * of the curve is visible: a rule that only works at a tenth of its value is
   * a different rule, and seeing that is the point.
   */
  const up = ['less', 'eless'].includes(f.operation);
  for (const frac of [0.75, 0.5, 0.25]) {
    const v = up ? n / frac : n * frac;
    const rounded = Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 100) / 100;
    add(f.left, f.operation, rounded, `${Math.round(frac * 100)}% of the current threshold`);
  }
  return out;
}

/** Parse `left>=right` / `left > 25` from the command line. */
function parseRule(text) {
  const m = /^\s*([A-Za-z0-9_.|]+)\s*(>=|<=|>|<|=)\s*(.+?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const op = { '>=': 'egreater', '<=': 'eless', '>': 'greater', '<': 'less', '=': 'equal' }[m[2]];
  const raw = m[3];
  const n = Number(raw);
  return { left: m[1], operation: op, right: Number.isFinite(n) && raw !== '' ? n : raw,
           why: 'yours' };
}

async function count(def) {
  try {
    const r = await testScreener(def);
    // THE TOTAL, NOT THE PAGE — see why-empty.js. The row count saturates at
    // the limit and stops measuring anything.
    return { n: Number.isFinite(r.totalCount) ? r.totalCount : r.count, error: null };
  } catch (err) {
    // A REFUSAL IS NOT A ZERO. A column TradingView does not know comes back as
    // an error, and printing it as "0 matched" would condemn a rule for the
    // network's sake.
    return { n: null, error: err.message };
  }
}

const show = (c) => (c.error ? `ERROR: ${c.error}` : String(c.n));

async function main() {
  const [key, nth, ...rest] = process.argv.slice(2);
  const screener = key ? store.list().find(s => s.key === key) : null;
  if (!screener) {
    console.error('Usage: node scripts/try-filter.js <screener-key> <filter-number> [rule…]');
    console.error('       (DB_PATH=data/t10.db to pick a tool; the filter number is the '
      + 'row from why-empty.js, counting from 1)');
    console.error('\nScreeners in this database:');
    for (const s of store.list()) console.error(`  ${s.key.padEnd(22)} ${s.name}`);
    process.exit(1);
  }
  const filters = screener.filters || [];
  const idx = Number(nth) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= filters.length) {
    console.error(`${screener.name} has ${filters.length} filter(s):`);
    filters.forEach((f, i) => console.error(`  ${i + 1}. ${describeFilter(f)}`));
    process.exit(1);
  }

  const current = filters[idx];
  const base = { name: screener.name, sort: screener.sort, limit: 100 };
  const others = filters.filter((_, i) => i !== idx);

  console.log(`\n${screener.name}  (${screener.key})   ${process.env.DB_PATH}`);
  console.log(`Filter ${idx + 1}:  ${describeFilter(current)}\n`);
  console.log('  ALONE = how many stocks pass that ONE rule, over the tradability floor');
  console.log('  IN FULL = what the whole screener returns with that rule in its place');
  console.log('  (counts are how many MATCHED, from TradingView\'s own total)\n');

  const asIs = await count({ ...base, filters });
  const withoutIt = await count({ ...base, filters: others });
  console.log(`  the screener as written ................ ${show(asIs)}`);
  console.log(`  without this filter at all ............. ${show(withoutIt)}\n`);

  const tried = [{ ...current, why: 'as written now' },
    ...(rest.length ? rest.map(parseRule).filter(Boolean) : candidatesFor(current))];

  const rows = [];
  for (const c of tried) {
    const alone = await count({ ...base, filters: [c] });
    const full = await count({ ...base, filters: [...others.slice(0, idx), c, ...others.slice(idx)] });
    rows.push({ c, alone, full });
    console.log(`  ${describeFilter(c).padEnd(40)} alone ${show(alone).padStart(6)}`
      + `   in full ${show(full).padStart(6)}   ${c.why || ''}`);
  }

  /*
   * THE VERDICT, and it will not recommend a rule it has not seen work. A
   * candidate is only an answer if the SCREENER returns something with it in
   * place — matching stocks alone proves the rule is expressible, not that it
   * fixes anything.
   */
  console.log('');
  const better = rows.filter(r => r.c !== current && r.full.n > 0 && r.full.n > (asIs.n || 0))
    .sort((a, b) => a.full.n - b.full.n);
  if (asIs.n > 0) {
    console.log(`VERDICT: the screener already returns ${asIs.n} — this filter is not `
      + 'what is emptying it.');
  } else if (!better.length) {
    console.log('VERDICT: none of these makes the screener return anything, so this rule '
      + 'is not the only thing stopping it.');
    console.log('  Run why-empty.js again: when every leave-one-out is also zero, it is '
      + 'the COMBINATION that is rare, and one rule cannot fix that.');
  } else {
    const pick = better[0];
    console.log(`VERDICT: ${describeFilter(pick.c)}`);
    console.log(`  The screener returns ${pick.full.n} with it, none as written.`);
    console.log(`  ${pick.c.why}.`);
    if (better.length > 1) {
      console.log(`  ${better.length - 1} other candidate(s) also work — the tightest is `
        + 'listed first, since a screener that returns four hundred names is not a screener.');
    }
    console.log('  Nothing has been changed. Edit the rule in the Screeners tab, or ask.');
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('Failed:', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { candidatesFor, parseRule, HIGH_LADDER, LOW_LADDER };
