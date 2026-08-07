#!/usr/bin/env node
/*
 * Who is currently on the CANSLIM list, and how they got there.
 *
 * The list lives in one file beside the databases — data/canslim-members.json —
 * because it is the one thing in this system that is deliberately shared. Every
 * other list is per-tool and stays that way; this one is written by T8 and read
 * by all nine, so a growth name turning up in an unrelated screener is tagged
 * at the moment it appears rather than at the end of the month.
 *
 *   node scripts/show-canslim.js           who is on it
 *   node scripts/show-canslim.js --gone    who fell off, and when
 *   node scripts/show-canslim.js --rules   the joining and leaving rules
 *
 * Reads the file. Writes nothing, fetches nothing, needs no tool running.
 *
 * The two dates are different questions and both are worth seeing. "held" is
 * how long a name has been on the list since it first qualified — a company
 * that has been there ten weeks has held up through an earnings cycle. "last
 * seen" is what expiry counts from: a name drops off ninety days after it last
 * met the criteria, not ninety days after it joined.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.CANSLIM_FILE
  || path.join(__dirname, '..', 'data', 'canslim-members.json');
const MEMBER_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

const args = process.argv.slice(2);

if (args.includes('--rules')) {
  console.log(`
CANSLIM LIST — how a name gets on it, and how it comes off

  JOINING
    The "CANSLIM Universe" screener runs once a day, 09:30–09:45 ET, on T8.
    Every name it returns is added, or has its membership refreshed.

    Its six rules are all slow — none can be true today and false tomorrow:

      EPS growth, latest quarter      >= 25%
      EPS growth, last full year      >= 25%
      Revenue growth, latest quarter  >= 15%
      6-month performance             >  30%
      Shares outstanding              <  1,000,000,000
      Market cap                      >  $300,000,000

    The tradability floor does NOT apply to this screener. Membership is about
    the company, not about whether you could day-trade it today.

  STAYING
    ${MEMBER_DAYS} days from the last day it qualified — not from when it joined.
    A name that keeps passing keeps resetting its clock and never expires.
    A name that stops passing has ${MEMBER_DAYS} days of grace and then drops off.

  LEAVING
    Only by expiry. Nothing removes a name early, and a scan that returns
    nothing at all leaves the list untouched rather than wiping it — one
    skipped run must not expire everybody ninety days later.

  WHAT MEMBERSHIP DOES
    It is a LABEL and nothing else. Every tool tags its own cards
    "CANSLIM yes/no" from this list. No tool's results change because of it —
    reading the list cannot alter which stocks a screener returns.
`);
  process.exit(0);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (err) {
  console.log(`\nNo list yet at ${FILE}`);
  console.log('T8 writes it after its first scan in which the Universe screener runs');
  console.log('(09:30–09:45 ET, weekdays). Nothing is wrong if the market has not opened.\n');
  process.exit(0);
}

const members = state.members || {};
const now = Date.now();
const cutoff = now - MEMBER_DAYS * DAY;

const rows = Object.entries(members).map(([ticker, m]) => ({
  ticker,
  held: Math.floor((now - (m.firstSeen || now)) / DAY),
  lastSeen: Math.floor((now - (m.lastConfirmed || now)) / DAY),
  confirmations: m.confirmations || 1,
  expiresIn: Math.ceil(((m.lastConfirmed || 0) + MEMBER_DAYS * DAY - now) / DAY),
  live: (m.lastConfirmed || 0) >= cutoff,
}));

const live = rows.filter(r => r.live).sort((a, b) => b.held - a.held);
const gone = rows.filter(r => !r.live).sort((a, b) => a.lastSeen - b.lastSeen);

const updated = state.updatedAt
  ? `${Math.floor((now - state.updatedAt) / (60 * 1000))} min ago`
  : 'unknown';

console.log(`\nCANSLIM LIST — ${live.length} member(s), updated ${updated}`);
console.log(`${FILE}\n`);

if (!live.length) {
  console.log('  Nobody on the list.');
  console.log('  Expected before T8 has run its Universe screener, or if no stock');
  console.log('  currently meets all six criteria — which is a real answer, not a fault.\n');
} else {
  console.log('  TICKER    held   last seen   times confirmed   drops off in');
  for (const r of live) {
    console.log(`  ${r.ticker.padEnd(8)} ${String(r.held).padStart(4)}d`
      + `   ${(r.lastSeen === 0 ? 'today' : `${r.lastSeen}d ago`).padStart(9)}`
      + `   ${String(r.confirmations).padStart(15)}`
      + `   ${String(r.expiresIn).padStart(9)}d`);
  }
  console.log('');
  // The one that is about to go is the one worth knowing about, because it is
  // the one whose tag will silently change on every other tool's cards.
  const soon = live.filter(r => r.expiresIn <= 14).sort((a, b) => a.expiresIn - b.expiresIn);
  if (soon.length) {
    console.log(`  Expiring within two weeks: ${soon.map(r => `${r.ticker} (${r.expiresIn}d)`).join(', ')}`);
    console.log('  Their CANSLIM tag will turn to "no" on every tool when they go.\n');
  }
}

if (args.includes('--gone')) {
  console.log(`  ── expired (still in the file, no longer counted) ──`);
  if (!gone.length) console.log('  none\n');
  else {
    for (const r of gone) {
      console.log(`  ${r.ticker.padEnd(8)} last qualified ${r.lastSeen}d ago, held ${r.held}d`);
    }
    console.log('');
  }
} else if (gone.length) {
  console.log(`  ${gone.length} expired entr(ies) also in the file — --gone to see them\n`);
}

console.log('  --rules  for how a name joins, stays and leaves\n');
