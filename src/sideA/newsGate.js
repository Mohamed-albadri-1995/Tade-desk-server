/*
 * THE NEWS TEST, RUN BEFORE ANYTHING IS RECORDED.
 *
 * The unexplained-move screener asks TradingView for stocks that went 15% in
 * two hours. TradingView has no news column, so what comes back is every 15%
 * mover — and most of those moved because something happened. The setup is the
 * ones where nothing did.
 *
 * WHY THIS CANNOT BE A CARD FILTER. A filter on the setup runs after the scan,
 * which means the whole unfiltered list has already been written to r0, frozen
 * into R1 the next morning, and fed to the model as training data. Asked for
 * plainly: the full list must not reach r0 or any other part of the warehouse.
 * So the test runs here — between the scanner and the merge — and the names
 * that fail it are never recorded as candidates at all.
 *
 * The cost is one news lookup per candidate of a gated screener, before r0.
 * That is affordable precisely because the gate is on a narrow screener: a
 * handful of names a day, not the whole scan. Applying it to a broad screener
 * would be a different decision with a different bill.
 *
 * A LOOKUP THAT FAILS DROPS THE STOCK, and this is the one place in the
 * pipeline where that is the right way round. Everywhere else a missing value
 * means "cannot tell" and the row survives, because losing a candidate to a
 * flaky API is worse than keeping a doubtful one. Here the whole premise is
 * "nothing explains this move" — and "we could not find out" is not that. A
 * name kept on a failed lookup is a name whose news nobody checked, entering a
 * screener that exists to find names with no news.
 */

const { fetchNewsForTicker } = require('../sideC/news');

/** What a gated screener requires of its candidates. */
const MODES = {
  // Keep only the names with NO catalyst — the unexplained ones.
  none: 'no news behind the move',
  // Keep only the names that HAVE one — a break with something behind it.
  any: 'a catalyst behind the move',
};

/*
 * Which screeners are gated, and how. Keyed by screener key, so it travels
 * with the definition rather than matching a name that a rename would break.
 *
 * `20d-break` is deliberately NOT here. Its news requirement is a preference —
 * a break with a catalyst is a better break — and a preference belongs in a
 * card filter on the setup, where it can be changed per setup and where the
 * names it removes are still recorded. Only a screener whose PREMISE is the
 * news test belongs in this file, because only that one is worth paying a
 * lookup per candidate for and worth keeping out of the archive.
 */
const GATES = {
  'unexplained-move': 'none',
  'unexplained-move-mirror': 'none',
};

function gateFor(key) {
  const mode = GATES[String(key || '')];
  return MODES[mode] ? mode : null;
}

/**
 * Apply the gates to `candidates` — the scanner's output, keyed by screener
 * NAME — and return the same shape with the failing rows removed.
 *
 * `screeners` is the definition list, needed only to map a name back to its
 * key. A screener with no gate is passed through untouched and costs nothing.
 */
async function apply(candidates, screeners, { fetch = fetchNewsForTicker } = {}) {
  const keyByName = new Map((screeners || []).map(s => [s.name, s.key]));
  const out = {};
  const report = { checked: 0, dropped: 0, failed: 0, byScreener: {} };

  for (const [name, rows] of Object.entries(candidates || {})) {
    const mode = gateFor(keyByName.get(name));
    if (!mode) { out[name] = rows; continue; }

    // One lookup per ticker, not per (ticker, screener): a base and its mirror
    // never overlap, but a future third gated screener could.
    const answers = new Map();
    const wanted = [...new Set(rows.map(r => r.ticker).filter(Boolean))];
    await Promise.all(wanted.map(async (ticker) => {
      const row = rows.find(r => r.ticker === ticker);
      try {
        const { catalyst } = await fetch(ticker, row && row.stock && row.stock.tvSymbol);
        answers.set(ticker, { ok: true, catalyst: catalyst || null });
      } catch (err) {
        answers.set(ticker, { ok: false, catalyst: null, error: err.message });
      }
    }));

    const kept = rows.filter((r) => {
      const a = answers.get(r.ticker);
      report.checked++;
      if (!a || !a.ok) { report.failed++; report.dropped++; return false; }
      const has = !!a.catalyst;
      const pass = mode === 'none' ? !has : has;
      if (!pass) report.dropped++;
      return pass;
    });

    report.byScreener[name] = { mode, in: rows.length, out: kept.length };
    out[name] = kept;
  }

  if (report.checked) {
    const detail = Object.entries(report.byScreener)
      .map(([n, r]) => `${n}: ${r.out}/${r.in} (${MODES[r.mode]})`).join('; ');
    console.log(`[News gate] ${detail}`
      + (report.failed ? ` — ${report.failed} dropped on a failed lookup` : ''));
  }
  return { candidates: out, report };
}

module.exports = { apply, gateFor, GATES, MODES };
