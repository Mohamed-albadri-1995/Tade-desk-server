/*
 * CANSLIM membership, shared across tools.
 *
 * Every other list in this system is per-tool and stays that way. This one is
 * deliberately different: a CANSLIM name stays interesting for months, so when
 * one turns up in a completely unrelated screener that is worth knowing at the
 * moment it appears, not at the end of the month.
 *
 * The share is a single JSON file next to the databases. T8 writes it after
 * each of its scans; every other tool reads it and tags matching tickers. The
 * shape of that exchange matters:
 *
 *   - It is a LABEL, never a filter. No tool's results change because of it.
 *     Reading it cannot alter which stocks a screener returns.
 *   - It is one-way. Only T8 writes; a reader that cannot find or parse the
 *     file carries on with no tags rather than failing a scan.
 *
 * So the isolation that matters — one tool's data never deciding another
 * tool's candidates — is intact.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Next to the databases: same lifetime, same backup, obvious to find.
const FILE = process.env.CANSLIM_FILE
  || path.join(path.dirname(config.dbPath), 'canslim-members.json');

// "If it passes CANSLIM its candidates are valuable for at least 3 months."
// A name therefore stays a member for 90 days after it was last confirmed,
// rather than dropping off the day it stops printing a new high.
const MEMBER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.members ? raw : { members: {} };
  } catch {
    return { members: {} };            // absent or unreadable → simply no tags
  }
}

/**
 * Record today's CANSLIM matches. Called by T8 only.
 *
 * `firstSeen` is never moved: it is how long a name has held up, which is the
 * part worth knowing. `lastConfirmed` is what expiry counts from.
 */
function recordMembers(tickers, now = Date.now()) {
  const state = read();
  const members = state.members || {};
  for (const t of tickers) {
    const key = String(t).toUpperCase();
    if (members[key]) {
      members[key].lastConfirmed = now;
      members[key].confirmations = (members[key].confirmations || 1) + 1;
    } else {
      members[key] = { firstSeen: now, lastConfirmed: now, confirmations: 1 };
    }
  }

  // Drop names that have not qualified in three months.
  const cutoff = now - MEMBER_DAYS * DAY_MS;
  let expired = 0;
  for (const [key, m] of Object.entries(members)) {
    if ((m.lastConfirmed || 0) < cutoff) { delete members[key]; expired++; }
  }

  const out = { updatedAt: now, memberDays: MEMBER_DAYS, members };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    // Write-then-rename: a reader mid-scan never sees a half-written file.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn('[CANSLIM] could not write member list:', err.message);
  }
  return { total: Object.keys(members).length, expired };
}

/** Current members as a Map<TICKER, {firstSeen, lastConfirmed, confirmations}>. */
function currentMembers(now = Date.now()) {
  const cutoff = now - MEMBER_DAYS * DAY_MS;
  const out = new Map();
  for (const [key, m] of Object.entries(read().members || {})) {
    if ((m.lastConfirmed || 0) >= cutoff) out.set(key, m);
  }
  return out;
}

/**
 * Tag rows that are CANSLIM members. Mutates and returns the rows.
 *
 * `canslim` is a plain 'yes'/'no' string rather than a boolean because it
 * travels into the registers and the model as a categorical, alongside
 * catalyst and regime.
 */
function tagRows(rows, now = Date.now()) {
  const members = currentMembers(now);
  let tagged = 0;
  for (const row of rows) {
    const m = members.get(String(row.ticker || '').toUpperCase());
    if (m) {
      row.canslim = 'yes';
      row.canslimSince = m.firstSeen;
      row.canslimDays = Math.floor((now - m.firstSeen) / DAY_MS);
      tagged++;
    } else {
      row.canslim = 'no';
      row.canslimSince = null;
      row.canslimDays = null;
    }
  }
  return { rows, tagged, memberCount: members.size };
}

module.exports = {
  FILE, MEMBER_DAYS, recordMembers, currentMembers, tagRows, read,
};
