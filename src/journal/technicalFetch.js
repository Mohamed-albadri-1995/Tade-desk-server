/**
 * Post-trade technical field computation.
 *
 * Given ticker + date + entry/exit times and prices, fetches intraday bars
 * from Yahoo Finance (recent) or Alpaca (stored creds) and computes:
 *   - Price, VWAP, EMA9/13/20/50, SMA20, BB(20,2), ATR, rvol at entry time
 *   - MAE, MFE between entry and exit
 *   - R-multiple, Capture %, exit verdict
 */

const db = require('../db');
const { fetchIntradayBars } = require('../alpaca/client');
const volumeBaseline = require('../trading/volumeBaseline');

// ─── R1 lookup helpers ────────────────────────────────────────────────────────

function getR1Row(ticker, date) {
  const row = db.prepare('SELECT data FROM r1_frozen WHERE date = ? AND ticker = ?').get(date, ticker);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

/**
 * Auto-populate context snapshot from r1_frozen if none exists for this trade.
 */
function tryAutoContext(trade) {
  const existing = db.prepare('SELECT trade_id FROM journal_context_snapshots WHERE trade_id = ?').get(trade.id);
  if (existing) return;
  const r1 = getR1Row(trade.ticker, trade.date);
  if (!r1?.context) return;
  const ctx = r1.context;
  db.prepare(`
    INSERT OR IGNORE INTO journal_context_snapshots
      (trade_id, regime, regime_label, sec_bias, broad_resolved, short_term, mid_term, long_term,
       sec_score, sector, industry, scanner_score, scanner_confidence, captured_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    trade.id, ctx.regime || null, ctx.regimeLabel || null, ctx.secBias || null,
    ctx.broadResolved || null, ctx.shortTerm || null, ctx.midTerm || null, ctx.longTerm || null,
    r1.stock?.secScore ?? ctx.secScore ?? null,
    r1.stock?.sector || null, r1.stock?.industry || null,
    r1._score != null ? Math.round(r1._score) : null, null, Date.now()
  );
}

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// ─── Yahoo Finance fetch ──────────────────────────────────────────────────────

async function fetchYahooIntraday(ticker, date) {
  const start = Math.floor(new Date(`${date}T09:30:00-05:00`).getTime() / 1000);
  const end   = Math.floor(new Date(`${date}T16:00:00-05:00`).getTime() / 1000);
  const url = `${YAHOO_BASE}/${ticker}?interval=1m&period1=${start}&period2=${end}&includePrePost=false`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Yahoo ${ticker} ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no result for ${ticker}`);

  const { timestamp, indicators } = result;
  const q = indicators.quote[0];
  return timestamp.map((ts, i) => ({
    t: ts * 1000,
    etTime: new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }),
    o: q.open[i],
    h: q.high[i],
    l: q.low[i],
    c: q.close[i],
    v: q.volume[i],
  })).filter(b => b.c != null);
}

// ─── Technical computations ───────────────────────────────────────────────────

function ema(closes, period) {
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period - 1).fill(null);
  result.push(e);
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    result.push(e);
  }
  return result;
}

function sma(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    return closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}

function computeVwap(bars) {
  let cumVol = 0, cumTpVol = 0;
  return bars.map(b => {
    const tp = (b.h + b.l + b.c) / 3;
    const vol = b.v || 0;
    cumVol += vol;
    cumTpVol += tp * vol;
    return cumVol > 0 ? cumTpVol / cumVol : b.c;
  });
}

function computeBB(closes, period = 20, mult = 2) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
  });
}

function barMinute(bar) {
  return bar.etTime || bar.t?.toString();
}

// ─── Main: compute technical snapshot at entry bar ────────────────────────────

