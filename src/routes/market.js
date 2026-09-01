const express = require('express');
const { getLatestSnapshot, buildMarketSnapshot } = require('../sideD/engine');
const oneil = require('../sideD/oneil');

const router = express.Router();

// GET /api/market/oneil
//
// O'Neil's market model, read from the file qp publishes. Served separately
// from /snapshot on purpose: the existing snapshot is a short-term momentum
// blend and this is a state machine, and two market reads that shared an
// endpoint would end up sharing words on the page. They are different claims.
//
// Missing is a NORMAL answer, not an error: qp may not have run yet, and the
// tab renders exactly as it does today when this returns nothing.
router.get('/oneil', async (req, res) => {
  let model = oneil.read();

  // NOTHING ELSE BUILDS IT. qp writes the file, but only when something asks
  // qp for it — so with nine tools reading and nobody asking, the file never
  // appeared and every market tab showed "not built yet" forever. Waiting for
  // a person to run a curl is not a mechanism.
  //
  // So a reader that finds nothing asks qp once, with a short timeout. Nine
  // tools doing this is self-limiting: qp caches for twelve hours, so the
  // first request rebuilds and the other eight get that answer.
  if (!model) {
    try {
      const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      await fetch(`${qp}/api/oneil/market`, { signal: ctl.signal });
      clearTimeout(timer);
      model = oneil.read();
    } catch { /* qp down or slow — fall through to the honest answer below */ }
  }

  if (!model) {
    return res.json({
      ok: false,
      reason: 'not built yet',
      detail: 'qp publishes this and was asked just now but did not answer. '
        + 'Check that qp-chart is running: systemctl status qp-chart',
      file: oneil.FILE,
    });
  }
  res.json({
    ok: true,
    ...model,
    exposure: oneil.EXPOSURE[model.status] || null,
    ftdBand: oneil.ftdBand(model.sessions_since_ftd),
  });
});

// GET /api/market/snapshot
router.get('/snapshot', async (req, res) => {
  let snapshot = getLatestSnapshot();
  if (!snapshot) {
    try {
      snapshot = await buildMarketSnapshot();
    } catch (err) {
      return res.status(503).json({ error: 'Market data unavailable', detail: err.message });
    }
  }
  res.json(snapshot);
});

/*
 * GET /api/market/oneil/stocks?symbols=A,B,C
 *
 * The per-card half of the market model (spec section 14): what each of these
 * stocks did on the exact sessions the index was distributed.
 *
 * WHY IT IS ONE CALL FOR MANY SYMBOLS. The card must not fetch — rule X5, no
 * network call in a card render — so the page asks once for everything on
 * screen and every card reads from that. A register day is 150 cards and each
 * re-renders on every re-quote; a request per card per render would be
 * thousands, for an answer that changes once a day.
 */
