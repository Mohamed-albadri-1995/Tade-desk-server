const db = require('../db');
const r0 = require('../r0/registry');
const { toETDate, toETTime } = require('../utils/time');
const { getLatestSnapshot } = require('../sideD/engine');

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
        price: row.stock?.price,
        change: row.stock?.change,
        gapPct: row.stock?.gapPct,
        vwap: row.stock?.vwap,
        rvol: row.stock?.rvol,
        atr: row.stock?.atr,
        adrPct: row.stock?.adrPct,
        pmRange: row.stock?.pmRange,
        pmAdrRatio: row.stock?.pmAdrRatio,
        sector: row.stock?.sector,
        industry: row.stock?.industry,
        screenerKeys: row.screenerKeys,
        _score: row._score,
        regime: row.context?.regime,
        secBias: row.context?.secBias,
        secScore: row.context?.secScore,
        liveNow: row.liveNow,
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
          price: d.stock?.price,
          change: d.stock?.change,
          gapPct: d.stock?.gapPct,
          vwap: d.stock?.vwap,
          rvol: d.stock?.rvol,
          atr: d.stock?.atr,
          adrPct: d.stock?.adrPct,
          pmRange: d.stock?.pmRange,
          pmAdrRatio: d.stock?.pmAdrRatio,
          sector: d.stock?.sector,
          screenerKeys: d.screenerKeys,
          _score: d._score,
          regime: d.context?.regime,
          secBias: d.context?.secBias,
          secScore: d.context?.secScore,
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
        return {
          slot: row.slot,
          spyClose: d.indices?.SPY?.close,
          spyChange: d.indices?.SPY?.change,
          qqqClose: d.indices?.QQQ?.close,
          qqqChange: d.indices?.QQQ?.change,
          vixClose: d.indices?.VIX?.close,
          vixChange: d.indices?.VIX?.change,
          regime: d.regime?.slug,
          regimeLabel: d.regime?.label,
          shortBias: d.shortTerm?.result,
          midStage: d.midTerm?.result,
          longBias: d.longTerm?.result,
          sectorBullish: bullish,
          sectorBearish: bearish,
          breakouts: d.breakoutNames,
          capturedAt: row.captured_at,
        };
      });
    }

    case 'R3A': {
      const rows = db
        .prepare('SELECT * FROM r3a WHERE date = ? ORDER BY ticker')
        .all(date || toETDate(Date.now()));
      return rows.map(row => ({
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
          ticker: d1.ticker,
          price936: d1.stock?.price,
          score: d1._score,
          sector: d1.stock?.sector,
          regime: d1.context?.regime,
          entryPriceA: r3a.entry_price_a,
          hhA: r3a.hh_a,
          llA: r3a.ll_a,
          upR_A: r3a.up_r_a,
          downR_A: r3a.down_r_a,
          atr14: r3a.atr14,
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
          ticker: d1.ticker,
          price936: d1.stock?.price,
          score: d1._score,
          sector: d1.stock?.sector,
          regime: d1.context?.regime,
          entryPriceB: r3b.entry_price_b,
          hhB: r3b.hh_b,
          llB: r3b.ll_b,
          upR_B: r3b.up_r_b,
          downR_B: r3b.down_r_b,
          atr14: r3b.atr14,
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
            addedAt: item.addedAt,
            method: item.method,
            price: item.price,
            change: item.change,
            sector: item.sector,
            score: item.score,
            exported: row.exported === 1,
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
