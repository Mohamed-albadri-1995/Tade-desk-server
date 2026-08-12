#!/usr/bin/env bash
#
# What the setups decided, on one screen, for a day you can paste to someone.
#
# The record already exists: every fire is appended to
# data/history/alert-history-<month>.jsonl and nothing is ever trimmed. The
# alerts page shows it, one row at a time, on a phone. This is the other thing
# a review week needs — the whole morning as text, small enough to paste into a
# message and read without scrolling.
#
#     bash scripts/setup-journal.sh              # today
#     bash scripts/setup-journal.sh 2026-08-13   # a specific session
#     bash scripts/setup-journal.sh --week       # the last 7 sessions, summary
#
# ALERT-ONLY WEEKS: the ORDER column should be empty on every line. If it is
# not, something placed a real order and that is the first thing to look at,
# ahead of whether the picks were any good.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

node - "$REPO" "${1:-}" <<'JS'
const fs = require('fs');
const path = require('path');
const [repo, arg] = process.argv.slice(2);
const dir = path.join(repo, 'data', 'history');

const et = (ms) => new Date(ms).toLocaleString('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const etDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function readAll() {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line is one line */ }
    }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

const all = readAll();
if (!all.length) {
  console.log('Nothing recorded yet. The record starts at the first fire after '
    + 'the alerts app was deployed — it cannot recover days never kept.');
  process.exit(0);
}

const days = [...new Set(all.map(f => etDate(f.at)))].sort();
const n = (v, d = 2) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(d));

if (arg === '--week') {
  console.log('session     signals  setups fired                     orders');
  console.log('----------  -------  -------------------------------  ------');
  for (const d of days.slice(-7)) {
    const f = all.filter(x => etDate(x.at) === d);
    const setups = [...new Set(f.filter(x => x.setup).map(x => x.rule || '?'))];
    const orders = f.filter(x => x.setup && x.setup.order).length;
    console.log(`${d}  ${String(f.length).padStart(7)}  `
      + `${setups.join(', ').slice(0, 31).padEnd(31)}  `
      + `${orders ? String(orders) + ' ← REAL' : '0'}`);
  }
  console.log('\nORDER count must be 0 during an alert-only week.');
  process.exit(0);
}

const want = arg || days[days.length - 1];
const fires = all.filter(f => etDate(f.at) === want);
if (!fires.length) {
  console.log(`Nothing recorded for ${want}. Sessions on record: ${days.join(', ')}`);
  process.exit(0);
}

/*
 * COLLAPSE REPEATS.
 *
 * A setup that is re-run — a manual fire, a restart, a preview — records the
 * same decision again, and "Nothing qualified" records it every time. A real
 * morning is six to twelve lines; a day of testing was 248, and 51KB of text
 * cannot be pasted into a message, which is the whole point of this script.
 *
 * Identical (ticker, rule, detail) records collapse to one line with a count.
 * Collapsed, never dropped: the count is itself worth seeing, because a
 * decision recorded nine times means the setup ran nine times.
 */
const key = (f) => `${f.ticker || ''}|${f.rule || ''}|${f.detail || ''}`;
const rolled = [];
for (const f of fires) {
  const last = rolled[rolled.length - 1];
  if (last && key(last.f) === key(f)) { last.n += 1; continue; }
  rolled.push({ f, n: 1 });
}

const CAP = 60;
const shown = rolled.slice(0, CAP);
console.log(`SESSION ${want}   (${fires.length} record${fires.length === 1 ? '' : 's'}`
  + `${rolled.length !== fires.length ? `, ${rolled.length} distinct` : ''})`);
// `times`, not `n` — `n` is the number formatter three lines above, and
// destructuring over it turned every price into "n is not a function".
for (const { f, n: times } of shown) {
  const t = f.setup;
  console.log('');
  console.log(`${et(f.at)} ET  ${f.ticker || '—'}  ${f.toolId || ''}  ${f.rule || ''}`
    + (times > 1 ? `   (recorded ${times}x)` : ''));
  if (f.detail) console.log(`   ${f.detail}`);
  if (!t) continue;
  const bits = [];
  if (t.entry != null) bits.push(`entry ${n(t.entry)}`);
  if (t.stop != null) bits.push(`stop ${n(t.stop)}`);
  if (t.target != null) bits.push(`target ${n(t.target)}`);
  if (t.risk != null) bits.push(`risk/sh ${n(t.risk)}`);
  if (t.size && t.size.shares != null) bits.push(`${t.size.shares} sh`);
  if (t.size && t.size.positionValue != null) bits.push(`$${n(t.size.positionValue, 0)}`);
  if (t.size && t.size.riskDollars != null) bits.push(`risking $${n(t.size.riskDollars)}`);
  if (bits.length) console.log(`   ${bits.join(' · ')}`);
  const more = [];
  if (t.extension != null) more.push(`extension ${n(t.extension)}%`);
  if (t.decisionAt) more.push(`bar ${t.decisionAt}`);
  if (t.exitPlan && t.exitPlan.shape) more.push(`exit ${t.exitPlan.shape}`);
  if (t.source) more.push(`feed ${t.source}`);
  if (t.riskFrom) more.push(`risk from ${t.riskFrom}`);
  if (more.length) console.log(`   ${more.join(' · ')}`);
  if (t.size && t.size.capped) console.log(`   CAPPED: ${t.size.capped}`);
  if (t.feedWarning) console.log(`   WARNING: ${t.feedWarning}`);
  // The line that matters most during an alert-only week.
  if (t.order) {
    console.log(`   *** REAL ORDER: ${JSON.stringify(t.order)}`);
  }
}

const withOrders = fires.filter(f => f.setup && f.setup.order).length;
console.log('');
if (rolled.length > CAP) {
  console.log(`(${rolled.length - CAP} more distinct records not shown — `
    + `pass a date to narrow, or read data/history/ directly)`);
}
console.log(withOrders
  ? `*** ${withOrders} of these placed a REAL ORDER.`
  : 'No real orders — alert only, as intended.');
console.log(`Sessions on record: ${days.join(', ')}`);
JS
