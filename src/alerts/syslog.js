/*
 * THE SYSTEM LOG — EVERYTHING THAT HAPPENED, ONE LINE EACH, IN ORDER.
 *
 * Asked for as "Review like a log for you — a system log like Railway's".
 * Until now a failure was read from four places that never met: `pm2 logs`
 * in Termux for each process, the session log for decisions, the broker
 * ledger for orders, and the alert feed. Each was right about its own part
 * and none said what happened FIRST — which is usually the whole answer.
 *
 * This merges them into one stream:
 *
 *   desk      decisions (funnel, picks, what each order did), manager closes
 *             and errors, the broker's replies and fills, the 15:50 close
 *   <process> every pm2 process's own log lines — qp, alerts, tool-T1 …
 *   pm2       pm2's own lines: restarts, memory kills, exits
 *
 * Each line: { t (ms), src, level, msg, detail? }. Levels: error, warn, info,
 * debug. debug is the routine traffic (qp answering a health check, a manager
 * pass that held) — there, but hidden unless asked for.
 *
 * Read-only, and never throws: the page that shows this is opened because
 * something is wrong, so a reader that fails on a bad day is no reader.
 * Every source is injectable so each rule can be run in a test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const TAIL_BYTES = 512 * 1024;       // per log file — a day of any one process

const L = (t, src, level, msg, detail) => {
  const o = { t: Number(t) || 0, src, level, msg: String(msg) };
  if (detail) o.detail = String(detail);
  return o;
};
const num = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v)
  ? String(Math.round(v * 10 ** d) / 10 ** d) : '?');

/* ── the desk's own records ─────────────────────────────────────────────── */

function runLines(r) {
  const out = [];
  const f = r.funnel || {};
  const who = r.setup || r.setupId || 'setup';
  const tag = r.rehearsal ? 'REHEARSAL · ' : (r.dryRun ? 'dry run · ' : '');
  const took = r.ms != null ? ` in ${num(r.ms / 1000, 1)} s` : '';
  const funnel = `${f.cards ?? '?'} cards → ${f.evaluated ?? '?'} evaluated → `
    + `${f.signalled ?? '?'} signals → ${f.picked ?? (r.picks || []).length} picked`;
  if (!r.ok) {
    out.push(L(r.at, 'desk', 'error', `${tag}${who} decision on ${r.bar || '?'} FAILED${took}: `
      + `${r.error || 'no reason given'}`));
    return out;
  }
  const level = r.quiet || r.rehearsal || r.dryRun ? 'debug' : 'info';
  out.push(L(r.at, 'desk', level, `${tag}${who} decided on ${r.bar || '?'}${took} · ${funnel}`));
  const d = r.dropped || {};
  if ((d.stale || []).length) {
    out.push(L(r.at, 'desk', 'warn', `${who}: dropped as STALE (bar too old): ${d.stale.join(', ')}`));
  }
  if ((d.latched || []).length) {
    out.push(L(r.at, 'desk', 'info', `${who}: already alerted today: ${d.latched.join(', ')}`));
  }
  if (r.routing && r.routing.error) {
    out.push(L(r.at, 'desk', 'error', `${who}: routing — ${r.routing.error}`));
  }
  if (r.feed && r.feed.missing) {
    out.push(L(r.at, 'desk', 'warn', `${who}: no bars from ${r.feed.used || 'the feed'} for `
      + `${r.feed.missing.join(', ')}`));
  }
  for (const p of r.picks || []) {
    out.push(L(r.at, 'desk', level, `${who}: PICK ${p.ticker} ${p.side || ''} · entry ${num(p.entry)} `
      + `stop ${num(p.stop)} target ${num(p.target)}${p.shares ? ` · ${p.shares} sh` : ''}`));
    for (const o of p.orders || []) {
      const to = o.to || 'broker';
      if (o.sent) {
        out.push(L(r.at, 'desk', level, `${p.ticker}: order SENT to ${to} · ${o.qty ?? '?'} sh`
          + `${o.status ? ` · ${o.status}` : ''}${o.partial ? ' · partial size' : ''}`));
      } else if (o.error) {
        out.push(L(r.at, 'desk', 'error', `${p.ticker}: order to ${to} FAILED — ${o.error}`));
      } else {
        out.push(L(r.at, 'desk', 'warn', `${p.ticker}: order to ${to} NOT sent — ${o.skipped || 'no reason given'}`));
      }
    }
  }
  return out;
}

