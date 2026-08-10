/*
 * What a tool actually screens for, in words, from the live definitions.
 *
 * The landing page used to describe each tool with a sentence typed into
 * tools.config.json — "Daily moving averages stacked fast-over-slow, breaking
 * the monthly high." That sentence was written once and then never again, while
 * the screeners underneath it are edited from the Screeners tab whenever a rule
 * turns out to be wrong. The two drift apart silently, and the card ends up
 * describing a tool that no longer exists. A description nobody can trust is
 * worse than none, because it is still read.
 *
 * So the description is generated from the same rows the scanner runs. Change a
 * threshold in the builder and the landing page says the new number on its next
 * probe, because there is nothing else for it to say.
 *
 * The labels come from screenerStore.FIELDS and OPERATIONS — the lists the
 * validator itself uses — so a rule can never be described in terms the API
 * would have rejected.
 *
 * Two different clocks are reported, and they are not the same question:
 *
 *   runFrom/runTo   when the screener SCANS. Outside it, it looks for nothing.
 *   checkFrom/checkTo  when it is worth OPENING. A pre-market gap screener
 *                      scans from 04:00 and has nothing to show until there is
 *                      volume behind the gap.
 */

const store = require('./screenerStore');

// TradingView appends a timeframe to a column with "|": EMA9|1 is the daily
// EMA9, close|1W the weekly close. Spelled out so a rule reads as a sentence.
const TIMEFRAME = {
  1: 'daily', '1W': 'weekly', '1M': 'monthly', 5: '5m', 15: '15m',
  30: '30m', 60: '1h', 120: '2h', 240: '4h',
};

function fieldLabel(value) {
  const [base, tf] = String(value).split('|');
  // An exact match already carries its timeframe in the label it was given —
  // "Relative volume (5m)" is the whole name of that column. Appending the
  // suffix again produces "Relative volume (5m) (5m)".
  const exact = store.FIELDS.find(f => f.value === value);
  if (exact) return exact.label;
  const found = store.FIELDS.find(f => f.value === base);
  const label = found ? found.label : base;
  return tf ? `${label} (${TIMEFRAME[tf] || tf})` : label;
}

function opLabel(value) {
  const found = store.OPERATIONS.find(o => o.value === value);
  return found ? found.label : value;
}

/**
 * Volume thresholds are written in full — 2000000, 1500000 — and counting
 * zeroes is not reading. Only above ten thousand, so a price of 2 or an RVOL of
 * 1.5 is left exactly as it was typed.
 */
function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) < 10000) return String(v);
  const [div, suffix] = Math.abs(n) >= 1e9 ? [1e9, 'B']
    : Math.abs(n) >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  const scaled = n / div;
  // 2M, not 2.0M; 1.5M, not 1.500000000000002M.
  return `${Number(scaled.toFixed(2))}${suffix}`;
}

/**
 * One filter as a sentence: "Price (close) above SMA 20".
 *
 * The right-hand side is either a number, a range, or the name of another
 * column — "above 20" and "above SMA 20" are different rules and printing the
 * second as a bare string would read as a typo.
 */
function ruleText(filter) {
  if (!filter || filter.left == null) return '';
  const rightIsField = typeof filter.right === 'string' && filter.right !== ''
    && Number.isNaN(Number(filter.right));
  const right = Array.isArray(filter.right)
    ? filter.right.map(num).join(' … ')
    : (rightIsField ? fieldLabel(filter.right) : num(filter.right));
  return `${fieldLabel(filter.left)} ${opLabel(filter.operation)} ${right}`;
}

/**
 * Every enabled screener, described.
 *
 * Enabled only: a disabled screener finds nothing, and listing it would say the
 * tool looks for something it does not. Label-only screeners are marked rather
 * than hidden — CANSLIM's universe decides who is a growth company and never
 * proposes a trade, so calling it a screener without saying so would overstate
 * what the tool is doing.
 */
function screeners() {
  return store.list({ enabledOnly: true }).map(s => ({
    name: s.name,
    labelOnly: !!s.labelOnly,
    mirrorOf: s.mirrorOf || null,
    // Left null when the screener has no window, rather than filled in with the
    // outer bounds of the day. "scans 04:00–20:00" reads as a decision someone
    // made; no window at all means the screener runs on every scan, and those
    // are different facts about the tool.
    runFrom: s.runFrom || null,
    runTo: s.runTo || null,
    checkFrom: s.checkFrom || s.runFrom || '04:00',
    checkTo: s.checkTo || s.runTo || '16:00',
    limit: s.limit,
    rules: (s.filters || []).map(ruleText).filter(Boolean),
  }));
}

/**
 * The whole picture for one tool, for the landing page.
 *
 * The floor is separate from any screener's own rules because it is appended to
 * all of them at scan time — a stock below it is never collected by anything,
 * so listing it once as a shared condition is what it actually is. Label-only
 * screeners are exempt, which is why they carry the flag.
 */
function summarise() {
  const tradable = require('./tradable');
  const list = screeners();
  const window = store.checkWindow(store.list({ enabledOnly: true }));
  return {
    screeners: list,
    // How often the tool looks, which is a property of the schedule rather than
    // of any screener. Stated in words because the cron behind it ("*/30 4-8")
    // is not something to make a reader parse.
    cadence: [
      { when: '04:00–09:00', every: 'every 30 min' },
      { when: '09:00–10:00', every: 'every 5 min' },
      { when: '10:00–16:00', every: 'every 15 min' },
    ],
    floor: tradable.describe(tradable.thresholds()),
    check: window ? { from: window.from, to: window.to } : null,
  };
}

module.exports = { summarise, screeners, ruleText, fieldLabel, opLabel };
