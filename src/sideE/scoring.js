const db = require('../db');

function loadScoringModel() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'scoring_model'").get();
  if (row) {
    try { return JSON.parse(row.value); } catch { /* ignore */ }
  }
  // Default scoring model weights
  return {
    rvol: { weight: 15, threshold: 5 },
    gapPct: { weight: 10, threshold: 5 },
    adrPct: { weight: 10, threshold: 15 },
    pmRange: { weight: 10, threshold: 3 },
    regimeLong: { weight: 15 },
    sectorBias: { weight: 15 },
    sectorHot: { weight: 10 },
    catalyst: { weight: 15 },
  };
}

function scoreRow(row) {
  const model = loadScoringModel();
  let score = 0;

  const { stock, context, catalyst } = row;
  if (!stock) return null;

  // RVOL score
  if (stock.rvol != null && stock.rvol >= model.rvol.threshold) {
    score += model.rvol.weight;
  } else if (stock.rvol != null && stock.rvol >= 2) {
    score += Math.round(model.rvol.weight * 0.5);
  }

  // Gap Pct score
  if (stock.gapPct != null && Math.abs(stock.gapPct) >= model.gapPct.threshold) {
    score += model.gapPct.weight;
  } else if (stock.gapPct != null && Math.abs(stock.gapPct) >= 2) {
    score += Math.round(model.gapPct.weight * 0.5);
  }

  // ADR Pct score
  if (stock.adrPct != null && stock.adrPct >= model.adrPct.threshold) {
    score += model.adrPct.weight;
  } else if (stock.adrPct != null && stock.adrPct >= 8) {
    score += Math.round(model.adrPct.weight * 0.5);
  }

  // PM Range
  if (stock.pmRange != null && stock.atr != null && stock.atr > 0) {
    const pmAdrRatio = stock.pmRange / stock.atr;
    if (pmAdrRatio >= model.pmRange.threshold) {
      score += model.pmRange.weight;
    } else if (pmAdrRatio >= 1) {
      score += Math.round(model.pmRange.weight * 0.5);
    }
  }

  // Regime
  if (context) {
    const bullishRegimes = ['STRONG_UP', 'UP', 'EXTENDED_UP', 'PULLBACK_BULL', 'WEAK_UP'];
    const bearishRegimes = ['STRONG_DOWN', 'DOWN', 'CAPITULATION', 'TOPPING'];
    const slug = context.regime || '';
    if (slug && bullishRegimes.includes(slug)) {
      score += model.regimeLong.weight;
    } else if (slug && !bearishRegimes.includes(slug)) {
      score += Math.round(model.regimeLong.weight * 0.4);
    }

    // Sector bias
    if (context.secBias === 'BULLISH') score += model.sectorBias.weight;
    else if (context.secBias === 'NEUTRAL') score += Math.round(model.sectorBias.weight * 0.3);

    // Sector hot
    if (context.secHot) score += model.sectorHot.weight;
  }

  // Catalyst
  if (catalyst && catalyst.sentiment === 'bull') {
    score += model.catalyst.weight;
  } else if (catalyst && catalyst.sentiment === 'bear') {
    score -= model.catalyst.weight;
  }

  return Math.max(0, Math.min(100, score));
}

function scoreAllRows(rows) {
  return rows.map(row => ({
    ...row,
    _score: scoreRow(row),
  }));
}

module.exports = { scoreRow, scoreAllRows };
