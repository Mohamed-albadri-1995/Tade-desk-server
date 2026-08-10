/*
 * Noticing that something fired, so a closed phone can be woken.
 *
 * The nine screeners write their fires to data/alert-fires.json and know
 * nothing about push — correctly, because a fire is a fact about the market and
 * delivery is a separate concern. So the alerts process watches the file.
 *
 * WHY WATCH A FILE RATHER THAN HAVE THE TOOLS CALL THIS. They already write the
 * file, and every one of them would need the URL of this process, a retry, and
 * a decision about what to do when it is down — nine copies of a delivery
 * mechanism, in the processes whose job is to be quick at 10:00. The file is
 * already the contract between them; this just reads it.
 *
 * WHY NOT PUSH THE CONTENT. The push carries nothing (see push.js). This
 * decides only THAT something is new. The service worker fetches what it was.
 */

const fs = require('fs');
const path = require('path');

const push = require('./push');
const store = require('./store');
const { toETDate } = require('../utils/time');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FIRES_FILE = process.env.ALERT_FIRES_FILE || path.join(DIR, 'alert-fires.json');

/*
 * What has already been pushed.
 *
 * In memory, and seeded from the file at startup rather than left empty. An
 * empty seed would push once for everything already on today's list the moment
 * this process restarts — and a deploy at 10:05 would re-announce the 10:00
 * trade as though it were happening now, which is the one wrong thing a trade
 * alert can do.
 */
let seen = new Set();
let timer = null;
let watcher = null;

/** A fire's identity. Time plus what it said — two tools can fire at once. */
function keyOf(f) {
  return `${f.at}|${f.toolId || ''}|${f.ruleId || ''}|${f.ticker || ''}|${f.detail || ''}`;
}

function todaysFires() {
  try {
    return store.recentFires(toETDate(Date.now()), 200) || [];
  } catch {
    return [];
  }
}

/** Everything on today's list counts as already delivered. */
function seed() {
  seen = new Set(todaysFires().map(keyOf));
  return seen.size;
}

/**
 * What is new since the last look.
 *
 * A fire older than the cutoff is ignored even if it is unseen. That covers the
 * case this would otherwise get wrong: a tool restarts and republishes, or the
 * day rolls over and yesterday's list is still on disk. An alert is worth
 * waking a phone for because it is happening NOW; ten minutes later it is
 * history, and history should not buzz.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

function newFires(now = Date.now()) {
  const out = [];
  for (const f of todaysFires()) {
    const k = keyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!f.at || now - f.at > MAX_AGE_MS) continue;   // real, but not news
    out.push(f);
  }
  return out;
}

/*
 * A fire is worth a push if it is a trade or a problem.
 *
 * The setups deliberately publish "nothing qualified" and "the filter removed
 * 34 cards" so that silence is never ambiguous — those are worth reading and
 * are not worth a notification on a locked phone. Waking someone for "nothing
 * happened" is how a person learns to swipe the notification away without
 * looking, and then misses the one that mattered.
 */
function worthWaking(f) {
  return f.level !== 'info';
}

async function check() {
  const fresh = newFires().filter(worthWaking);
  if (!fresh.length) return { pushed: 0 };
  try {
    const out = await push.notifyAll();
    if (out.subscribers) {
      console.log(`[Push] ${fresh.length} new fire(s) → woke ${out.sent}/${out.subscribers}`
        + `${out.dropped ? `, dropped ${out.dropped} dead` : ''}`);
    }
    return { pushed: fresh.length, ...out };
  } catch (err) {
    // Never throws outward. A push service being unreachable must not take down
    // the process that also serves the page you would read instead.
    console.error('[Push] could not send:', err.message);
    return { pushed: 0, error: err.message };
  }
}

/**
 * Watch the fires file.
 *
 * fs.watch fires more than once for a single write, and the store writes by
 * rename, so the events are debounced into one check. The interval is a
 * backstop: fs.watch does not survive every kind of replacement of a watched
 * path, and a missed alert is not an acceptable failure mode for the one thing
 * that has to arrive at a fixed minute.
 */
function start({ intervalMs = 20000 } = {}) {
  const n = seed();
  console.log(`[Push] watching ${FIRES_FILE} (${n} fire(s) already delivered today)`);

  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { check(); }, 400);
  };

  try {
    fs.mkdirSync(path.dirname(FIRES_FILE), { recursive: true });
    // The directory, not the file: the file is replaced by rename on every
    // write, and a watch on the old inode stops seeing anything after the first.
    watcher = fs.watch(path.dirname(FIRES_FILE), (_e, name) => {
      if (!name || name.startsWith(path.basename(FIRES_FILE))) bump();
    });
    watcher.unref?.();
  } catch (err) {
    console.error('[Push] cannot watch the fires file, polling only:', err.message);
  }

  const tick = setInterval(() => { check(); }, intervalMs);
  tick.unref?.();
  return { stop() { clearInterval(tick); clearTimeout(timer); watcher?.close(); } };
}

module.exports = { start, check, seed, newFires, keyOf, worthWaking, FIRES_FILE };
