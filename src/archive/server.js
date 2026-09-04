/*
 * THE ARCHIVE: stopped tools still answer.
 *
 * WHY THIS EXISTS. qp does not read the tools' databases — it reads the tools,
 * over HTTP. `quant-platform/chart/screener.py` builds its source list from
 * tools.config.json and calls `/api/warehouse/*` on each tool's port. So a
 * stopped tool is not a quiet tool, it is an ABSENT one: every chart, every
 * print and every backtest of everything it ever collected goes with it.
 *
 * On a 912 MB box that made "run fewer tools" a choice between memory and
 * history. This is the third option. One read-only process opens each archived
 * tool's SQLite file and serves the same routes on that tool's OWN port, so
 * from qp's side nothing has changed at all — same URL, same JSON, same
 * register names. It cannot tell the difference, and it does not need to.
 *
 * ~45 MB once, against ~290 MB for five tools and their scorers.
 *
 * WHAT IT DELIBERATELY IS NOT. No scanner, no scheduler, no pipeline, no
 * scorer, no alerts, and no write route of any kind. An archive that could be
 * written to is not an archive; it is a tool with the lights off, and the
 * difference matters the first time something POSTs to it by habit.
 *
 * ── HOW IT SERVES SEVERAL DATABASES FROM ONE PROCESS ──────────────────────
 *
 * `src/db/index.js` opens ONE database, at `config.dbPath`, at require time.
 * Every warehouse reader is built on that single handle. Rather than
 * reimplement `warehouse/registers.js` against a second handle — which would
 * duplicate signal backfilling, the seenAt arithmetic and the register shaping,
 * and let the copy drift from the original the first time either changed —
 * each tool gets its own ISOLATED INSTANCE of that module tree: set DB_PATH,
 * drop the relevant entries from the require cache, require again, keep the
 * result.
 *
 * That is unusual enough to be worth saying plainly: it is deliberate, it is
 * confined to this file, and it is what makes the archive's answers identical
 * to a live tool's by construction rather than by review.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** The tools marked `archive: true`, with the DB path the deploy gives them. */
function archived() {
  const reg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools.config.json'), 'utf8'));
  return (reg.tools || []).filter(t => t.archive).map(t => ({
    id: t.id,
    name: t.name,
    port: t.port,
    // THE SAME RULE THE DEPLOY USES (deploy-tools.sh): T1 keeps the original
    // path, everything else is data/<lowercase id>.db. Written twice is a risk;
    // written differently would be a silent one — the archive would open a file
    // that does not exist and report an empty history for a tool with years in
    // it, which reads exactly like a tool that never found anything.
    db: t.id === 'T1'
      ? path.join(ROOT, 'data', 'tradedesk.db')
      : path.join(ROOT, 'data', `${t.id.toLowerCase()}.db`),
  }));
}

/*
 * One tool's warehouse readers, bound to that tool's own database.
 *
 * The cache surgery is confined to this function. `config` is re-read because
 * it resolves dbPath from the environment at load; `db` because it opens the
 * file at load; `registers` and its dependencies because they captured the old
 * handle. Anything not listed keeps the one shared instance, which is correct —
 * date helpers and relation maths are the same for every tool.
 */
