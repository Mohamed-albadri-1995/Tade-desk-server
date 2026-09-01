const { v4: uuidv4 } = require('uuid');
const { runAllScanners } = require('./sideA/tvScanner');
const { mergeScannersIntoR0 } = require('./sideA/merge');
const { applyDerivedFields } = require('./sideB/calculations');
const { fetchNewsForTicker } = require('./sideC/news');
const { combineCatalyst } = require('./sideC/technical');
const { buildMarketSnapshot, enrichR0WithContext } = require('./sideD/engine');
const db = require('./db');
const r0 = require('./r0/registry');
const { syncShortlistToR0 } = require('./sideF/shortlist');
const { refreshStaleInR0 } = require('./sideG/staleFetch');
const { toETDate } = require('./utils/time');
const { scoreAllRows } = require('./sideE/score');

const config = require('./config');

// The tool whose screeners define CANSLIM membership. Everything else reads.
const CANSLIM_TOOL = 'T8';

// The screener that decides WHO is a growth stock, as opposed to which of them
// did something today. Membership has to come from the slow half or it stops
// meaning anything: a company is not a growth company on Tuesday and an
// ordinary one on Wednesday because it happened not to print a new high.
const CANSLIM_UNIVERSE = 'canslim-universe';

/*
 * Which side of each rule every stock was on, last pass.
 *
 * Module state rather than the database: it is worthless after a restart by
 * design. A remembered side from before a restart would be compared against a
 * price fetched now, and the gap between them could be an hour — which would
 * report a crossing that may never have happened. Losing it costs one missed
 * alert per stock; keeping it would invent them.
 */
const alertPrev = {};

const scanStatus = {
  lastRun: null,
  lastRefresh: null,
  lastRowCount: 0,
  running: false,
  error: null,
  lastReport: null,
};

function stageWrap(report, key, fn) {
  return async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      report.stages[key] = { ok: true, duration: Date.now() - t0, ...result };
    } catch (err) {
      report.stages[key] = { ok: false, duration: Date.now() - t0, error: err.message };
      throw err;
    }
  };
}

function stageWrapSoft(report, key, fn) {
  return async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      report.stages[key] = { ok: true, duration: Date.now() - t0, ...result };
    } catch (err) {
      report.stages[key] = { ok: false, duration: Date.now() - t0, error: err.message };
      console.error(`[Pipeline] ${key} failed (non-fatal):`, err.message);
    }
  };
}

