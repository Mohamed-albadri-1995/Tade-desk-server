#!/usr/bin/env node
/*
 * EVERY SCREENER ON EVERY LIVE TOOL, MEASURED.
 *
 * The screeners live in each tool's own database, edited by hand from the
 * Screeners tab: created, switched off, rewritten. Nothing in the repo says
 * what a tool is running today, and nothing on the desk says whether what it
 * is running WORKS — a screener with a filter TradingView refuses looks, from
 * the outside, exactly like a screener whose setup did not occur today.
 *
 * So this asks every live tool, over HTTP, and has each tool do the checking
 * itself:
 *
 *     GET  /api/tool             is it paused? (a paused tool scans nothing, on purpose)
 *     GET  /api/scan/status      when it last scanned, how many cards, any error
 *     GET  /api/screeners        every definition, as stored
 *     POST /api/screeners/test   the TOOL validates the definition and runs it
 *                                live against TradingView — a count, or why not
 *
 * Then one table per tool and a PROBLEMS list. A definition the tool refuses
 * is the thing most worth finding: a hand edit that will be rejected on every
 * scan, for ever, producing nothing and saying nothing.
 *
 * AN ERROR IS NEVER A ZERO. "TradingView refused this" and "no stock matched"
 * are opposite facts and print differently, everywhere.
 *
 * IT CHANGES NOTHING. Every call is a read or a test-run that stores nothing.
 * Sleeping tools are skipped — the archive serves registers, not screeners.
 *
 *     node scripts/check-screeners.js
 *     node scripts/check-screeners.js --only T2
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** How stale a card list may be during the session before it is a finding. */
const STALE_MIN = 30;

/** Under this uptime a tool with no scan has simply not had one yet. */
const JUST_STARTED_SEC = 10 * 60;

/** Minutes since a timestamp, or null when there is none. */
function minsSince(ts, now = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.round((now - n) / 60000));
}

/** HH:MM in New York. */
function etNow(now = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
}

/** Is the screener's run window open at `hhmm`? No window means always. */
function windowOpen(s, hhmm) {
  if (!s.runFrom || !s.runTo) return true;
  return hhmm >= s.runFrom && hhmm < s.runTo;
}

/** A bounded fetch returning { status, json } — never throws. */
async function ask(url, init = {}, timeoutMs = 25000) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let json = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json, error: null };
  } catch (err) {
    return { status: null, json: null, error: err.message };
  }
}

/*
 * ONE TOOL, PROBED. Everything below is reduced to a plain object so the
 * judgement can be tested against fixtures rather than against a network.
 */
