/*
 * WHAT STAGE IS THIS TOOL AT — collecting, being studied, or trusted?
 *
 * Nine tools look identical on the landing page, and they are not: two have
 * earned their place, several have a fortnight of data and no verdict yet, and
 * two were rewritten this week and have nothing at all. Without that on the
 * screen every list reads with the same authority, and the newest screener's
 * candidates look exactly as trustworthy as the one that has been measured for
 * a year.
 *
 * THREE STAGES, and the middle one is the honest default:
 *
 *   collecting  fewer than 15 frozen register days. There is no question to
 *               ask yet; it is filling the archive.
 *   study       15 days or more. Enough to look at, not enough to believe.
 *   valid       a decision somebody made. Never reached by counting days —
 *               time does not make a screener good, and a tool that promoted
 *               itself on its fifteenth morning would be doing exactly that.
 *
 * So the day count only ever separates the first two. `valid` is set by hand
 * and so is any other override: the count is a starting point for a tool
 * nobody has judged, not a replacement for judging it.
 *
 * WHERE IT IS STORED. The committed default is in tools.config.json, so a
 * fresh box starts with the same verdicts. The override is in
 * data/tool-stages.json, which is gitignored — same reasoning as app-urls.json:
 * a judgement belongs to whoever runs this box, and an edit to a tracked file
 * is an edit that makes the next `git pull` refuse to run.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');

const FILE = process.env.TOOL_STAGES_FILE
  || path.join(__dirname, '..', 'data', 'tool-stages.json');

/** Ordered least to most established. The order is the progression. */
const STAGES = ['collecting', 'study', 'valid'];

const LABEL = {
  collecting: 'collecting data',
  study: 'under study',
  valid: 'validated',
};

/** How many frozen days before a tool has something worth looking at. */
const STUDY_AFTER_DAYS = 15;

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (raw && typeof raw === 'object') ? raw : {};
  } catch {
    return {};                            // absent or unreadable is "no overrides"
  }
}

function write(map) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(map, null, 2) + '\n');
}

/** The committed verdict for a tool, or null when nobody has recorded one. */
function declared(toolId) {
  const t = (config.tools || []).find(x => x.id === toolId);
  const s = t && String(t.stage || '').toLowerCase();
  return STAGES.includes(s) ? s : null;
}

/**
 * `{ stage, label, source, days }` for one tool.
 *
 * `source` says WHY, because a stage with no reason attached is a label
 * somebody will argue with: 'override' (set here), 'declared' (committed in
 * the registry), or 'days' (nobody has judged it, so the archive answers).
 */
function stageOf(toolId, days = null) {
  const over = read()[toolId];
  if (STAGES.includes(over)) {
    return { stage: over, label: LABEL[over], source: 'override', days };
  }
  const dec = declared(toolId);
  if (dec) return { stage: dec, label: LABEL[dec], source: 'declared', days };
  // Counting can only ever say "too early to look" or "old enough to look".
  // It cannot say `valid`; see the note at the top.
  const n = Number(days);
  const stage = Number.isFinite(n) && n >= STUDY_AFTER_DAYS ? 'study' : 'collecting';
  return { stage, label: LABEL[stage], source: 'days', days: Number.isFinite(n) ? n : null };
}

/**
 * Move a tool to a stage, or back to the default.
 *
 * `null` REMOVES the override rather than storing one, so "put it back to
 * whatever the rule says" is expressible. Storing the current answer instead
 * would freeze a tool at `collecting` on the day it was reset.
 */
function setStage(toolId, stage) {
  const id = String(toolId || '').trim().toUpperCase();
  if (!(config.tools || []).some(t => t.id === id)) {
    throw new Error(`unknown tool ${id || '(blank)'}`);
  }
  const map = read();
  if (stage === null || stage === undefined || stage === '' || stage === 'auto') {
    delete map[id];
  } else {
    const s = String(stage).toLowerCase();
    if (!STAGES.includes(s)) {
      throw new Error(`unknown stage ${JSON.stringify(stage)} — `
        + `one of ${STAGES.join(', ')}, or 'auto' for the default`);
    }
    map[id] = s;
  }
  write(map);
  return stageOf(id);
}

/**
 * Every tool with its stage. `daysByTool` is supplied by the caller — this
 * module does not read any database, so it stays usable from the landing page,
 * from a tool that only knows its own archive, and from a test.
 */
function all(daysByTool = {}) {
  return (config.tools || []).map(t => ({
    id: t.id,
    name: t.name,
    ...stageOf(t.id, daysByTool[t.id] ?? null),
  }));
}

module.exports = { STAGES, LABEL, STUDY_AFTER_DAYS, FILE, stageOf, setStage, all, declared };
