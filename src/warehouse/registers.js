const db = require('../db');
const r0 = require('../r0/registry');
const { toETDate, toETTime } = require('../utils/time');
const { getLatestSnapshot } = require('../sideD/engine');
const { computeRelations, RELATION_FIELDS } = require('../sideB/relations');

// Flatten a row's relational signals into register columns. Rows frozen before
// signals existed carry none, so they are recomputed from the stored stock
// fields — which backfills every historical register read, and therefore the
// R4 training export, without touching the stored JSON.
function signalCols(row) {
  const sig = (row && row.signals && Object.keys(row.signals).length)
    ? row.signals
    : computeRelations(row && row.stock);
  const out = {};
  for (const f of RELATION_FIELDS) out[f] = sig[f] ?? null;
  return out;
}

function captureR1() {
  const rows = r0.getTodayRows();
  const date = toETDate(Date.now());
  const capturedAt = Date.now();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO r1_frozen (date, ticker, data, captured_at)
    VALUES (?, ?, ?, ?)
  `);
  const insertMany = db.transaction(rows => {
    for (const row of rows) {
      insert.run(date, row.ticker, JSON.stringify(row), capturedAt);
    }
  });
  insertMany(rows);
  console.log('[Warehouse] R1 captured:', rows.length, 'rows for', date);
}

function captureR2() {
  const snapshot = getLatestSnapshot();
  if (!snapshot) return;

  const capturedAt = Date.now();
  const date = toETDate(capturedAt);
  const slot = toETTime(capturedAt);

  db.prepare(`
    INSERT INTO r2_market_snapshots (date, slot, captured_at, data)
    VALUES (?, ?, ?, ?)
  `).run(date, slot, capturedAt, JSON.stringify(snapshot));

  console.log('[Warehouse] R2 captured snapshot at slot', slot);
}

function getRegisterData(register, date) {
  switch (register) {
    case 'R0': {
      const rows = r0.getTodayRows();
      return rows.map(row => ({
        ticker: row.ticker,
        date: row.date,
        liveNow: row.liveNow,
        inShortlist: row.inShortlist,
        _score: row._score,
        // stock fields
        price: row.stock?.price,
        prevClose: row.stock?.prevClose,
        open: row.stock?.open,
        change: row.stock?.change,
        gapPct: row.stock?.gapPct,
        vwap: row.stock?.vwap,
        sma5: row.stock?.sma5,
        ema9: row.stock?.ema9,
        ema13: row.stock?.ema13,
        ema20: row.stock?.ema20,
        ema50: row.stock?.ema50,
        rvol: row.stock?.rvol,
        atr: row.stock?.atr,
        adrPct: row.stock?.adrPct,
        dayHigh: row.stock?.dayHigh,
        dayLow: row.stock?.dayLow,
        monthHigh: row.stock?.monthHigh,
        monthLow: row.stock?.monthLow,
        monthRangePos: row.stock?.monthRangePos,
        mcap: row.stock?.mcap,
        floatShares: row.stock?.floatShares,
        shortFloat: row.stock?.shortFloat,
        pmHigh: row.stock?.pmHigh,
        pmLow: row.stock?.pmLow,
        pmRange: row.stock?.pmRange,
        pmAdrRatio: row.stock?.pmAdrRatio,
        sector: row.stock?.sector,
        industry: row.stock?.industry,
        screenerKeys: row.screenerKeys,
        // context fields
        regime: row.context?.regime,
        regimeLabel: row.context?.regimeLabel,
        longTerm: row.context?.longTerm,
        midTerm: row.context?.midTerm,
        shortTerm: row.context?.shortTerm,
        broadResolved: row.context?.broadResolved,
        secBias: row.context?.secBias,
        secScore: row.context?.secScore,
        secHot: row.context?.secHot,
        themes: row.context?.themes,
        bias: row.bias || 'auto',
        ...signalCols(row),
        // catalyst & news summary
        catalyst: row.catalyst?.label || null,
        lastUpdated: row.lastUpdated,
      }));
    }

    case 'R1': {
      const rows = db
        .prepare('SELECT * FROM r1_frozen WHERE date = ? ORDER BY ticker')
        .all(date || toETDate(Date.now()));
      return rows.map(row => {
        const d = JSON.parse(row.data);
        return {
          ticker: d.ticker,
          date: row.date,
          inShortlist: d.inShortlist,
          _score: d._score,
          // stock fields
          price: d.stock?.price,
          prevClose: d.stock?.prevClose,
          open: d.stock?.open,
          change: d.stock?.change,
          gapPct: d.stock?.gapPct,
          vwap: d.stock?.vwap,
          sma5: d.stock?.sma5,
          ema9: d.stock?.ema9,
          ema13: d.stock?.ema13,
          ema20: d.stock?.ema20,
          ema50: d.stock?.ema50,
          rvol: d.stock?.rvol,
          atr: d.stock?.atr,
          adrPct: d.stock?.adrPct,
          dayHigh: d.stock?.dayHigh,
          dayLow: d.stock?.dayLow,
          monthHigh: d.stock?.monthHigh,
          monthLow: d.stock?.monthLow,
          monthRangePos: d.stock?.monthRangePos,
          mcap: d.stock?.mcap,
          floatShares: d.stock?.floatShares,
          shortFloat: d.stock?.shortFloat,
          pmHigh: d.stock?.pmHigh,
          pmLow: d.stock?.pmLow,
          pmRange: d.stock?.pmRange,
          pmAdrRatio: d.stock?.pmAdrRatio,
          sector: d.stock?.sector,
          industry: d.stock?.industry,
          screenerKeys: d.screenerKeys,
          // context fields
          regime: d.context?.regime,
          regimeLabel: d.context?.regimeLabel,
          longTerm: d.context?.longTerm,
          midTerm: d.context?.midTerm,
          shortTerm: d.context?.shortTerm,
          broadResolved: d.context?.broadResolved,
          secBias: d.context?.secBias,
          secScore: d.context?.secScore,
          secHot: d.context?.secHot,
          themes: d.context?.themes,
          bias: d.bias || 'auto',
          ...signalCols(d),
          catalyst: d.catalyst?.label || null,
          capturedAt: row.captured_at,
        };
      });
    }

    case 'R2': {
      const rows = db
        .prepare('SELECT * FROM r2_market_snapshots WHERE date = ? ORDER BY captured_at')
        .all(date || toETDate(Date.now()));
      return rows.map(row => {
        const d = JSON.parse(row.data);
        const sectors = d.sectors || {};
        const bullish = Object.values(sectors).filter(s => s.bias === 'BULLISH').length;
        const bearish = Object.values(sectors).filter(s => s.bias === 'BEARISH').length;
        const sectorEntries = {};
        for (const [name, s] of Object.entries(sectors)) {
          sectorEntries[`sec_${name}_bias`] = s.bias;
          sectorEntries[`sec_${name}_score`] = s.score;
          sectorEntries[`sec_${name}_change`] = s.change;
          sectorEntries[`sec_${name}_hot`] = s.hot;
        }
        return {
          date: row.date,
          slot: row.slot,
          // Indices
          spyClose: d.indices?.SPY?.close,
          spyChange: d.indices?.SPY?.change,
          spyWeekChg: d.indices?.SPY?.weekChg,
          spySma5: d.indices?.SPY?.sma5,
          spySma20: d.indices?.SPY?.sma20,
          spySma50: d.indices?.SPY?.sma50,
          spySma200: d.indices?.SPY?.sma200,
          spyBbUpper: d.indices?.SPY?.bbUpper,
          spyBbLower: d.indices?.SPY?.bbLower,
          qqqClose: d.indices?.QQQ?.close,
          qqqChange: d.indices?.QQQ?.change,
          qqqWeekChg: d.indices?.QQQ?.weekChg,
          qqqSma5: d.indices?.QQQ?.sma5,
          qqqSma20: d.indices?.QQQ?.sma20,
          qqqSma50: d.indices?.QQQ?.sma50,
          qqqSma200: d.indices?.QQQ?.sma200,
          iwmClose: d.indices?.IWM?.close,
          iwmChange: d.indices?.IWM?.change,
          iwmWeekChg: d.indices?.IWM?.weekChg,
          diaClose: d.indices?.DIA?.close,
          diaChange: d.indices?.DIA?.change,
          vixClose: d.indices?.VIX?.close,
          vixChange: d.indices?.VIX?.change,
          vixWeekChg: d.indices?.VIX?.weekChg,
          // Market bias
          regime: d.regime?.slug,
          regimeLabel: d.regime?.label,
          shortBias: d.shortTerm?.result,
          shortScore: d.shortTerm?.score,
          midStage: d.midTerm?.result,
          longBias: d.longTerm?.result,
          // Sector summary
          sectorBullish: bullish,
          sectorBearish: bearish,
          breakouts: d.breakoutNames,
          // Per-sector columns
          ...sectorEntries,
          capturedAt: row.captured_at,
        };
      });
    }

    case 'R3A': {
      const rows = db
        .prepare('SELECT * FROM r3a WHERE date = ? ORDER BY ticker')
        .all(date || toETDate(Date.now()));
      return rows.map(row => ({
        date: row.date,
        ticker: row.ticker,
        entryPriceA: row.entry_price_a,
        hhA: row.hh_a,
        llA: row.ll_a,
        atr14: row.atr14,
        upR_A: row.up_r_a,
        downR_A: row.down_r_a,
        capturedAt: row.captured_at,
      }));
    }

    case 'R3B': {
      const rows = db
        .prepare('SELECT * FROM r3b WHERE date = ? ORDER BY ticker')
        .all(date || toETDate(Date.now()));
      return rows.map(row => ({
        date: row.date,
        ticker: row.ticker,
        entryPriceB: row.entry_price_b,
        hhB: row.hh_b,
        llB: row.ll_b,
        atr14: row.atr14,
        upR_B: row.up_r_b,
        downR_B: row.down_r_b,
        capturedAt: row.captured_at,
      }));
    }

    case 'R4A': {
      const d = date || toETDate(Date.now());
      const r1Rows = db.prepare('SELECT * FROM r1_frozen WHERE date = ?').all(d);
      const r3aRows = db.prepare('SELECT * FROM r3a WHERE date = ?').all(d);
      const r3aMap = {};
      for (const r of r3aRows) r3aMap[r.ticker] = r;
      return r1Rows.map(row => {
        const d1 = JSON.parse(row.data);
        const r3a = r3aMap[d1.ticker] || {};
        return {
          date: row.date,
          ticker: d1.ticker,
          _score: d1._score,
          inShortlist: d1.inShortlist,
          // R1 stock fields at 9:36 AM
          price936: d1.stock?.price,
          prevClose: d1.stock?.prevClose,
          open: d1.stock?.open,
          change: d1.stock?.change,
          gapPct: d1.stock?.gapPct,
          vwap: d1.stock?.vwap,
          sma5: d1.stock?.sma5,
          ema9: d1.stock?.ema9,
          ema13: d1.stock?.ema13,
          ema20: d1.stock?.ema20,
          ema50: d1.stock?.ema50,
          rvol: d1.stock?.rvol,
          atr: d1.stock?.atr,
          adrPct: d1.stock?.adrPct,
          dayHigh: d1.stock?.dayHigh,
          dayLow: d1.stock?.dayLow,
          monthHigh: d1.stock?.monthHigh,
          monthLow: d1.stock?.monthLow,
          monthRangePos: d1.stock?.monthRangePos,
          mcap: d1.stock?.mcap,
          floatShares: d1.stock?.floatShares,
          shortFloat: d1.stock?.shortFloat,
          pmHigh: d1.stock?.pmHigh,
          pmLow: d1.stock?.pmLow,
          pmRange: d1.stock?.pmRange,
          pmAdrRatio: d1.stock?.pmAdrRatio,
          sector: d1.stock?.sector,
          industry: d1.stock?.industry,
          screenerKeys: d1.screenerKeys,
          // R1 context
          regime: d1.context?.regime,
          regimeLabel: d1.context?.regimeLabel,
          longTerm: d1.context?.longTerm,
          midTerm: d1.context?.midTerm,
          shortTerm: d1.context?.shortTerm,
          broadResolved: d1.context?.broadResolved,
          secBias: d1.context?.secBias,
          secScore: d1.context?.secScore,
          secHot: d1.context?.secHot,
          themes: d1.context?.themes,
          bias: d1.bias || 'auto',
          ...signalCols(d1),
          catalyst: d1.catalyst?.label || null,
          // R3A EOD fields
          entryPriceA: r3a.entry_price_a,
          hhA: r3a.hh_a,
          llA: r3a.ll_a,
          atr14: r3a.atr14,
          upR_A: r3a.up_r_a,
          downR_A: r3a.down_r_a,
          capturedAt: r3a.captured_at,
        };
      });
    }

    case 'R4B': {
      const d = date || toETDate(Date.now());
      const r1Rows = db.prepare('SELECT * FROM r1_frozen WHERE date = ?').all(d);
      const r3bRows = db.prepare('SELECT * FROM r3b WHERE date = ?').all(d);
      const r3bMap = {};
      for (const r of r3bRows) r3bMap[r.ticker] = r;
      return r1Rows.map(row => {
        const d1 = JSON.parse(row.data);
        const r3b = r3bMap[d1.ticker] || {};
        return {
          date: row.date,
          ticker: d1.ticker,
          _score: d1._score,
          inShortlist: d1.inShortlist,
          // R1 stock fields at 9:36 AM
          price936: d1.stock?.price,
          prevClose: d1.stock?.prevClose,
          open: d1.stock?.open,
          change: d1.stock?.change,
          gapPct: d1.stock?.gapPct,
          vwap: d1.stock?.vwap,
          sma5: d1.stock?.sma5,
          ema9: d1.stock?.ema9,
          ema13: d1.stock?.ema13,
          ema20: d1.stock?.ema20,
          ema50: d1.stock?.ema50,
          rvol: d1.stock?.rvol,
          atr: d1.stock?.atr,
          adrPct: d1.stock?.adrPct,
          dayHigh: d1.stock?.dayHigh,
          dayLow: d1.stock?.dayLow,
          monthHigh: d1.stock?.monthHigh,
          monthLow: d1.stock?.monthLow,
          monthRangePos: d1.stock?.monthRangePos,
          mcap: d1.stock?.mcap,
          floatShares: d1.stock?.floatShares,
          shortFloat: d1.stock?.shortFloat,
          pmHigh: d1.stock?.pmHigh,
          pmLow: d1.stock?.pmLow,
          pmRange: d1.stock?.pmRange,
          pmAdrRatio: d1.stock?.pmAdrRatio,
          sector: d1.stock?.sector,
          industry: d1.stock?.industry,
          screenerKeys: d1.screenerKeys,
          // R1 context
          regime: d1.context?.regime,
          regimeLabel: d1.context?.regimeLabel,
          longTerm: d1.context?.longTerm,
          midTerm: d1.context?.midTerm,
          shortTerm: d1.context?.shortTerm,
          broadResolved: d1.context?.broadResolved,
          secBias: d1.context?.secBias,
          secScore: d1.context?.secScore,
          secHot: d1.context?.secHot,
          themes: d1.context?.themes,
          bias: d1.bias || 'auto',
          ...signalCols(d1),
          catalyst: d1.catalyst?.label || null,
          // R3B EOD fields
          entryPriceB: r3b.entry_price_b,
          hhB: r3b.hh_b,
          llB: r3b.ll_b,
          atr14: r3b.atr14,
          upR_B: r3b.up_r_b,
          downR_B: r3b.down_r_b,
          capturedAt: r3b.captured_at,
        };
      });
    }

    case 'Shortlist': {
      const rows = db
        .prepare('SELECT * FROM shortlist ORDER BY date DESC')
        .all();
      const result = [];
      for (const row of rows) {
        const items = JSON.parse(row.items);
        for (const item of items) {
          result.push({
            date: row.date,
            ticker: item.ticker,
            tvSymbol: item.tvSymbol || null,
            addedAt: item.addedAt,
            method: item.method,
            price: item.price,
            change: item.change,
            sector: item.sector,
            score: item.score,
            exported: row.exported === 1,
            exportedAt: row.exported_at || null,
          });
        }
      }
      return result;
    }

    default:
      return null;
  }
}

function getAvailableDates(register) {
  switch (register) {
    case 'R1':
      return db.prepare('SELECT DISTINCT date FROM r1_frozen ORDER BY date DESC').all().map(r => r.date);
    case 'R2':
      return db.prepare('SELECT DISTINCT date FROM r2_market_snapshots ORDER BY date DESC').all().map(r => r.date);
    case 'R3A':
      return db.prepare('SELECT DISTINCT date FROM r3a ORDER BY date DESC').all().map(r => r.date);
    case 'R3B':
      return db.prepare('SELECT DISTINCT date FROM r3b ORDER BY date DESC').all().map(r => r.date);
    case 'Shortlist':
      return db.prepare('SELECT DISTINCT date FROM shortlist ORDER BY date DESC').all().map(r => r.date);
    default:
      return [];
  }
}

module.exports = { captureR1, captureR2, getRegisterData, getAvailableDates };