async function runFullScan() {
  // PAUSED MEANS PAUSED, and the guard lives HERE rather than in the scheduler
  // because there are two ways in — the cron job and the Run-scan button — and
  // a pause that only stopped one of them would be a pause you could not
  // trust. This is the single door both go through.
  //
  // It stops NEW scanning and nothing else: every card, register, shortlist
  // and backtest the tool has already produced is untouched and still opens.
  const identity = require('./sideA/toolIdentity');
  if (identity.isPaused()) {
    const st = identity.pauseState();
    console.log('[Pipeline] Tool is paused — no scan');
    return { rowsProcessed: 0, ts: Date.now(), paused: true,
             pausedAt: st && st.at, pausedReason: st && st.reason };
  }
  if (scanStatus.running) {
    console.log('[Pipeline] Scan already running, skipping');
    return { rowsProcessed: 0, ts: Date.now() };
  }
  scanStatus.running = true;
  scanStatus.error = null;

  const report = {
    scanId: uuidv4(),
    startedAt: Date.now(),
    completedAt: null,
    ok: false,
    stages: {},
  };

  try {
    console.log('[Pipeline] Starting full scan...');

    // Day-boundary guard: if r0 has any rows from a previous date, flush before scanning.
    // This is the primary cleanup mechanism — more reliable than the midnight cron alone.
    const today = toETDate(Date.now());
    const hasPreviousDay = r0.getAll().some(row => row.date !== today);
    if (hasPreviousDay) {
      console.log('[Pipeline] Day boundary detected — flushing r0');
      r0.clearAll();
      // …and the alert memory with it. Yesterday's close against this
      // morning's pre-market price is a gap, not a crossing.
      for (const k of Object.keys(alertPrev)) delete alertPrev[k];
    }

    // Side A: TradingView Scanners (fatal)
    let merged;
    let labelResults = {};
    await stageWrap(report, 'sideA', async () => {
      const { candidates, labels } = await runAllScanners();
      labelResults = labels;
      /*
       * THE NEWS GATE, BEFORE THE MERGE.
       *
       * The unexplained-move screener's premise is that nothing explains the
       * move, and TradingView has no news column — so what comes back is every
       * 15% mover, most of which moved for a reason. Filtering that on the
       * setup would be too late: the whole unfiltered list would already be in
       * r0, frozen into R1 the next morning, and in the training data. The full
       * list must not reach the warehouse, so the test runs here.
       *
       * Non-fatal by construction: a gate that throws leaves the candidates
       * untouched rather than emptying the scan, because a scan that silently
       * returns nothing looks exactly like a quiet market.
       */
      let gated = candidates;
      try {
        const newsGate = require('./sideA/preR0');
        const store = require('./sideA/screenerStore');
        const res = await newsGate.apply(candidates, store.list({ enabledOnly: true }));
        gated = res.candidates;
        report.newsGate = res.report;
      } catch (err) {
        console.warn('[News gate] skipped:', err.message);
      }
      merged = mergeScannersIntoR0(gated);
      return { rowCount: merged.length, labelLists: Object.keys(labels).length,
               newsGate: report.newsGate || null };
    })();

    // Side B: Internal Calculations (fatal)
    let withDerived;
    await stageWrap(report, 'sideB', async () => {
      withDerived = applyDerivedFields(merged);
      return { rowCount: withDerived.length };
    })();

    // CANSLIM cross-tag (non-fatal). The tool that runs the CANSLIM screeners
    // publishes its matches; every tool reads that list and tags any of its own
    // candidates that appear on it. A label only — nothing here changes which
    // stocks were found, so one tool still cannot influence another's results.
    await stageWrapSoft(report, 'canslim', async () => {
      const canslim = require('./sideA/canslim');
      if (config.toolId === CANSLIM_TOOL) {
        // From the universe screener alone. Reading it off the cards instead —
        // which is what this did — meant a name only joined on a day it broke
        // out on volume, so the list tracked breakouts and called them growth.
        const store = require('./sideA/screenerStore');
        const universe = store.list({ enabledOnly: true })
          .find(s => s.key === CANSLIM_UNIVERSE);
        const matched = universe
          ? (labelResults[universe.name] || []).map(r => r.ticker)
          : [];
        // No universe screener, or it did not run in this scan: leave the list
        // exactly as it was. Recording an empty scan would expire every member
        // ninety days later on the strength of one skipped run.
        if (!matched.length) {
          const held = canslim.currentMembers().size;
          canslim.tagRows(withDerived);
          return { published: 0, members: held, skipped: universe ? 'not scanned' : 'no universe screener' };
        }
        const res = canslim.recordMembers(matched);
        canslim.tagRows(withDerived);
        return { published: matched.length, members: res.total, expired: res.expired };
      }
      const { tagged, memberCount } = canslim.tagRows(withDerived);
      return { tagged, memberCount };
    })();

    /*
     * Alerts (non-fatal).
     *
     * After Side B, because the rules compare price against levels that Side B
     * derives, and BEFORE scoring, because an alert is about what the tape did
     * and must not wait on a model that is allowed to be down.
     *
     * Evaluated on the merged rows for THIS tool only — a rule scoped to T2 is
     * not this tool's business. The previous side per (rule, ticker) lives in
     * module state and is cleared at the day boundary along with r0, so a
     * crossing is never measured against yesterday.
     */
    await stageWrapSoft(report, 'alerts', async () => {
      const engine = require('./alerts/engine');
      const alertStore = require('./alerts/store');
      const rules = alertStore.listRules();
      if (!rules.length) return { rules: 0, fired: 0 };
      const fires = engine.evaluate({
        rules, rows: withDerived, toolId: config.toolId, prev: alertPrev, date: today,
      });
      if (fires.length) {
        alertStore.publishFires(fires, today);
        console.log(`[Alerts] ${fires.length} fired: `
          + fires.map(f => `${f.ticker} ${f.rule}`).join(', '));
      }
      return { rules: rules.length, fired: fires.length, watched: Object.keys(alertPrev).length };
    })();

    // Side D: Market Context (non-fatal)
    let withContext = withDerived;
    await stageWrapSoft(report, 'sideD', async () => {
      await buildMarketSnapshot();
      withContext = enrichR0WithContext(withDerived);
      return { rowCount: withContext.length };
    })();

    // Side E: Live scoring via Python Flask service (non-fatal — null scores if service down)
    let withScores = withContext;
    await stageWrapSoft(report, 'sideE', async () => {
      // Preserve user-set bias and the last known catalyst from previous r0
      // state before scoring — news (Side C) runs after scoring, so without
      // this the catalyst feature and catalyst-driven auto-bias would always
      // be empty at score time.
      const toScore = withContext.map(row => {
        const prev = r0.getRow(row.ticker);
        const carried = { ...row };
        if (prev?.bias && prev.bias !== 'auto') carried.bias = prev.bias;
        if (prev?.catalyst) carried.catalyst = prev.catalyst;
        return carried;
      });
      withScores = await scoreAllRows(toScore);
      const scored = withScores.filter(r => r._score !== null).length;
      const { checkScorer } = require('./sideE/score');
      const scorerAvailable = await checkScorer();
      const scorerNote = !scorerAvailable
        ? 'Python scorer service is offline or reports ready:false — run `pm2 restart scorer` (or full deploy.sh) and check /api/analysis/status'
        : scored === 0 && withScores.length > 0
        ? 'Scorer online but returned no scores — model may not be trained. Retrain via the Analysis tab.'
        : null;
      return { rowCount: withScores.length, scored, scorerAvailable, note: scorerNote };
    })();
    if (!report.stages.sideE?.ok) {
      withScores = withContext.map(row => ({ ...row, _score: null }));
    }

    // Mark existing rows stale, then write live scan results
    r0.markAllStale();
    r0.upsertRows(withScores);

    // Side G: Refresh stale tickers with fresh TV quotes (non-fatal)
    await stageWrapSoft(report, 'sideG', async () => {
      return await refreshStaleInR0();
    })();

    // Side C: News & Catalyst for all live tickers (non-fatal)
    await stageWrapSoft(report, 'sideC', async () => {
      const liveRows = r0.getAll().filter(r => r.liveNow);
      const results = await Promise.allSettled(
        // tvSymbol is the exchange-qualified form (NASDAQ:AAPL) TradingView's
        // headline endpoint requires; a bare ticker gets a 400 back.
        liveRows.map(row => fetchNewsForTicker(row.ticker, row.stock && row.stock.tvSymbol).then(({ news, catalyst }) => {
          r0.updateNews(row.ticker, news, combineCatalyst(catalyst, row.stock));
        }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      return { rowCount: liveRows.length, failed };
    })();

    // Side F: Restore inShortlist flags from DB (non-fatal)
    await stageWrapSoft(report, 'sideF', async () => {
      syncShortlistToR0();
      // Then mark anything ANY tool has shortlisted. A name three tools picked
      // independently is a different proposition from one that appeared on a
      // single list, and that is worth seeing on the card rather than by
      // opening nine tabs. A view only — inShortlist, which the model reads,
      // stays this tool's own decision.
      const globalShortlist = require('./sideF/globalShortlist');
      const { tagged, memberCount } = globalShortlist.tagRows(r0.getAll(), today);
      return { globalTagged: tagged, globalMembers: memberCount };
    })();

    // r0 summary
    const allRows = r0.getAll();
    report.r0Summary = {
      total: allRows.length,
      liveNow: allRows.filter(r => r.liveNow).length,
      stale: allRows.filter(r => !r.liveNow).length,
      inShortlist: allRows.filter(r => r.inShortlist).length,
    };

    report.ok = true;
    report.completedAt = Date.now();

    // Checkpoint r0 to DB so a mid-day server restart can restore state
    try {
      db.prepare(
        'INSERT OR REPLACE INTO r0_checkpoint (id, date, data, saved_at) VALUES (1, ?, ?, ?)'
      ).run(today, JSON.stringify(r0.serialize()), report.completedAt);
    } catch (cpErr) {
      console.warn('[Pipeline] Checkpoint save failed:', cpErr.message);
    }

    scanStatus.lastRun = report.completedAt;
    scanStatus.lastRowCount = withScores.length;
    scanStatus.lastReport = report;

    console.log('[Pipeline] Scan complete:', withScores.length, 'live,', report.r0Summary.stale, 'stale');
    return { rowsProcessed: withScores.length, ts: scanStatus.lastRun };
  } catch (err) {
    report.completedAt = Date.now();
    report.ok = false;
    scanStatus.error = err.message;
    scanStatus.lastReport = report;
    console.error('[Pipeline] Scan error:', err.message);
    throw err;
  } finally {
    scanStatus.running = false;
  }
}

/**
 * Re-quote every card on screen without looking for new ones.
 *
 * Run windows separate two things that used to be one. Discovery is what a
 * window gates: after 13:00 a morning screener should stop ADDING candidates.
 * Refresh is not gated by anything — a card found at 09:40 is still on screen
 * at 15:00, still being watched, and its price, VWAP, distance to each moving
 * average and every relational tag have to keep up with the tape.
 *
 * Deliberately narrow: quotes and everything derived from them. No scanners, no
 * news, no re-scoring. That keeps it cheap enough to run every few minutes (one
 * batched TradingView call for the whole registry), and it keeps the score a
 * card was given at discovery from drifting underneath the trader.
 */
async function runRefreshOnly() {
  // A paused tool does not re-quote either. Refreshing prices on a paused
  // tool's rows would leave the register moving while the tool that built it
  // is stopped — a page that looks live and is not.
  if (require('./sideA/toolIdentity').isPaused()) {
    return { refreshed: 0, skipped: 'tool is paused' };
  }
  if (scanStatus.running) return { refreshed: 0, skipped: 'scan in progress' };
  scanStatus.running = true;
  try {
    const { refreshAllInR0 } = require('./sideG/staleFetch');
    const result = await refreshAllInR0();
    scanStatus.lastRefresh = Date.now();
    return result;
  } catch (err) {
    console.error('[Pipeline] Refresh error:', err.message);
    return { refreshed: 0, error: err.message };
  } finally {
    scanStatus.running = false;
  }
}

function getScanStatus() {
  const identity = require('./sideA/toolIdentity');
  const paused = identity.pauseState();
  return {
    // On the status endpoint, so anything asking "why is this tool quiet?"
    // gets the answer in the same call rather than concluding it is broken.
    paused: !!paused,
    pausedAt: paused ? paused.at : null,
    pausedReason: paused ? paused.reason : null,
    lastRun: scanStatus.lastRun,
    lastRowCount: scanStatus.lastRowCount,
    running: scanStatus.running,
    error: scanStatus.error,
    lastReport: scanStatus.lastReport,
    lastRefresh: scanStatus.lastRefresh,
  };
}

module.exports = { runFullScan, runRefreshOnly, getScanStatus };
