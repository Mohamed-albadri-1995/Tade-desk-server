/*
 * A LOG LINE WITH NO DATE ON IT ANSWERS NOTHING.
 *
 * 2026-09-16. tool-T2 showed one restart and `pm2 logs tool-T2 --err --lines
 * 60` was asked why. It returned sixty identical lines:
 *
 *     256|tool-T | [TV Scanner] No screeners are due to run right now (2 …)
 *     256|tool-T | [TV Scanner] No screeners are due to run right now (2 …)
 *     …
 *
 * and not one of them carried a timestamp. So there was no way to tell whether
 * they came from before the restart, after it, or from the previous week — and
 * the fix that moved that very line off stderr was already deployed, meaning
 * every one of those sixty was almost certainly history.
 *
 * THE FILE PERSISTS. A pm2 log is an accumulated file that survives restarts,
 * deploys and reboots; `--lines 60` is its tail, not a window on the last
 * hour. Without a date the difference between "this just happened" and "this
 * is from Monday" is invisible, and both readings look equally reasonable.
 *
 * The question that matters about this desk is always "what happened at
 * 09:34". An undated line cannot be part of that answer. pm2 stamps every line
 * when a process is started with --time. The journal was already started that
 * way; the TOOLS — the processes that own the trading decisions, and the ones
 * whose restarts cost a whole day — were not.
 *
 * READ FROM THE SCRIPT TEXT, and that is the honest limit of it: a pm2 start
 * cannot be executed here. What is checked is that every process this script
 * launches is launched with the flag, so a new one added later cannot quietly
 * be the undated one.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');

/**
 * Every `pm2 start …` invocation in the script, as its full command — flags
 * continue over backslash-newlines, so a line-by-line read would miss them.
 */
function pm2Starts(src) {
  const joined = src.replace(/\\\n\s*/g, ' ');
  return joined.split('\n')
    .filter(l => l.includes('pm2 start ') && !l.trim().startsWith('#'));
}

const STARTS = pm2Starts(SRC);

describe('every process the deploy launches is launched with timestamps', () => {
  test('the script still starts processes at all', () => {
    expect(STARTS.length).toBeGreaterThanOrEqual(4);
  });

  /*
   * THE ONE THAT WAS BROKEN. None of these carried --time, which is why a
   * restart on the morning of the 16th could not be placed in the day.
   */
  test('no pm2 start is missing --time', () => {
    const undated = STARTS
      .filter(l => !/\s--time(\s|$)/.test(l))
      .map(l => (l.match(/--name "?([^"\s]+)/) || [, l.trim().slice(0, 50)])[1]);
    expect(undated).toEqual([]);
  });

  test('the tools in particular — they own the decisions', () => {
    const tool = STARTS.find(l => l.includes('--name "tool-${id}"'));
    expect(tool).toBeTruthy();
    expect(tool).toMatch(/\s--time(\s|$)/);
  });

  test('and the alerts app, which writes the session log', () => {
    const alerts = STARTS.find(l => l.includes('--name "alerts"'));
    expect(alerts).toBeTruthy();
    expect(alerts).toMatch(/\s--time(\s|$)/);
  });

  test('the archive too', () => {
    const arch = STARTS.find(l => l.includes('--name "archive"'));
    expect(arch).toBeTruthy();
    expect(arch).toMatch(/\s--time(\s|$)/);
  });

  test('and the scorers, when they are enabled', () => {
    const sc = STARTS.find(l => l.includes('--name "scorer-${id}"'));
    expect(sc).toBeTruthy();
    expect(sc).toMatch(/\s--time(\s|$)/);
  });

  /*
   * THE FLAG MUST REACH pm2, NOT THE SCRIPT BEING RUN. Everything after a bare
   * `--` is the child's own argv, so a --time placed there would be handed to
   * the Python scorer, which has no such option — the flag would look present
   * in review and do nothing.
   */
  test('--time goes to pm2, never past the -- separator', () => {
    for (const l of STARTS) {
      const sep = l.indexOf(' -- ');
      if (sep < 0) continue;
      expect(l.slice(sep).includes('--time')).toBe(false);
      expect(l.slice(0, sep)).toMatch(/\s--time(\s|$)/);
    }
  });

  /*
   * A FLAG ADDED TWICE IS A FLAG SOMEBODY ADDED WITHOUT LOOKING. Harmless to
   * pm2, but it is the shape of two people fixing the same thing, and the next
   * edit lands in the wrong one.
   */
  test('and only once per command', () => {
    for (const l of STARTS) {
      expect((l.match(/\s--time(?=\s|$)/g) || []).length).toBe(1);
    }
  });
});

describe('the parser sees whole commands, not lines', () => {
  /*
   * These invocations wrap over several lines with backslashes. A reader that
   * split on newlines would find `pm2 start …` with none of its flags and
   * report every one of them as undated — a test that fails for the wrong
   * reason teaches nothing, and one that PASSES for the wrong reason is worse.
   */
  test('a wrapped command is joined before it is read', () => {
    const wrapped = 'pm2 start x --name "y" \\\n      --time \\\n      --foo\n';
    expect(pm2Starts(wrapped)[0]).toMatch(/--time/);
  });

  test('a commented-out start is not counted', () => {
    expect(pm2Starts('# pm2 start old --name "z"\n')).toEqual([]);
  });

  test('the real script has more than one wrapped start', () => {
    const rawLines = SRC.split('\n').filter(l => l.includes('pm2 start '));
    // If none of them wrapped, the join above would be pointless and this
    // file would be testing a parser nothing needs.
    expect(rawLines.some(l => l.trimEnd().endsWith('\\'))).toBe(true);
  });
});