function readersFor(dbFile) {
  const drop = [
    '../config', '../db', '../db/index',
    '../warehouse/registers', '../r0/registry',
    '../sideD/engine', '../sideB/relations',
  ];
  const saved = process.env.DB_PATH;
  process.env.DB_PATH = dbFile;
  // READ-ONLY IS SET ON THE HANDLE, not merely intended. better-sqlite3 refuses
  // writes outright, so a stray write is an exception here rather than a
  // corrupted archive discovered months later.
  process.env.DB_READONLY = '1';
  try {
    for (const m of drop) {
      try { delete require.cache[require.resolve(m)]; } catch { /* not loaded */ }
    }
    // eslint-disable-next-line global-require
    const registers = require('../warehouse/registers');
    return {
      getRegisterData: registers.getRegisterData,
      getAvailableDates: registers.getAvailableDates,
    };
  } finally {
    if (saved === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = saved;
    delete process.env.DB_READONLY;
    // Leave the cache clean so the NEXT tool loads its own copy rather than
    // inheriting this one's handle — the bug this whole arrangement exists to
    // avoid, and the one that would be hardest to see: every archived tool
    // would answer with the first one's data, correctly shaped and wrong.
    for (const m of drop) {
      try { delete require.cache[require.resolve(m)]; } catch { /* fine */ }
    }
  }
}

const VALID = ['R0', 'R1', 'R2', 'R3A', 'R3B', 'R4A', 'R4B', 'Shortlist'];
const MAP = { r0: 'R0', r1: 'R1', r2: 'R2', r3a: 'R3A', r3b: 'R3B',
              r4a: 'R4A', r4b: 'R4B', shortlist: 'Shortlist' };
const normalize = r => MAP[String(r).toLowerCase()] || r;

/** One archived tool's app: the GET half of /api/warehouse, and nothing else. */
function appFor(tool, readers) {
  const app = express();

  /*
   * EVERY WRITE REFUSED, BY NAME, BEFORE ROUTING.
   *
   * Not "there is no POST route so it 404s" — a 404 says "no such thing here",
   * which invites a retry against a different path. 405 with a sentence says
   * what this process is, which is the answer to the question actually being
   * asked.
   */
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return res.status(405).json({
      ok: false,
      error: `${tool.id} is ARCHIVED and read-only — it serves its stored `
        + 'registers and accepts no writes. Nothing is scanning here, so there '
        + 'is nothing for a write to change.',
      archived: true,
      tool: tool.id,
    });
  });

  // The same shape a live tool's /health returns, plus the fact that matters:
  // this one is an archive. A monitor that only checks for 200 keeps working;
  // one that reads the body learns something true.
  app.get('/health', (req, res) => {
    res.json({ ok: true, archived: true, tool: tool.id, name: tool.name,
               scanning: false,
               note: 'read-only archive — stored registers only, no scanning' });
  });

  const w = express.Router();

  w.get('/available-dates', (req, res) => {
    const reg = req.query.register ? normalize(req.query.register) : 'R1';
    if (!VALID.includes(reg)) return res.status(400).json({ error: 'Invalid register' });
    res.json(readers.getAvailableDates(reg));
  });

  w.get('/:register/latest', (req, res) => {
    const register = normalize(req.params.register);
    if (!VALID.includes(register)) return res.status(400).json({ error: 'Invalid register' });
    const data = readers.getRegisterData(register, null);
    if (data === null) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  w.get('/:register/:date', (req, res) => {
    const register = normalize(req.params.register);
    if (!VALID.includes(register)) return res.status(400).json({ error: 'Invalid register' });
    const data = readers.getRegisterData(register, req.params.date);
    if (data === null) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  app.use('/api/warehouse', w);

  // Anything else, answered rather than left to a default 404 page: someone
  // opening this port in a browser expecting the tool's UI deserves to be told
  // where it went.
  app.use((req, res) => {
    res.status(404).json({
      ok: false, archived: true, tool: tool.id,
      error: `${tool.id} (${tool.name}) is archived. Its stored registers are `
        + 'served at /api/warehouse/* on this port; the tool itself is not '
        + 'running and its pages are not available.',
    });
  });

  return app;
}

function start() {
  const tools = archived();
  if (!tools.length) {
    console.log('[Archive] no tool is marked archive:true — nothing to serve.');
    return [];
  }
  const servers = [];
  for (const tool of tools) {
    // A MISSING FILE IS SAID, NOT SERVED AS EMPTY. An archive answering "no
    // dates" for a database that is not there is indistinguishable from a tool
    // that collected nothing, and that is precisely the confusion this desk has
    // spent a week on.
    if (!fs.existsSync(tool.db)) {
      console.error(`[Archive] ${tool.id}: no database at ${tool.db} — NOT `
        + 'serving this one. qp will report no history for it.');
      continue;
    }
    let readers;
    try {
      readers = readersFor(tool.db);
    } catch (err) {
      console.error(`[Archive] ${tool.id}: could not open ${tool.db}:`,
        err.stack || err.message);
      continue;
    }
    const app = appFor(tool, readers);
    const server = app.listen(tool.port, () => {
      console.log(`[Archive] ${tool.id} (${tool.name}) read-only on :${tool.port}`
        + ` from ${path.basename(tool.db)}`);
    });
    // ONE PORT IN USE MUST NOT TAKE THE OTHERS DOWN. If the live tool is still
    // running on that port, that is a configuration overlap worth reporting —
    // and the remaining archives are still worth serving.
    server.on('error', (err) => {
      console.error(`[Archive] ${tool.id}: cannot listen on :${tool.port} — `
        + `${err.message}. Is the live tool still running there?`);
    });
    servers.push(server);
  }
  return servers;
}

// Same guard as the tools and the alerts desk: requiring this in a test must
// not take a port or leave a handle open behind the assertions.
if (require.main === module) start();

module.exports = { start, archived, readersFor, appFor };