function passLines(p) {
  const out = [];
  for (const a of p.acted || []) {
    out.push(L(p.at, 'desk', a.sent ? 'info' : 'error',
      `manager: CLOSE ${a.symbol} — ${a.why || 'no reason given'}`
      + (a.sent ? ' · sent' : (a.alreadyFlat ? ' · already flat' : ' · NOT SENT'))));
  }
  const errs = (p.positions || []).filter(x => x.error);
  for (const x of errs) {
    out.push(L(p.at, 'desk', 'warn', `manager: could not check ${x.symbol} — ${x.error}`));
  }
  if (!(p.acted || []).length && !errs.length && (p.positions || []).length) {
    const held = p.positions.map(x => `${x.symbol}${x.stop != null ? ` stop ${num(x.stop)}` : ''}`
      + `${x.stopMoved ? ' (moved)' : ''}`).join(' · ');
    out.push(L(p.at, 'desk', 'debug', `manager: holding ${p.positions.length} — ${held}`));
  }
  return out;
}

function ledgerLine(o) {
  const t = o.at;
  const acct = o.broker || o.destination || 'broker';
  if (o.kind === 'intent') {
    return L(t, 'desk', 'debug', `about to send ${o.action || ''} ${o.symbol || ''} to ${acct}`);
  }
  if (o.kind === 'callback') {
    return L(t, 'broker', /reject|cancel|fail|error/i.test(`${o.status} ${o.message}`) ? 'warn' : 'info',
      `${o.symbol || '?'}: broker says ${o.status || '?'}${o.statusDescription ? ` (${o.statusDescription})` : ''}`
      + `${o.fillPrice ? ` · filled @ ${num(o.fillPrice)}` : ''}${o.message ? ` · ${o.message}` : ''}`);
  }
  if (o.kind === 'fill') {
    return L(t, 'broker', 'info', `${o.symbol || '?'}: fill confirmed @ ${num(o.fillPrice)}`
      + `${o.filledQty ? ` · ${o.filledQty} sh` : ''}`);
  }
  if (o.kind === 'flatten') {
    const what = `${o.symbol}: CLOSE to ${acct} (${o.source || 'unstated'})`;
    if (o.error) return L(t, 'desk', 'error', `${what} — ${o.error}`);
    if (!o.sent) return L(t, 'desk', 'warn', `${what} — not sent: ${o.skipped || '?'}`);
    return L(t, 'desk', 'info', `${what} — sent${o.status ? ` · ${o.status}` : ''}`);
  }
  // An entry order.
  const what = `${o.symbol}: ${String(o.signal || '').toUpperCase()} ${o.quantity ?? o.asked ?? '?'} sh `
    + `@ ${num(o.price)} stop ${num(o.stop)}${o.target ? ` target ${num(o.target)}` : ''} to ${acct}`;
  if (o.error) return L(t, 'desk', 'error', `ORDER ${what} — ${o.error}`);
  if (!o.sent) return L(t, 'desk', 'warn', `ORDER ${what} — not sent: ${o.skipped || '?'}`);
  return L(t, 'desk', 'info', `ORDER ${what} — sent${o.status ? ` · ${o.status}` : ''}`);
}

/* ── the processes' own logs ────────────────────────────────────────────── */

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?:?\s(.*)$/;

function levelOf(text) {
  if (/"(GET|HEAD|POST) [^"]*" 200\b/.test(text)) return 'debug';       // routine access
  if (/\b(ERROR|CRITICAL|FATAL|Traceback|Unhandled)\b|Error:|\bfailed\b|DID NOT START|exceeds --max-memory|exited with code \[[1-9]/i.test(text)) return 'error';
  if (/\bWARN(ING)?\b|\bwarn\b|stale|missing/i.test(text)) return 'warn';
  return 'info';
}

/** The last TAIL_BYTES of a file, from the first whole line. */
function tail(file, bytes = TAIL_BYTES) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const s = buf.toString('utf8');
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch { return ''; }
}

