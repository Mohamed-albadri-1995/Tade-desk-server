/*
 * THE MEMORY CEILING TRIPPED IN ORDINARY USE, WHICH IS A RESTART LOOP.
 *
 * 2026-09-16, `pm2 list`:
 *
 *     | 240 | tool-T2  | fork | 292 | online | 103.4mb |
 *     | 242 | tool-T7  | fork |  87 | online |  51.8mb |
 *     | everything else       |   0 | online |         |
 *
 * 292 restarts in one morning, against 0 for every other tool, and no stack
 * trace anywhere: `pm2 logs tool-T2 --err --lines 60` held sixty lines of
 * "[TV Scanner] No screeners are due to run right now" and nothing else.
 *
 * Because a --max-memory-restart kill is NOT A CRASH. pm2 stops the process
 * and starts a new one, and neither step writes a line to either log. The only
 * trace it leaves anywhere is a counter in a column of `pm2 list`.
 *
 * One ceiling, 140M, was applied to every tool with the note "tools sit at
 * ~60". That was true of the tools it was measured on. T2 runs the TradingView
 * scanner over 39 tickers with its own model and was resident at 103 MB, so it
 * reached 140 in the middle of an ordinary scan — the exact thing the comment
 * four lines above it warns against: "a limit that trips in normal use is a
 * restart loop, which is worse than no limit."
 *
 * AND IT COST A TRADING DAY. A setup's decision is scheduled inside the tool
 * that owns it; the 09:35 OR+VWAP setup is owned by T2. At 09:34 T2 was
 * restarting, so the decision was never taken — and no line was written to the
 * session log, because the process that writes the line is the one that died.
 *
 * THE FUNCTION IS EXECUTED HERE, NOT GREPPED FOR. A substring search cannot
 * verify behaviour: `case` fallthrough, an unquoted expansion or a broken
 * indirect reference all leave the text looking exactly right while the tool
 * starts on the wrong number. bash runs it and the answers are checked.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'deploy-tools.sh'), 'utf8');

/** The function itself, lifted out of the script and run for real. */
const FN = (SRC.match(/^tool_max_mem\(\) \{[\s\S]*?^\}/m) || [''])[0];

