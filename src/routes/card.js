/*
 * One card, by ticker.
 *
 * The shortlist stores a summary — score, price, change, sector — which is
 * enough to list but not enough to decide anything. The full card exists
 * already, in two places depending on how old it is, and this serves whichever
 * one applies:
 *
 *   today   → r0, the live row, still being re-quoted every five minutes
 *   earlier → r1_frozen, the photo taken at this tool's capture time
 *
 * The frozen row IS an r0 row — captureR1 stores it whole — so both come back
 * in the same shape and the page can render either with the same code.
 */

const express = require('express');
const db = require('../db');
const r0 = require('../r0/registry');
const { toETDate } = require('../utils/time');

const router = express.Router();

// GET /api/card/:ticker?date=YYYY-MM-DD
router.get('/:ticker', (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase();
  const today = toETDate(Date.now());
  const date = req.query.date || today;

  try {
    // Live first when the date is today — it is fresher than the 09:36 photo.
    if (date === today) {
      const row = r0.getRow(ticker);
      if (row) return res.json({ ok: true, source: 'live', date, card: row });
    }

    const frozen = db.prepare(
      'SELECT data, captured_at FROM r1_frozen WHERE date = ? AND ticker = ?'
    ).get(date, ticker);
    if (frozen) {
      return res.json({
        ok: true,
        source: 'frozen',
        date,
        capturedAt: frozen.captured_at,
        card: JSON.parse(frozen.data),
      });
    }

    // Say which it is. "Not on this tool" and "not on this date" send the
    // reader to different places, and a bare 404 says neither.
    const anyDate = db.prepare(
      'SELECT date FROM r1_frozen WHERE ticker = ? ORDER BY date DESC LIMIT 1'
    ).get(ticker);
    return res.status(404).json({
      ok: false,
      error: anyDate
        ? `${ticker} was not on this tool on ${date}. Most recent: ${anyDate.date}.`
        : `${ticker} has never been on this tool.`,
      lastSeen: anyDate ? anyDate.date : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