/** Parse one pm2 log file into lines; continuation lines join their parent. */
function parseLog(text, src) {
  const out = [];
  let last = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const m = STAMP.exec(raw);
    if (!m) {
      // A stack frame or a wrapped line: it belongs to the line above.
      if (last) last.detail = (last.detail ? `${last.detail}\n` : '') + raw.trimEnd();
      continue;
    }
    const [, y, mo, d, h, mi, s, rest] = m;
    // pm2 stamps in the box's own local time.
    const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
    const msg = rest.replace(/^PM2 log:\s*/, '');
    // A stack frame that carries its own stamp is still part of its error.
    if (last && last.t === t && /^\s*at\s|^\s*File "/.test(msg)) {
      last.detail = (last.detail ? `${last.detail}\n` : '') + msg.trimEnd();
      continue;
    }
    last = L(t, src, levelOf(msg), msg.trimEnd());
    out.push(last);
  }
  // A stack trace makes its line an error whatever its first words said.
  for (const l of out) if (l.detail && /\n?\s*at\s|Traceback/.test(l.detail) && l.level !== 'error') l.level = 'error';
  return out;
}

function pm2Dir() {
  return path.join(process.env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'logs');
}

function processLines(dir = pm2Dir()) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { lines: [], error: `no pm2 logs at ${dir}` }; }
  for (const f of names) {
    const m = /^(.+?)-(out|error)(?:-\d+)?\.log$/.exec(f);
    if (!m) continue;
    out.push(...parseLog(tail(path.join(dir, f)), m[1]));
  }
  // pm2's own log: restarts and memory kills.
  const daemon = path.join(path.dirname(dir), 'pm2.log');
  for (const l of parseLog(tail(daemon, 128 * 1024), 'pm2')) {
    if (/restarted|exited|Stopping|Starting execution|exceeds/i.test(l.msg)) {
      if (l.level === 'info' && /restarted|exited/i.test(l.msg)) l.level = 'warn';
      out.push(l);
    }
  }
  return { lines: out, error: null };
}

/* ── the whole stream ───────────────────────────────────────────────────── */

/**
 * @param {object} q  { date: 'YYYY-MM-DD' (ET), level: 'info', src, q, limit }
 */
function collect(q = {}, deps = {}) {
  const { toETDate } = require('../utils/time');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || '') ? q.date : toETDate(Date.now());
  const minLevel = Math.max(0, LEVELS.indexOf(q.level || 'info'));
  const limit = Math.min(Math.max(Number(q.limit) || 1500, 1), 10000);
  const notes = [];
  let lines = [];

  const safe = (what, fn) => {
    try { return fn(); } catch (e) { notes.push(`${what} could not be read: ${e.message}`); return []; }
  };
  const sessionLog = deps.sessionLog || require('../setups/sessionLog');
  lines.push(...safe('the decisions', () => sessionLog.runsOn(date).flatMap(runLines)));
  lines.push(...safe('the manager passes', () => sessionLog.passesOn(date).flatMap(passLines)));
  const ledger = deps.ledger || (() => require('../broker/signalstack').orders(date));
  lines.push(...safe('the broker ledger', () => ledger(date).map(ledgerLine)));
  // `desk: true` — the desk's own records only. Live's timeline refreshes
  // every few seconds near a decision, and reading every process's log file
  // that often is work a 1 GB box should not be doing for it.
  const procs = q.desk ? [] : safe('the process logs', () => {
    const r = (deps.processLines || processLines)();
    if (r.error) notes.push(r.error);
    return r.lines;
  });
  lines.push(...procs.filter(l => toETDate(l.t) === date));

  const sources = [...new Set(lines.map(l => l.src))].sort();
  const counts = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const l of lines) counts[l.level] = (counts[l.level] || 0) + 1;

  lines = lines.filter(l => LEVELS.indexOf(l.level) >= minLevel);
  if (q.src) lines = lines.filter(l => l.src === q.src);
  if (q.q) {
    const needle = String(q.q).toLowerCase();
    lines = lines.filter(l => `${l.src} ${l.msg} ${l.detail || ''}`.toLowerCase().includes(needle));
  }
  lines.sort((a, b) => a.t - b.t);
  const truncated = lines.length > limit;
  if (truncated) lines = lines.slice(-limit);
  return { ok: true, date, lines, sources, counts, truncated, notes };
}

module.exports = { collect, runLines, passLines, ledgerLine, parseLog, levelOf, processLines, LEVELS };
