/*
 * The L in CAN SLIM, read from the file qp writes.
 *
 * Same contract as sideD/oneil.js and canslim-members.json: qp computes it
 * once against the whole-market RS it already holds, publishes
 * data/oneil-groups.json atomically, and the nine tools read it. A label,
 * never a filter — no screener's results change because of it.
 *
 * WHY qp AND NOT HERE. A group rank is a ranking of ONE universe. Computing it
 * nine times, in nine processes, against nine separate fetches, is nine
 * chances to disagree — and the first time T3 says "rank 12 of 180" while T7
 * says "rank 40 of 176" there is no way to tell which is wrong.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = process.env.ONEIL_GROUPS_FILE
  || path.join(path.dirname(config.dbPath), 'oneil-groups.json');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (raw && typeof raw === 'object' && raw.stocks) ? raw : null;
  } catch {
    return null;                      // absent or unreadable → simply no block
  }
}

/**
 * The A+ … E band of a 1-99 percentile.
 *
 * OURS, evenly spaced, and stated as ours — each letter owns 20 points of the
 * scale, split in thirds. IBD does not publish its boundaries, and an earlier
 * version of this picked cut-points to make one screenshot come out right and
 * did not even manage that. A letter that looked like IBD's and was not would
 * be the same trap as calling a reconstruction "IBD RS".
 *
 * Duplicated from chart/groups.py on purpose and asserted against it by the
 * audit: two implementations of one band table that drifted would show the
 * page disagreeing with itself about a single number.
 */
const LETTER_BANDS = [[94, 'A+'], [87, 'A'], [80, 'A-'],
                      [74, 'B+'], [67, 'B'], [60, 'B-'],
                      [54, 'C+'], [47, 'C'], [40, 'C-'],
                      [34, 'D+'], [27, 'D'], [20, 'D-']];

function letter(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  for (const [cut, lab] of LETTER_BANDS) if (pct >= cut) return lab;
  return 'E';
}

/**
 * rank 63 of 197 → the 68th percentile.
 *
 * The direction reverses, which is the whole reason this is a named function
 * rather than an expression: a RANK counts up from best, a PERCENTILE counts
 * down. A bare "68" is excellent as one and mediocre as the other, which is
 * why nothing in this system prints a rank without its divisor.
 */
function rankToPct(rank, total) {
  if (!total || rank == null) return null;
  // 1 - rank/total, checked against MarketSmith: rank 63 of 197 prints as 68.
  // Clipped to 1..99 like every other rating here. Must stay identical to
  // chart/groups.py — the audit asserts both sides.
  return Math.max(1, Math.min(99, Math.round((1 - rank / total) * 100)));
}

/** What one card needs. Missing is null — the card renders without the line. */
function forSymbol(model, ticker) {
  if (!model || !model.stocks) return null;
  return model.stocks[String(ticker).toUpperCase()] || null;
}

/** The group row itself, for the leaders list and the rotation. */
function group(model, name) {
  if (!model || !Array.isArray(model.groups)) return null;
  return model.groups.find(g => g.group === name) || null;
}

module.exports = { read, letter, rankToPct, forSymbol, group, FILE };
