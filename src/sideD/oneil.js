/*
 * O'Neil's market model, read from the file qp writes.
 *
 * WHY IT IS A FILE AND NOT A COMPUTATION HERE.
 *
 * The market model is ONE fact about the market. Computing it inside each of
 * nine screener tools is nine chances to disagree, on nine different page
 * loads, against nine separate fetches of the same index bars — and the first
 * time T3 said "confirmed uptrend" while T7 said "under pressure" there would
 * be no way to tell which was wrong.
 *
 * So qp computes it once (quant-platform/chart/oneil.py) and publishes
 * data/oneil-market.json. qp is the writer because it already holds what this
 * needs and the nine tools do not: the index history, the parquet bar cache
 * and relstrength.py.
 *
 * The exchange follows the same rules as data/canslim-members.json, which is
 * the precedent in this system and the right one:
 *
 *   - It is a LABEL, never a filter. No tool's results change because of it.
 *     Reading it cannot alter which stocks a screener returns.
 *   - It is one-way. Only qp writes; a reader that cannot find or parse the
 *     file carries on with no market block rather than failing a scan.
 *   - It is written atomically on the qp side (temp file + rename), so a
 *     reader never sees half of one.
 *
 * WHY "LABEL, NEVER A FILTER" MATTERS MOST HERE. T1-T9 are nine independent
 * experiments whose backtests are compared against each other. The moment the
 * market state changes what a screener returns, every card captured before
 * that change measures a different thing and the comparison — the whole point
 * of running nine tools — is gone.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Next to the databases, exactly like canslim-members.json: same lifetime,
// same backup, obvious to find. qp resolves the same path from its own side.
const FILE = process.env.ONEIL_MARKET_FILE
  || path.join(path.dirname(config.dbPath), 'oneil-market.json');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.status ? raw : null;
  } catch {
    return null;                     // absent or unreadable → simply no block
  }
}

/**
 * What ONE stock did on the exact sessions the index was distributed.
 *
 * This is the whole reason the market model is worth putting on a card.
 * Stamping "uptrend under pressure" on a card gives 150 identical lines on a
 * register day, and a field with the same value on every row carries no
 * information about any row — it is a page header copied into the body.
 *
 * This number is different on every card and is computed from a market-level
 * fact: O'Neil's "leaders hold up during market pullbacks", made checkable.
 * A stock rising on the sessions the index was sold is being accumulated while
 * the market is being distributed, which is what a leader looks like before it
 * leads.
 *
 * `dailyByDate` maps 'YYYY-MM-DD' → that session's percent change for the
 * stock. The caller supplies it because only the caller knows where its bars
 * come from; this function owns the arithmetic and the wording, so all nine
 * tools say the same thing about the same numbers.
 */
function stockVsDistribution(dailyByDate, days) {
  const out = { checked: 0, held: 0, avgRel: null, verdict: null, dates: [], note: null };
  if (!Array.isArray(days) || !days.length) {
    // NOT "0 of 0", which reads as a failure. In a confirmed uptrend with no
    // live distribution days there is nothing to hold up through, and saying
    // so is the honest answer.
    out.note = 'no live distribution days — nothing to hold up through';
    return out;
  }
  if (!dailyByDate) {
    out.note = 'no daily bars for this stock';
    return out;
  }
  const rels = [];
  for (const d of days) {
    const stockPct = dailyByDate[d.date];
    if (stockPct == null || !Number.isFinite(stockPct)) continue;
    const rel = stockPct - (Number(d.pct) || 0);
    rels.push(rel);
    out.dates.push({
      date: d.date,
      index: d.index,
      stockPct: Math.round(stockPct * 100) / 100,
      indexPct: d.pct,
      rel: Math.round(rel * 100) / 100,
      held: rel > 0,
    });
  }
  out.checked = rels.length;
  if (!rels.length) {
    out.note = 'this stock has no bars on those sessions';
    return out;
  }
  out.held = rels.filter(r => r > 0).length;
  out.avgRel = Math.round((rels.reduce((a, b) => a + b, 0) / rels.length) * 100) / 100;
  const share = out.held / out.checked;
  out.verdict = (share >= 0.6 && out.avgRel > 0) ? 'HOLDING UP'
    : (share <= 0.4 || out.avgRel < 0) ? 'GIVING WAY'
      : 'IN LINE';
  return out;
}

// O'Neil's own action for each state. Printed as text because it is a RULE,
// not a measurement, and printed on the card because that is where the
// decision is being made.
const EXPOSURE = {
  confirmed_uptrend:
    'Buy breakouts. This is the state the method is designed for.',
  uptrend_under_pressure:
    'Stop initiating new positions; tighten stops on open ones. A name holding '
    + 'up through distribution is a leader candidate for the next follow-through.',
  market_in_correction:
    'No new buying. Three out of four stocks follow the market, and this one '
    + 'is going down.',
};

/**
 * How far into the uptrend we are. O'Neil buys EARLY in one — and this is also
 * where base-stage counting starts, because bases are counted from the market
 * bottom, not from wherever a chart happens to begin.
 */
function ftdBand(sessions) {
  if (sessions == null) return null;
  if (sessions < 25) return 'early';
  if (sessions <= 150) return 'established';
  return 'late';
}

module.exports = { read, stockVsDistribution, EXPOSURE, ftdBand, FILE };