function memFor(id, env = {}) {
  return execFileSync('bash', ['-c',
    `TOOL_MAX_MEM="\${TOOL_MAX_MEM:-140M}"\n${FN}\ntool_max_mem "$1"`, 'sh', id],
  { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}

const mb = (s) => {
  const m = /^(\d+)([MG])$/.exec(String(s));
  return m ? Number(m[1]) * (m[2] === 'G' ? 1024 : 1) : NaN;
};

describe('the function is there and runs', () => {
  test('it was lifted out of the script, not invented here', () => {
    expect(FN).toMatch(/^tool_max_mem\(\) \{/);
  });

  test('every answer is a size pm2 understands', () => {
    for (const id of ['T1', 'T2', 'T6', 'T7', 'T10', 'T11']) {
      expect(memFor(id)).toMatch(/^\d+[MG]$/);
    }
  });
});

describe('the tool that was bouncing gets room above where it was measured', () => {
  /*
   * THE ONE THAT WAS BROKEN. 103.4 MB resident under a 140 MB ceiling is not
   * headroom — it is 36 MB, which one scan of 39 tickers spends.
   */
  test('T2 is capped well above the 103 MB it was measured at', () => {
    expect(mb(memFor('T2'))).toBeGreaterThanOrEqual(200);
  });

  test('and above the 140 that was killing it', () => {
    expect(mb(memFor('T2'))).toBeGreaterThan(140);
  });

  test('T7, the only other tool restarting, gets room too', () => {
    expect(mb(memFor('T7'))).toBeGreaterThan(140);
  });
});

describe('the tools that were fine are NOT raised', () => {
  /*
   * A CAP HIGH ENOUGH FOR THE BIGGEST IS NO CAP AT ALL FOR THE SMALLEST. The
   * ceiling exists because this box went unreachable on 2026-09-04 when the
   * kernel's OOM killer took something it needed; raising every tool to T2's
   * number would hand that failure back. The quiet tools restarted 0 times and
   * keep the number that produced that.
   */
  test('a tool with no history of restarting keeps the default', () => {
    expect(memFor('T1')).toBe('140M');
    expect(memFor('T6')).toBe('140M');
    expect(memFor('T10')).toBe('140M');
    expect(memFor('T11')).toBe('140M');
  });

  test('an unknown tool gets the default rather than nothing', () => {
    expect(memFor('T99')).toBe('140M');
  });

  /*
   * AN EMPTY ANSWER IS THE DANGEROUS ONE: `--max-memory-restart ""` is not "no
   * limit", it is a pm2 argument error, and under `set -e` that ends the
   * deploy with the tools half-started.
   */
  test('nothing ever answers empty', () => {
    for (const id of ['T1', 'T2', 'T7', 'T99', '']) {
      expect(memFor(id).length).toBeGreaterThan(0);
    }
  });
});

describe('the box can still be overridden without editing the script', () => {
  test('a per-tool env var wins', () => {
    expect(memFor('T2', { TOOL_MAX_MEM_T2: '512M' })).toBe('512M');
  });

  test('and it only moves the tool it names', () => {
    expect(memFor('T1', { TOOL_MAX_MEM_T2: '512M' })).toBe('140M');
  });

  test('the box-wide default still moves the tools that use it', () => {
    expect(memFor('T1', { TOOL_MAX_MEM: '200M' })).toBe('200M');
  });

  /*
   * AND IT DOES NOT SILENTLY LOWER THE ONE THAT WAS LOOPING. A box-wide
   * default is a statement about ordinary tools; T2 is the tool that proved it
   * is not ordinary, so its own number holds unless it is named.
   */
  test('a box-wide default does not pull T2 back under its peak', () => {
    expect(mb(memFor('T2', { TOOL_MAX_MEM: '140M' }))).toBeGreaterThan(140);
  });
});

describe('the script uses it, rather than the flat number', () => {
  /*
   * The function being right is worth nothing if the pm2 line still passes
   * $TOOL_MAX_MEM. This is the one thing here that CAN only be read from the
   * text, because the pm2 call cannot be run.
   */
  test('the tool start passes the per-tool value', () => {
    expect(SRC).toMatch(/--max-memory-restart "\$\(tool_max_mem "\$id"\)"/);
  });

  test('and no longer passes the flat one to a tool', () => {
    const line = SRC.split('\n').find(l => l.includes('pm2 start src/index.js'));
    expect(line).toBeTruthy();
    const after = SRC.slice(SRC.indexOf(line), SRC.indexOf(line) + 260);
    expect(after).not.toMatch(/--max-memory-restart "\$TOOL_MAX_MEM"/);
  });

  /*
   * THE FUNCTION MUST BE DEFINED BEFORE THE LOOP THAT CALLS IT. In bash a
   * function called before its definition is "command not found" — and under
   * `set -e` that is a dead deploy, not a warning.
   */
  test('it is defined before the loop that calls it', () => {
    expect(SRC.indexOf('tool_max_mem() {'))
      .toBeLessThan(SRC.indexOf('$(tool_max_mem "$id")'));
  });
});

describe('a restart loop is reported, since nothing else reports it', () => {
  /*
   * 292 restarts left no line anywhere. The deploy is the one moment somebody
   * is already reading the output, so it is where the counter gets said out
   * loud — and it must not be fatal, because a tool that restarts is still
   * serving and a deploy that failed over a counter would be the worse tool.
   */
  test('the deploy reads pm2 restart counts', () => {
    expect(SRC).toMatch(/Restart counts/);
    expect(SRC).toMatch(/restart_time/);
  });

  test('it speaks at a low count, not only at a catastrophic one', () => {
    const m = /restart_time\|\|0\)>=(\d+)/.exec(SRC.replace(/\s/g, ''));
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeLessThanOrEqual(5);
  });

  test('it names the memory beside the ceiling, which is what tells the two apart', () => {
    expect(SRC).toMatch(/max_memory_restart/);
  });

  test('and it cannot fail the deploy', () => {
    expect(SRC).toMatch(/could not read pm2/);
  });
});