router.get('/oneil/stocks', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .replace(/\s+/g, ',').split(',').filter(Boolean);
  if (!symbols.length) return res.json({ ok: false, error: 'no symbols' });
  try {
    const c = await oneil.loadStocks(symbols);
    return res.json({
      ok: true,
      asOf: c.asOf,
      // The dates travel with the verdicts so the card can show WHICH sessions
      // it is talking about. "Up on 4 of 5" that cannot be checked against a
      // chart is a number to be believed rather than read.
      distributionDays: c.days,
      stocks: c.stocks,
      fetchedAt: c.at || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * GET /api/market/groups — the L block: group ranks and rank-within-group.
 *
 * Like /oneil, a reader that finds nothing asks qp once. Nothing else builds
 * the file, and waiting for somebody to run a curl is not a mechanism.
 */
router.get('/groups', async (req, res) => {
  const groups = require('../sideD/groups');
  let model = groups.read();
  if (!model) {
    try {
      const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 60000);
      try {
        await fetch(`${qp}/api/oneil/groups`, { signal: ctl.signal });
      } finally { clearTimeout(timer); }
      model = groups.read();
    } catch { /* qp down — the honest answer below */ }
  }
  if (!model) {
    return res.json({
      ok: false,
      reason: 'not built yet',
      detail: 'qp ranks the groups from the industry map the tools write as '
        + 'they scan. Run a scan, then GET /api/oneil/groups?refresh=1 on qp.',
      map: require('../sideA/industryMap').stats(),
    });
  }
  res.json({ ok: model.ok !== false, ...model, map: require('../sideA/industryMap').stats() });
});

/*
 * GET /api/market/oneil/13f — I, for every ticker at once.
 */
router.get('/oneil/13f', async (req, res) => {
  try {
    const d = await oneil.loadF13();
    if (!d) {
      return res.json({
        ok: false,
        reason: 'not built yet',
        detail: 'qp counts 13F holders nightly. It needs the SIC pass first, '
          + 'because issuers are matched to tickers by company name.',
      });
    }
    res.json(d);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * GET /api/market/short-interest?symbols=A,B
 *
 * A PROBE, not a card feed. Short interest has two possible sources and
 * neither can be verified from a development machine, so this says which one
 * answered and what it gave — otherwise diagnosing an empty field means
 * guessing between "Yahoo refused", "FINRA moved the file" and "this stock
 * genuinely has no reported short position".
 */
router.get('/short-interest', async (req, res) => {
  const symbols = String(req.query.symbols || 'GME,AAPL')
    .replace(/\s+/g, ',').split(',').filter(Boolean);
  const si = require('../sideC/shortInterest');
  const out = {};
  for (const t of symbols.slice(0, 10)) {
    // EVERY SOURCE'S REASON, not just the verdict. The first version of this
    // reported "no source answered" and nothing else, which left three very
    // different problems — Yahoo's cookie wall, a moved FINRA file, and a
    // stock with genuinely no reported short position — looking identical.
    const diag = {};
    // A FLOAT MAY BE SUPPLIED, because FINRA gives shares and the percentage
    // needs a denominator. During a scan that comes from the scanner row; here
    // it has to be passed or the probe shows a null percentage and looks like
    // a failure when the lookup in fact worked.
    const floatShares = Number(req.query.float) || undefined;
    // eslint-disable-next-line no-await-in-loop
    const rec = await si.lookup(t, { diag, floatShares });
    out[t.toUpperCase()] = rec || { answered: false, tried: diag };
  }
  res.json({ ok: true, stocks: out });
});

/*
 * POST /api/market/oneil/seed-industries
 *
 * Rebuild the industry map from the registers this tool has already frozen.
 *
 * The map is normally fed from r0 during a scan, and r0 is in-memory: every
 * deploy empties it, and a scan outside the screeners' run window has no rows
 * to record. So after a restart the map that group ranking depends on can sit
 * empty for a day while the answer is already on disk in R1. This mines it.
 *
 * POST rather than GET because it writes.
 */
router.post('/oneil/seed-industries', (req, res) => {
  const map = require('../sideA/industryMap');
  const out = map.seedFromRegisters();
  res.json({ ok: !out.error, ...out, map: map.stats() });
});

/*
 * GET /api/market/oneil/ratings?symbols=A,B,C
 *
 * Phase 4: U/D volume ratio, Accumulation/Distribution, and the workshop's
 * section 3 — the RS line at new high ground BEFORE price, and divergence.
 * One call for everything on screen; see the note on /oneil/stocks.
 */
router.get('/oneil/ratings', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .replace(/\s+/g, ',').split(',').filter(Boolean);
  if (!symbols.length) return res.json({ ok: false, error: 'no symbols' });
  try {
    const c = await oneil.loadRatings(symbols);
    res.json({ ok: true, stocks: c.stocks, fetchedAt: c.at || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/*
 * GET /api/market/oneil/canslim?symbols=A,B,C
 *
 * Everything the CANSLIM PANEL needs, in one call: the C and A tables from
 * EDGAR, and the weekly base. One request rather than three because the panel
 * opens all at once and three round trips would show it filling in in pieces.
 */
router.get('/oneil/canslim', async (req, res) => {
  const symbols = String(req.query.symbols || '')
    .replace(/\s+/g, ',').split(',').filter(Boolean);
  if (!symbols.length) return res.json({ ok: false, error: 'no symbols' });

  // `cards=1` — the whole screen at once, so it reads EDGAR's cache and never
  // walks it. The panel is one symbol and a deliberate tap, so it may.
  const cards = String(req.query.cards || '') === '1';
  // `parts` splits the two halves because they have nothing in common but the
  // panel that shows them: the base comes from price bars and answers in a
  // moment, C and A come from filings. Asked together, N waited on EDGAR for
  // no reason and the cards drew nothing until both were back.
  const parts = String(req.query.parts || 'all');
  const wantF = parts === 'all' || parts === 'fundamentals';
  const wantB = parts === 'all' || parts === 'bases';
  try {
    const [f, b] = await Promise.all([
      wantF ? (cards ? oneil.loadFundamentalsCached(symbols)
                     : oneil.loadFundamentals(symbols))
            : Promise.resolve({ stocks: undefined, at: 0 }),
      wantB ? oneil.loadBases(symbols) : Promise.resolve({ stocks: undefined, at: 0 }),
    ]);
    // FILL THE CACHE THE CARDS READ FROM, WITHOUT MAKING THEM WAIT FOR IT.
    // Not awaited, deliberately: the response below goes out with whatever
    // EDGAR has already given us, and the names it did not have are walked
    // one at a time afterwards so the next scan has them. While C and A lived
    // behind a popup, that popup was the only thing that ever walked EDGAR;
    // without this, moving them onto the card would leave the cache empty
    // forever.
    if (cards && wantF) oneil.warmFundamentals(symbols);
    res.json({
      ok: true,
      fundamentals: f.stocks,
      // Declared, so nobody reads the base numbers as daily ones. Every
      // length in there is in WEEKS.
      baseTimeframe: 'weekly',
      bases: b.stocks,
      fetchedAt: Math.max(f.at || 0, b.at || 0) || null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
