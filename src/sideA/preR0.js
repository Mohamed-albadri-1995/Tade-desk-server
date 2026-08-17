/*
 * THE CHECKS TRADINGVIEW CANNOT DO, RUN BEFORE ANYTHING IS RECORDED.
 *
 * Two of them, and both belong to the unexplained-move screener: was there news
 * behind the move, and was the stock already trending before it. Neither is
 * expressible in a TradingView filter, and both are part of the DEFINITION of
 * the setup rather than a preference — so they run here, between the scanner
 * and the merge, and the names that fail are never recorded as candidates.
 *
 * THE NEWS TEST.
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
const { toETDate } = require('../utils/time');

/*
 * THE TREND TEST, AND WHY IT CANNOT BE A SCREENER FILTER.
 *
 * Every trend column TradingView offers ends at TODAY's price. A stock flat for
 * six months that spikes 30% this morning has `Perf.6M` of about +30% — the
 * move under examination lands inside the measure that is supposed to be
 * independent of it, and the setup disqualifies itself. Slower measures only
 * shrink the problem: one +30% day still moves EMA50 1.18% and EMA120 0.50%, so
 * a flat stock ends the day reading as rising by two thirds of a percent, which
 * is enough to fail a comparison between them.
 *
 * There is no "as of yesterday" in the scanner API, so the trend is read here
 * instead, from daily closes that STOP BEFORE THE MOVE. Six months of them,
 * first close against last, and the move is not in either.
 *
 * The band is a band for the reason a threshold at zero was wrong: "not clearly
 * rising" is not "flat". Inside +/-20% over six months a stock is drifting;
 * outside it, it is going somewhere and a move in that direction is not
 * unexplained.
 */
const CLEARLY_TRENDING_PCT = 20;
const TRADING_DAYS_6M = 126;

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
  // Spiked UP: worth fading only if it was not already climbing.
  'unexplained-move': { news: 'none', trend: 'not-up' },
  // Dropped: worth buying only if it was not already falling — a stock six
  // months into a decline that falls again has not done anything unexplained.
  'unexplained-move-mirror': { news: 'none', trend: 'not-down' },
};

function gateFor(key) {
  const g = GATES[String(key || '')];
  if (!g) return null;
  return MODES[g.news] ? g : null;
}

/**
 * The six-month move, from closes that end before today — or null when there
 * is not enough history to say.
 *
 * Demanding the full six months rather than measuring whatever is there: a
 * stock with two months of closes has no six-month trend, and computing one
 * from what exists would answer a different question under the same name.
 */
function trendPct(closes) {
  const c = (closes || []).map(b => Number(b.c)).filter(Number.isFinite);
  if (c.length < TRADING_DAYS_6M) return null;
  const first = c[c.length - TRADING_DAYS_6M];
  const last = c[c.length - 1];
  if (!(first > 0)) return null;
  return ((last - first) / first) * 100;
}

/** Does a six-month move pass a `not-up` / `not-down` rule? */
function trendPasses(rule, pct) {
  if (!rule || pct === null) return null;            // cannot tell
  if (rule === 'not-up') return pct <= CLEARLY_TRENDING_PCT;
  if (rule === 'not-down') return pct >= -CLEARLY_TRENDING_PCT;
  return null;
}

/**
 * Apply the gates to `candidates` — the scanner's output, keyed by screener
 * NAME — and return the same shape with the failing rows removed.
 *
 * `screeners` is the definition list, needed only to map a name back to its
 * key. A screener with no gate is passed through untouched and costs nothing.
 */