async function probeTool(tool, { base = `http://127.0.0.1:${tool.port}`, fetchJson = ask } = {}) {
  const out = { id: tool.id, name: tool.name, port: tool.port,
                reachable: false, paused: false, pausedReason: null,
                scan: null, screeners: [] };
  const ident = await fetchJson(`${base}/api/tool`);
  if (ident.error || !ident.json) {
    out.error = ident.error || `HTTP ${ident.status}`;
    return out;
  }
  out.reachable = true;
  out.paused = !!ident.json.paused;
  out.pausedReason = ident.json.pausedReason || null;

  // HOW LONG THE PROCESS HAS BEEN UP. A tool restarted a minute ago has an
  // empty card list and no scan by construction — the registry is in memory —
  // and the first run of this check, straight after a deploy, reported all six
  // tools as "never scanned, no cards". True, and a finding about nothing.
  const h = await fetchJson(`${base}/health`);
  out.uptimeSec = h.json && Number.isFinite(h.json.uptimeSec) ? h.json.uptimeSec : null;

  const st = await fetchJson(`${base}/api/scan/status`);
  out.scan = st.json ? {
    lastRun: st.json.lastRun || null,
    lastRowCount: Number.isFinite(st.json.lastRowCount) ? st.json.lastRowCount : null,
    error: st.json.error || null,
  } : null;

  const list = await fetchJson(`${base}/api/screeners`);
  const defs = (list.json && list.json.screeners) || [];
  for (const s of defs) {
    const row = { key: s.key, name: s.name, enabled: !!s.enabled,
                  labelOnly: !!s.labelOnly, mirrorOf: s.mirrorOf || null,
                  runFrom: s.runFrom || null, runTo: s.runTo || null,
                  filters: (s.filters || []).length,
                  valid: null, count: null, error: null, ms: null, sample: [] };
    if (row.enabled) {
      const t = await fetchJson(`${base}/api/screeners/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.name, filters: s.filters, sort: s.sort,
                               limit: Number.isFinite(s.limit) ? s.limit : 50 }),
      });
      if (t.error) {
        row.error = t.error;                         // never answered
      } else if (t.status === 400) {
        // THE TOOL REFUSED THE DEFINITION. Unknown field, unknown operator —
        // this screener is rejected on every scan and has been producing
        // nothing while looking like a screener that found nothing.
        row.valid = false;
        row.error = (t.json && t.json.error) || 'definition rejected';
      } else if (t.json && t.json.ok) {
        row.valid = true;
        row.count = Number(t.json.count) || 0;
        row.ms = t.json.ms || null;
        // The first names it matched — enough to tell a mirror that mirrors
        // from one that returns its base's list under another name.
        row.sample = (t.json.sample || []).map(x => String(x.ticker || '').toUpperCase())
          .filter(Boolean);
      } else {
        row.valid = true;                            // the definition passed
        row.error = (t.json && t.json.error) || `HTTP ${t.status}`;
      }
    }
    out.screeners.push(row);
  }
  return out;
}

/* ── the judgement, pure ─────────────────────────────────────────────────── */

/**
 * What is wrong with one probed tool, as sentences. Empty means nothing found.
 *
 * `hhmm` is the market clock the probe ran at; `now` the wall clock. Both are
 * passed in so a fixture can be judged as if it were 10:15 on a trading day.
 */
function problemsOf(t, { hhmm = etNow(), now = Date.now() } = {}) {
  const out = [];
  const say = (s) => out.push(`${t.id}: ${s}`);
  if (!t.reachable) { say(`did not answer (${t.error}) — is it running?`); return out; }
  if (t.paused) say(`is PAUSED${t.pausedReason ? ` — ${t.pausedReason}` : ''}. It scans nothing until resumed.`);

  const on = t.screeners.filter(s => s.enabled);
  if (!t.screeners.length) say('has NO screeners at all.');
  else if (!on.length) say(`every one of its ${t.screeners.length} screener(s) is switched off — it collects nothing.`);

  const byName = Object.fromEntries(t.screeners.map(s => [s.name, s]));
  for (const s of t.screeners) {
    if (s.mirrorOf && !byName[s.mirrorOf]) {
      say(`"${s.name}" mirrors "${s.mirrorOf}", which no longer exists.`);
    }
    /*
     * A MIRROR IS THE OPPOSITE SETUP. One that returns its base's own names is
     * the same screen twice under two labels — the pair then tests one side
     * twice and the direction question it exists for is never asked. Seen
     * once already on this desk (the oversold twin, tests/screeners.newScanners).
     * Judged on the names, not the count: two opposite screens can match seven
     * each; they cannot match the same seven.
     */
    const base = s.mirrorOf ? byName[s.mirrorOf] : null;
    if (s.enabled && base && base.enabled && s.sample.length && base.sample.length) {
      const shared = s.sample.filter(x => base.sample.includes(x)).sort();
      if (shared.length === s.sample.length && shared.length === base.sample.length) {
        say(`"${s.name}" returns the SAME names as "${base.name}" (${shared.slice(0, 5).join(', ')}`
          + `${shared.length > 5 ? ', …' : ''}) — it is not a mirror, it is the same screen twice.`);
      }
    }
    if (!s.enabled) continue;
    if (!s.filters) say(`"${s.name}" has no filters — it is the floor and nothing else.`);
    if (s.valid === false) {
      say(`"${s.name}" is REJECTED by the tool: ${s.error}. It has been producing nothing on every scan.`);
      continue;
    }
    if (s.error) { say(`"${s.name}" could not be run: ${s.error}`); continue; }
    if (s.count === 0 && windowOpen(s, hhmm)) {
      say(`"${s.name}" matches nothing right now, inside its window`
        + `${s.runFrom ? ` (${s.runFrom}–${s.runTo})` : ''}`
        + ` — run scripts/why-empty.js ${s.key} against this tool's database.`);
    }
  }

  const sc = t.scan;
  const session = hhmm >= '09:30' && hhmm < '16:00';
  /*
   * JUST STARTED IS NOT BROKEN. The card registry is in memory, so a tool
   * restarted by the deploy a minute ago has no scan and no cards until its
   * next scheduled scan matches something. Reported as a fact, not a problem.
   */
  const justStarted = t.uptimeSec !== null && t.uptimeSec !== undefined
    && t.uptimeSec < JUST_STARTED_SEC;
  if (sc) {
    if (sc.error) say(`the last scan FAILED: ${sc.error}`);
    const age = minsSince(sc.lastRun, now);
    if (age === null && !justStarted) say('has never completed a scan since it started.');
    else if (age !== null && session && age > STALE_MIN) {
      say(`the card list is ${age} minutes old during the session.`);
    }
    if (sc.lastRowCount === 0 && !t.paused && on.length && !justStarted) {
      say('the last scan produced NO cards — a setup on this tool has nothing to rank.');
    }
  }
  return out;
}

/* ── printing ────────────────────────────────────────────────────────────── */

function table(t, hhmm) {
  const lines = [];
  lines.push(`\n${t.id}  ${t.name}  :${t.port}${t.paused ? '   ⏸ PAUSED' : ''}`);
  if (!t.reachable) { lines.push(`   did not answer: ${t.error}`); return lines; }
  if (t.scan) {
    const age = minsSince(t.scan.lastRun);
    const up = t.uptimeSec === null || t.uptimeSec === undefined ? ''
      : ` · up ${t.uptimeSec < 120 ? `${t.uptimeSec}s` : `${Math.round(t.uptimeSec / 60)} min`}`;
    lines.push(`   last scan ${age === null ? (t.uptimeSec !== null && t.uptimeSec < JUST_STARTED_SEC
      ? 'not yet (just started)' : 'never') : `${age} min ago`}${up}`
      + ` · ${t.scan.lastRowCount === null ? '?' : t.scan.lastRowCount} cards`
      + `${t.scan.error ? ` · ERROR ${t.scan.error}` : ''}`);
  }
  if (!t.screeners.length) { lines.push('   (no screeners)'); return lines; }
  for (const s of t.screeners) {
    const win = s.runFrom ? `${s.runFrom}–${s.runTo}${windowOpen(s, hhmm) ? ' open' : ' shut'}` : 'all day';
    let live;
    if (!s.enabled) live = '—';
    else if (s.valid === false) live = `REJECTED: ${s.error}`;
    else if (s.error) live = `ERROR: ${s.error}`;
    else live = `${s.count} live`;
    lines.push(`   ${(s.enabled ? 'on ' : 'off').padEnd(4)}${s.name.padEnd(30)} ${win.padEnd(18)} ${live}`
      + `${s.labelOnly ? '  (label only)' : ''}${s.mirrorOf ? `  (mirror of ${s.mirrorOf})` : ''}`);
  }
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
  const tools = (reg.tools || []).filter(t => t.enabled !== false)
    .filter(t => !only || t.id === only);
  const asleep = (reg.tools || []).filter(t => t.enabled === false).map(t => t.id);
  const hhmm = etNow();
  console.log(`Checking ${tools.length} live tool(s) at ${hhmm} ET.`
    + (asleep.length ? ` Asleep, not checked: ${asleep.join(' ')}.` : ''));
  console.log('Each enabled screener is validated by its tool and run once against TradingView.');

  const problems = [];
  for (const tool of tools) {
    const t = await probeTool(tool);
    for (const l of table(t, hhmm)) console.log(l);
    problems.push(...problemsOf(t, { hhmm }));
  }
  console.log('');
  if (!problems.length) {
    console.log('PROBLEMS: none found. Every enabled screener is accepted by its tool and answers.');
  } else {
    console.log(`PROBLEMS (${problems.length}):`);
    for (const p of problems) console.log(`  • ${p}`);
  }
  console.log('\nScorers are off by config on every tool (_score is null by design); '
    + 'no setup ranks by reg_score, so nothing depends on them.');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('Failed:', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { probeTool, problemsOf, table, windowOpen, minsSince, STALE_MIN,
                   JUST_STARTED_SEC };