async function computeTechnical(trade) {
  const { ticker, date, entry_time, exit_time, entry_price, exit_price, direction, sl } = trade;

  let bars;
  try {
    bars = await fetchYahooIntraday(ticker, date);
  } catch {
    try {
      const raw = await fetchIntradayBars([ticker], date);
      bars = raw[ticker] || [];
    } catch (e) {
      throw new Error(`Cannot fetch bars for ${ticker} ${date}: ${e.message}`);
    }
  }
  if (!bars.length) throw new Error(`No bars for ${ticker} ${date}`);

  const closes = bars.map(b => b.c);
  const highs  = bars.map(b => b.h);
  const lows   = bars.map(b => b.l);
  const vols   = bars.map(b => b.v || 0);

  const vwaps  = computeVwap(bars);
  const e9     = ema(closes, 9);
  const e13    = ema(closes, 13);
  const e20    = ema(closes, 20);
  const e50    = ema(closes, 50);
  const s20    = sma(closes, 20);
  const bbs    = computeBB(closes, 20, 2);

  // Find entry bar index
  const entryMin = entry_time?.slice(0, 5); // 'HH:MM'
  let entryIdx = bars.findIndex(b => barMinute(b) === entryMin);
  if (entryIdx < 0) entryIdx = Math.max(0, bars.length - 1);

  const price  = closes[entryIdx];
  const vwap   = vwaps[entryIdx];
  const bb     = bbs[entryIdx];

  // rvol at entry
  const avgVol = volumeBaseline.getAvgVolume(ticker, entryMin);
  const rvol   = avgVol && vols[entryIdx] ? parseFloat((vols[entryIdx] / avgVol).toFixed(2)) : null;

  // Relative positions
  const rel = (price, ref) => ref != null ? (price > ref ? 'above' : price < ref ? 'below' : 'at') : null;

  // EMA stack
  const emaStackBullish = (e9[entryIdx] != null && e13[entryIdx] != null && e20[entryIdx] != null)
    ? (e9[entryIdx] > e13[entryIdx] && e13[entryIdx] > e20[entryIdx] ? 1 : 0)
    : null;

  // BB zone
  let bbZone = null;
  if (bb && price != null) {
    bbZone = price > bb.mid ? 'upper' : 'lower';
  }

  // MAE / MFE between entry and exit
  const exitMin = exit_time?.slice(0, 5);
  const exitIdx = exitMin ? bars.findIndex(b => barMinute(b) === exitMin) : -1;
  const tradeBars = bars.slice(entryIdx, exitIdx > entryIdx ? exitIdx + 1 : bars.length);

  let mae = null, mfe = null;
  if (tradeBars.length && entry_price) {
    const favs = tradeBars.map(b => direction === 'Long' ? b.h - entry_price : entry_price - b.l);
    const advs = tradeBars.map(b => direction === 'Long' ? b.l - entry_price : entry_price - b.h);
    mfe = Math.max(...favs);
    mae = Math.min(...advs); // negative = adverse move against us
  }

  // R-multiple, Capture %
  let rMultiple = null, capturePct = null, exitVerdict = null;
  if (sl != null && entry_price != null && exit_price != null) {
    const riskPerShare = Math.abs(entry_price - sl);
    const pnlPerShare  = direction === 'Long'
      ? exit_price - entry_price
      : entry_price - exit_price;
    if (riskPerShare > 0) {
      rMultiple  = parseFloat((pnlPerShare / riskPerShare).toFixed(2));
    }
    if (mfe != null && mfe > 0) {
      capturePct = parseFloat((pnlPerShare / mfe * 100).toFixed(1));
      exitVerdict = capturePct >= 80 ? 'great' : capturePct >= 50 ? 'ok' : capturePct >= 20 ? 'early' : 'poor';
    }
  }

  // Pre-market high/low — from r1_frozen snapshot if available (captured by scanner at market open)
  const r1 = getR1Row(ticker, date);
  const pmHigh = r1?.stock?.pmHigh ?? null;
  const pmLow  = r1?.stock?.pmLow  ?? null;

  return {
    technicalSnapshot: {
      price,
      vwap:     vwap   != null ? parseFloat(vwap.toFixed(4))   : null,
      ema9:     e9[entryIdx]  != null ? parseFloat(e9[entryIdx].toFixed(4))  : null,
      ema13:    e13[entryIdx] != null ? parseFloat(e13[entryIdx].toFixed(4)) : null,
      ema20:    e20[entryIdx] != null ? parseFloat(e20[entryIdx].toFixed(4)) : null,
      ema50:    e50[entryIdx] != null ? parseFloat(e50[entryIdx].toFixed(4)) : null,
      sma20:    s20[entryIdx] != null ? parseFloat(s20[entryIdx].toFixed(4)) : null,
      bb_upper: bb?.upper != null ? parseFloat(bb.upper.toFixed(4)) : null,
      bb_lower: bb?.lower != null ? parseFloat(bb.lower.toFixed(4)) : null,
      bb_mid:   bb?.mid   != null ? parseFloat(bb.mid.toFixed(4))   : null,
      rvol,
      pm_high: pmHigh,
      pm_low:  pmLow,
      price_rel_vwap:  rel(price, vwap),
      price_rel_ema9:  rel(price, e9[entryIdx]),
      price_rel_ema13: rel(price, e13[entryIdx]),
      price_rel_ema20: rel(price, e20[entryIdx]),
      price_rel_ema50: rel(price, e50[entryIdx]),
      ema_stack_bullish: emaStackBullish,
      bb_zone: bbZone,
    },
    outcomes: {
      mae_pct:    mae  != null && entry_price ? parseFloat((mae  / entry_price * 100).toFixed(3)) : null,
      mfe_pct:    mfe  != null && entry_price ? parseFloat((mfe  / entry_price * 100).toFixed(3)) : null,
      r_multiple: rMultiple,
      capture_pct: capturePct,
      exit_verdict: exitVerdict,
    },
  };
}

/**
 * Fetch technical data for a trade and persist to DB.
 * Returns { technicalSnapshot, outcomes } or throws.
 */
async function fetchAndStore(trade) {
  tryAutoContext(trade);
  const { technicalSnapshot: ts, outcomes: out } = await computeTechnical(trade);
  const now = Date.now();

  db.prepare(`
    INSERT OR REPLACE INTO journal_technical_snapshots
      (trade_id, price, vwap, ema9, ema13, ema20, ema50, sma20,
       bb_upper, bb_lower, bb_mid, rvol, pm_high, pm_low,
       price_rel_vwap, price_rel_ema9, price_rel_ema13, price_rel_ema20, price_rel_ema50,
       ema_stack_bullish, bb_zone, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    trade.id, ts.price, ts.vwap, ts.ema9, ts.ema13, ts.ema20, ts.ema50, ts.sma20,
    ts.bb_upper, ts.bb_lower, ts.bb_mid, ts.rvol, ts.pm_high, ts.pm_low,
    ts.price_rel_vwap, ts.price_rel_ema9, ts.price_rel_ema13, ts.price_rel_ema20, ts.price_rel_ema50,
    ts.ema_stack_bullish, ts.bb_zone, now
  );

  // Update outcomes on trade record
  if (out.r_multiple != null || out.mae_pct != null) {
    db.prepare(`
      UPDATE journal_trades SET
        mae_pct=?, mfe_pct=?, r_multiple=?, capture_pct=?, exit_verdict=?, technical_computed=1
      WHERE id=?
    `).run(out.mae_pct, out.mfe_pct, out.r_multiple, out.capture_pct, out.exit_verdict, trade.id);
  } else {
    db.prepare('UPDATE journal_trades SET technical_computed=1 WHERE id=?').run(trade.id);
  }

  return { technicalSnapshot: ts, outcomes: out };
}

module.exports = { fetchAndStore, computeTechnical };