async function apply(candidates, screeners, {
  fetch = fetchNewsForTicker,
  closes = null,
  date = null,
} = {}) {
  const keyByName = new Map((screeners || []).map(s => [s.name, s.key]));
  const day = date || toETDate(Date.now());
  const out = {};
  const report = { checked: 0, dropped: 0, failed: 0, noHistory: 0, byScreener: {} };

  const getCloses = closes || (async (tickers) => {
    const { fetchClosesBefore } = require('../alpaca/client');
    return fetchClosesBefore(tickers, day);
  });

  for (const [name, rows] of Object.entries(candidates || {})) {
    const gate = gateFor(keyByName.get(name));
    if (!gate) { out[name] = rows; continue; }

    // One lookup per ticker, not per row: the same name can appear twice, and
    // a base and its mirror never overlap but a third gated screener could.
    const wanted = [...new Set(rows.map(r => r.ticker).filter(Boolean))];

    const news = new Map();
    await Promise.all(wanted.map(async (ticker) => {
      const row = rows.find(r => r.ticker === ticker);
      try {
        const { catalyst } = await fetch(ticker, row && row.stock && row.stock.tvSymbol);
        news.set(ticker, { ok: true, catalyst: catalyst || null });
      } catch (err) {
        news.set(ticker, { ok: false, catalyst: null, error: err.message });
      }
    }));

    // Six months of closes ENDING YESTERDAY — one request for every ticker.
    let bars = {};
    if (gate.trend) {
      try {
        bars = await getCloses(wanted) || {};
      } catch (err) {
        console.warn(`[pre-r0] could not read history: ${err.message}`);
        bars = {};
      }
    }

    const why = {};
    const kept = rows.filter((r) => {
      report.checked++;
      const n = news.get(r.ticker);
      /*
       * A FAILED LOOKUP DROPS THE STOCK, and this is the one place in the
       * pipeline where that is the right way round. Everywhere else a missing
       * value means "cannot tell" and the row survives, because losing a
       * candidate to a flaky API is worse than keeping a doubtful one. Here the
       * premise is "nothing explains this move" — and "we could not find out"
       * is not that.
       */
      if (!n || !n.ok) { report.failed++; report.dropped++; why[r.ticker] = 'news lookup failed'; return false; }
      const hasNews = !!n.catalyst;
      const newsPass = gate.news === 'none' ? !hasNews : hasNews;
      if (!newsPass) { report.dropped++; why[r.ticker] = hasNews ? 'has a catalyst' : 'no catalyst'; return false; }

      if (!gate.trend) return true;
      const pct = trendPct(bars[r.ticker]);
      const pass = trendPasses(gate.trend, pct);
      /*
       * NO HISTORY IS ALSO A DROP, for the same reason. A stock with two months
       * of closes has no six-month trend, so the safety layer cannot be applied
       * — and a candidate that skipped the safety layer is not the setup, it is
       * the setup minus the part that keeps you out of a falling knife.
       */
      if (pass === null) {
        report.noHistory++; report.dropped++;
        why[r.ticker] = 'not enough history for a six-month trend';
        return false;
      }
      if (!pass) {
        report.dropped++;
        why[r.ticker] = `already trending ${pct > 0 ? 'up' : 'down'} `
          + `${Math.abs(pct).toFixed(0)}% over six months`;
        return false;
      }
      // Carried onto the card: the trend is the reason this one qualified, and
      // it is not recoverable from anything else stored.
      r.stock = { ...(r.stock || {}), trend6mPct: Math.round(pct * 10) / 10 };
      return true;
    });

    report.byScreener[name] = { gate, in: rows.length, out: kept.length, why };
    out[name] = kept;
  }

  if (report.checked) {
    const detail = Object.entries(report.byScreener)
      .map(([n, r]) => `${n}: ${r.out}/${r.in}`).join('; ');
    console.log(`[pre-r0] ${detail}`
      + (report.failed ? ` — ${report.failed} on a failed news lookup` : '')
      + (report.noHistory ? ` — ${report.noHistory} without six months of history` : ''));
  }
  return { candidates: out, report };
}

module.exports = { apply, gateFor, GATES, MODES, trendPct, trendPasses,
                   CLEARLY_TRENDING_PCT, TRADING_DAYS_6M };
