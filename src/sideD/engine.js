const { fetchMarketData, SECTOR_ETF_MAP, TV_SECTOR_TO_MARKET_KEY } = require('./marketContext');
const { computeMarketBiasDetail, computeMarketStage, computeLongTermBias, computeRegime } = require('./regime');
const { computeAllSectors } = require('./sectors');
const { themesForTicker } = require('./themes');

let latestSnapshot = null;

async function buildMarketSnapshot() {
  const marketData = await fetchMarketData();

  const SPY = marketData['SPY'] || {};
  const QQQ = marketData['QQQ'] || {};
  const IWM = marketData['IWM'] || {};
  const DIA = marketData['DIA'] || {};
  const VIX = marketData['VIX'] || {};

  const indices = {
    SPY: {
      close: SPY['close'],
      change: SPY['change'],
      weekChg: SPY['change|1W'],
      sma5: SPY['SMA5'],
      sma20: SPY['SMA20'],
      sma50: SPY['SMA50'],
      sma200: SPY['SMA200'],
      bbUpper: SPY['BB.upper'],
      bbLower: SPY['BB.lower'],
    },
    QQQ: {
      close: QQQ['close'],
      change: QQQ['change'],
      weekChg: QQQ['change|1W'],
      sma5: QQQ['SMA5'],
      sma20: QQQ['SMA20'],
      sma50: QQQ['SMA50'],
      sma200: QQQ['SMA200'],
      bbUpper: QQQ['BB.upper'],
      bbLower: QQQ['BB.lower'],
    },
    IWM: { close: IWM['close'], change: IWM['change'], weekChg: IWM['change|1W'] },
    DIA: { close: DIA['close'], change: DIA['change'] },
    VIX: { close: VIX['close'], change: VIX['change'], weekChg: VIX['change|1W'] },
  };

  // Use raw market data for signal calculations (with original TV keys)
  const indicesRaw = {
    SPY: marketData['SPY'] || {},
    QQQ: marketData['QQQ'] || {},
    IWM: marketData['IWM'] || {},
    VIX: marketData['VIX'] || {},
  };

  const shortTerm = computeMarketBiasDetail(indicesRaw);
  const midTerm = computeMarketStage(indicesRaw);
  const longTerm = computeLongTermBias(indicesRaw);
  const regime = computeRegime(longTerm, midTerm, midTerm.bb);

  const sectors = computeAllSectors(marketData, marketData['SPY'] || {});

  const breakoutNames = Object.values(marketData)
    .filter(d => d['change'] > 3 && d['relative_volume_10d_calc'] > 2)
    .map((_, idx) => Object.keys(marketData)[idx])
    .filter(s => !['SPY', 'QQQ', 'IWM', 'DIA', 'VIX'].includes(s))
    .slice(0, 5);

  const capturedAt = new Date().toISOString();
  const date = capturedAt.slice(0, 10);

  latestSnapshot = {
    capturedAt,
    date,
    indices,
    shortTerm,
    midTerm,
    longTerm,
    regime,
    sectors,
    breakoutNames,
  };

  return latestSnapshot;
}

function getLatestSnapshot() {
  return latestSnapshot;
}

function enrichR0WithContext(r0Rows) {
  if (!latestSnapshot) return r0Rows;

  const { regime, longTerm, midTerm, shortTerm, sectors } = latestSnapshot;

  return r0Rows.map(row => {
    const tvSector = row.stock?.sector || '';
    const marketKey = TV_SECTOR_TO_MARKET_KEY[tvSector] || tvSector;
    const sectorData = sectors[marketKey] || null;

    const themes = themesForTicker(row.ticker, row.stock?.industry || '');

    return {
      ...row,
      context: {
        themes,
        broadResolved: marketKey,
        regime: regime.slug,
        regimeLabel: regime.label,
        longTerm: longTerm.result,
        midTerm: midTerm.result,
        shortTerm: shortTerm.result,
        secBias: sectorData ? sectorData.bias : 'NEUTRAL',
        secScore: sectorData ? sectorData.score : 0,
        secHot: sectorData ? sectorData.hot : false,
      },
    };
  });
}

module.exports = { buildMarketSnapshot, getLatestSnapshot, enrichR0WithContext };
