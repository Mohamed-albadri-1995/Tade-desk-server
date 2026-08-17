/*
 * The tradability floor.
 *
 * Some things are not a strategy, they are a precondition. A stock that trades
 * under a million shares a day, or whose average range is under a dollar, or
 * under 3% of its own price, cannot be traded the way this desk trades
 * regardless of what any screener thinks of it — you cannot get filled, or
 * there is no room in the move to pay for the risk.
 *
 * So it lives here rather than being copied into every screener's filter list.
 * Copying would mean six tools' worth of screeners to edit whenever the floor
 * moves, a new screener silently exempt until someone remembered, and no single
 * place to read what the floor even is.
 *
 * Thresholds are settings, so raising the bar is a form field rather than a
 * deploy.
 */

const db = require('./../db');

const DEFAULTS = {
  minPrice: 1,             // dollars — below this the spread eats the trade
  minAvgVolume: 1000000,   // shares/day, 10-day average — can you get out?
  minAtr: 1,               // dollars, ADR/ATR(14) — is there room to pay for risk?
  minAtrPct: 3,            // ADR as % of price — room relative to the stock
};

function num(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    // Number('') is 0, so a blank setting would read as "leg switched off" and
    // quietly let untradable stocks through. Only a real number counts; zero
    // still means off, but only when someone typed it.
    const raw = row ? String(row.value).trim() : '';
    if (raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function thresholds() {
  return {
    minPrice: num('minPrice', DEFAULTS.minPrice),
    minAvgVolume: num('minAvgVolume', DEFAULTS.minAvgVolume),
    minAtr: num('minAtr', DEFAULTS.minAtr),
    minAtrPct: num('minAtrPct', DEFAULTS.minAtrPct),
  };
}

/**
 * The part TradingView can enforce, appended to every screener's filters.
 *
 * Pushed to the server rather than applied here because a screener asks for the
 * top N by its sort: filtering afterwards would spend those N slots on stocks
 * that were never eligible and hand back a short list.
 */
/*
 * `liquidity: false` drops the two legs that ask "could you get out of this" —
 * average volume and ATR in dollars — and keeps the price floor.
 *
 * For ONE screener, and it is not an oversight. The unexplained-move screener
 * hunts NEGLECTED names: a stock nobody trades is exactly the population where
 * a 15% move happens for no reason and then reverses, because there was nobody
 * there to move it in the first place. Requiring a million shares a day removes
 * the setup along with the risk, so the risk is accepted deliberately and said
 * out loud on the card rather than screened away.
 *
 * The PRICE floor stays either way: a spread on a $0.30 stock eats the whole
 * move, which is not a liquidity opinion, it is arithmetic.
 */
function serverFilters(t = thresholds(), { liquidity = true } = {}) {
  const out = [];
  // Price first: it is the cheapest rule to evaluate and the one that removes
  // the most stocks nobody here would trade at any volume.
  if (t.minPrice > 0) {
    out.push({ left: 'close', operation: 'egreater', right: t.minPrice });
  }
  if (liquidity && t.minAvgVolume > 0) {
    out.push({ left: 'average_volume_10d_calc', operation: 'egreater', right: t.minAvgVolume });
  }
  if (liquidity && t.minAtr > 0) {
    out.push({ left: 'ATR', operation: 'egreater', right: t.minAtr });
  }
  return out;
}

/**
 * The part TradingView cannot express: ATR as a percentage of price. There is
 * no column for it and no way to compare a column against another column times
 * a constant, so it is applied to the mapped rows instead.
 */
function passesLocal(stock, t = thresholds()) {
  if (!t.minAtrPct) return true;
  // Missing data is not evidence of an untradable stock. Dropping rows whose
  // ATR failed to come back would silently shrink every result set on a bad
  // response from the data provider — which reads as a quiet market rather than
  // a data problem. Note Number(null) is 0, not NaN, so null has to be caught
  // before the conversion or a blank ATR would look like an ATR of zero.
  const numeric = v => (v === null || v === undefined || v === '' ? null : Number(v));
  const atr = numeric(stock?.atr);
  const price = numeric(stock?.price);
  if (atr === null || price === null) return true;
  if (!Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) return true;
  return (atr / price) * 100 >= t.minAtrPct;
}

/** Apply the local half to a list of mapped rows, reporting what it removed. */
function applyLocal(rows, t = thresholds(), { liquidity = true } = {}) {
  // The ATR-percent leg is a liquidity question too — "is there room in the
  // move" — so a screener exempt from the floor is exempt from this half of it
  // as well, or the exemption would be undone locally after being granted on
  // the server.
  if (!liquidity) return { kept: rows, dropped: 0 };
  const kept = rows.filter(r => passesLocal(r.stock, t));
  return { kept, dropped: rows.length - kept.length };
}

/** Human-readable, for the Screeners tab. */
function describe(t = thresholds()) {
  return [
    `price ≥ $${t.minPrice}`,
    `average volume ≥ ${(t.minAvgVolume / 1e6).toFixed(t.minAvgVolume % 1e6 ? 1 : 0)}M shares`,
    `ADR ≥ $${t.minAtr}`,
    `ADR ≥ ${t.minAtrPct}% of price`,
  ];
}

module.exports = { DEFAULTS, thresholds, serverFilters, passesLocal, applyLocal, describe };
