/**
 * Training data accumulator.
 *
 * Source of truth for all R4A/R4B rows used to train the scoring model.
 * Survives the daily auto-train. Populated by:
 *   - EOD capture (Side H) — calls syncFromWarehouse(date)
 *   - Manual CSV upload (routes/analysis.js) — calls upsertRowsFromCSV()
 *
 * Rows are deduped by (date, ticker). Re-uploading the same date
 * replaces those rows only — older history is preserved.
 */

const path = require('path');
const fs = require('fs');
const db = require('../db');
const { getRegisterData } = require('../warehouse/registers');

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

const VALID_REGISTERS = ['R4A', 'R4B'];
const TABLE_BY_REGISTER = { R4A: 'r4a_train', R4B: 'r4b_train' };
const FILE_BY_REGISTER = { R4A: 'r4a.csv', R4B: 'r4b.csv' };

function assertRegister(register) {
  if (!VALID_REGISTERS.includes(register)) {
    throw new Error(`Invalid training register: ${register}`);
  }
}

function getAllRows(register) {
  assertRegister(register);
  const table = TABLE_BY_REGISTER[register];
  const rows = db.prepare(`SELECT data FROM ${table} ORDER BY date ASC, ticker ASC`).all();
  return rows.map(r => JSON.parse(r.data));
}

function getRowCount(register) {
  assertRegister(register);
  const table = TABLE_BY_REGISTER[register];
  return db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n;
}

function getDistinctDates(register) {
  assertRegister(register);
  const table = TABLE_BY_REGISTER[register];
  return db
    .prepare(`SELECT DISTINCT date FROM ${table} ORDER BY date DESC`)
    .all()
    .map(r => r.date);
}

function clearAll(register) {
  assertRegister(register);
  const table = TABLE_BY_REGISTER[register];
  db.prepare(`DELETE FROM ${table}`).run();
}

function clearDate(register, date) {
  assertRegister(register);
  const table = TABLE_BY_REGISTER[register];
  db.prepare(`DELETE FROM ${table} WHERE date = ?`).run(date);
}

function upsertRows(register, rows, source) {
  assertRegister(register);
  const table = TABLE_BY_REGISTER[register];
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${table} (date, ticker, data, source, added_at) VALUES (?, ?, ?, ?, ?)`
  );
  const txn = db.transaction(items => {
    for (const row of items) {
      if (!row || !row.date || !row.ticker) continue;
      stmt.run(String(row.date), String(row.ticker), JSON.stringify(row), source, now);
    }
  });
  txn(rows);
  return rows.length;
}

/**
 * Re-derive today's R4A/R4B rows from warehouse (r1_frozen + r3a/r3b)
 * and upsert into the training tables. Called after Side H captures.
 */
function syncFromWarehouse(date) {
  const r4a = getRegisterData('R4A', date) || [];
  const r4b = getRegisterData('R4B', date) || [];
  // Only keep rows that actually have outcome data (EOD bars were found)
  const r4aWithOutcome = r4a.filter(r => r.upR_A != null && r.downR_A != null);
  const r4bWithOutcome = r4b.filter(r => r.upR_B != null && r.downR_B != null);
  const wroteA = upsertRows('R4A', r4aWithOutcome, 'auto');
  const wroteB = upsertRows('R4B', r4bWithOutcome, 'auto');
  return { r4a: wroteA, r4b: wroteB };
}

// ────────────────────────────────────────────────────────────
// CSV helpers
// ────────────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) val = val.join('|');
  else if (typeof val === 'object') val = JSON.stringify(val);
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Build a CSV of ALL accumulated training rows for a register and write it
 * to tmp/r4a.csv (or tmp/r4b.csv). Returns the file path, or null if empty.
 */
function writeTrainingCSV(register) {
  assertRegister(register);
  const rows = getAllRows(register);
  if (rows.length === 0) return null;

  // Use a stable column order — union of keys, with date+ticker first.
  const keySet = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) keySet.add(k);
  }
  const orderedKeys = ['date', 'ticker', ...[...keySet].filter(k => k !== 'date' && k !== 'ticker')];

  const csv = [
    orderedKeys.join(','),
    ...rows.map(row => orderedKeys.map(k => csvEscape(row[k])).join(',')),
  ].join('\n');

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, FILE_BY_REGISTER[register]);
  fs.writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

/**
 * Parse a CSV buffer/string into row objects, coercing numeric strings.
 * Returns [{date, ticker, ...}, ...]
 */
function parseCSV(content) {
  const text = content.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]);
    if (cells.length === 0) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      const raw = cells[j];
      if (raw === undefined || raw === '') {
        obj[h] = null;
      } else if (!isNaN(Number(raw)) && raw.trim() !== '') {
        obj[h] = Number(raw);
      } else if (raw === 'true' || raw === 'false') {
        obj[h] = raw === 'true';
      } else {
        obj[h] = raw;
      }
    }
    out.push(obj);
  }
  return out;
}

function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') { inQuote = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Upload-CSV handler logic. Returns counts.
 * mode: 'append' (upsert by PK) | 'replace' (clear table then insert)
 */
function ingestUploadedCSV(register, csvContent, mode) {
  assertRegister(register);
  const rows = parseCSV(csvContent);
  const valid = rows.filter(r => r && r.date && r.ticker);
  const skipped = rows.length - valid.length;

  if (mode === 'replace') {
    clearAll(register);
  }
  upsertRows(register, valid, 'upload');

  return {
    parsed: rows.length,
    inserted: valid.length,
    skipped,
    total: getRowCount(register),
    dates: getDistinctDates(register),
  };
}

/**
 * One-time migration: if a training table is empty and tmp/<file>.csv exists,
 * import its rows so existing data is preserved across this deploy.
 */
function migrateFromTmpCSV() {
  const summary = { migrated: {} };
  for (const reg of VALID_REGISTERS) {
    try {
      if (getRowCount(reg) > 0) continue;
      const filePath = path.join(TMP_DIR, FILE_BY_REGISTER[reg]);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const rows = parseCSV(content).filter(r => r && r.date && r.ticker);
      if (rows.length > 0) {
        upsertRows(reg, rows, 'migrated');
        summary.migrated[reg] = rows.length;
        console.log(`[Training Migration] Imported ${rows.length} rows into ${reg} from ${filePath}`);
      }
    } catch (err) {
      console.warn(`[Training Migration] ${reg} failed:`, err.message);
    }
  }
  return summary;
}

module.exports = {
  VALID_REGISTERS,
  getAllRows,
  getRowCount,
  getDistinctDates,
  clearAll,
  clearDate,
  upsertRows,
  syncFromWarehouse,
  writeTrainingCSV,
  ingestUploadedCSV,
  migrateFromTmpCSV,
};
