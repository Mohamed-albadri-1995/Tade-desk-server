/*
 * The deploy script must read the tool registry AFTER it pulls.
 *
 * tools.config.json is the single list of what to start — id, name, port,
 * scorer port. deploy-tools.sh read it at the top of the file and pulled the
 * branch forty lines later, so every deploy launched the tools described by the
 * PREVIOUS deploy.
 *
 * It surfaced as a rename that would not take: the checkout was at the right
 * commit, `git log` proved it, and the deploy still printed
 *
 *     T5 (52-Week Break) — app :3040
 *     T6 (Overextended)  — app :3050
 *
 * which is exactly what a deploy that had silently failed would look like. A
 * rename is the harmless version. The same ordering would have started the
 * wrong PORTS after a port change, and skipped a newly added tool entirely,
 * while the code on disk was perfectly current.
 *
 * Checked as a property of the script text because there is no way to run a
 * deploy here — and because the failure is an ORDERING, which is exactly the
 * kind of thing that reads as correct in review.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'deploy-tools.sh'), 'utf8');

const at = needle => SRC.indexOf(needle);

describe('deploy-tools.sh reads the registry after the pull', () => {
  test('the script still pulls, and still reads the registry', () => {
    expect(at('git reset --hard "origin/$BRANCH"')).toBeGreaterThan(-1);
    expect(at('mapfile -t TOOLS')).toBeGreaterThan(-1);
    expect(at('tools.config.json')).toBeGreaterThan(-1);
  });

  test('THE PULL COMES FIRST', () => {
    expect(at('git reset --hard "origin/$BRANCH"'))
      .toBeLessThan(at('mapfile -t TOOLS'));
  });

  test('...and the tools are started after both', () => {
    // The loop that launches them reads TOOL_NAME/PORT out of the registry.
    expect(at('mapfile -t TOOLS')).toBeLessThan(at('TOOL_NAME='));
  });

  test('an empty registry still stops the deploy rather than starting nothing', () => {
    expect(SRC).toMatch(/if \[ \$\{#TOOLS\[@\]\} -eq 0 \]/);
    expect(SRC).toMatch(/No ENABLED tools in tools\.config\.json/);
  });

  /*
   * THE FLAG THAT MAKES A FULL DEPLOY SAFE ON A SMALL BOX.
   *
   * Before it, the only ways to run fewer tools were `--only` — per-deploy, and
   * it skips the alerts app — or deleting the registry entry, which loses its
   * ports and its capture times. So a routine `./deploy-tools.sh` silently
   * brought all nine back, which on a 912 MB box is how you end up locked out
   * of your own machine.
   */
  test('only enabled tools are started', () => {
    expect(SRC).toMatch(/x\.enabled !== false/);
  });

  test('ABSENT MEANS ON — an entry written before the flag existed behaves '
    + 'exactly as it did', () => {
    // `!== false`, not `=== true`: a tool with no `enabled` key still runs.
    expect(SRC).not.toMatch(/x\.enabled === true/);
  });

  test('the tools that were NOT started are named, not just counted', () => {
    // "6 enabled" leaves you counting on your fingers to work out which three
    // are missing, on the morning you are wondering why a register is empty.
    expect(SRC).toMatch(/not started:/);
    expect(SRC).toMatch(/archived, still readable/);
  });

  test('a tool with no scorer says so rather than reporting FAIL', () => {
    // A deliberate absence rendered as a fault, on the line you read to decide
    // whether the deploy worked, is the confusion this week has been about.
    expect(SRC).toMatch(/scorer: off \(by config\)/);
  });

  test('the archive is started, or stopped tools take their history with them',
    () => {
      expect(SRC).toMatch(/src\/archive\/server\.js/);
      expect(SRC).toMatch(/x\.archive/);
    });

  /*
   * A DISABLED TOOL MUST STILL BE STOPPED.
   *
   * The stop phase read the same filtered list the start phase does, so the
   * first deploy after disabling a tool skipped it and left it running for
   * ever. Seen on the deploy that shipped the flag:
   *
   *     saving pm2 process list (journal, tool-T8, tool-T1, tool-T2, …)
   *
   * tool-T8 was disabled and still up — and T8 is also archived, so the live
   * process held :3070 and the archive could not bind it. A tool that was
   * meant to be off served live pages while the archive meant to replace it
   * served nothing.
   *
   * Stopping is about what EXISTS. Starting is about what is WANTED.
   */
  test('the stop phase reads EVERY tool, not just the enabled ones', () => {
    const stopAt = SRC.indexOf('Stopping existing PM2 processes');
    const after = SRC.slice(stopAt, stopAt + 2000);
    expect(after).toMatch(/for entry in "\$\{ALL_TOOLS\[@\]\}"/);
    // and the start phase still reads the FILTERED one — measured by position
    // rather than by a fixed window, since the memory ceilings and the swap
    // check sit between the heading and the loop.
    const startAt = SRC.indexOf('Starting tools...');
    const startLoop = SRC.indexOf('for entry in "${TOOLS[@]}"', startAt);
    expect(startLoop).toBeGreaterThan(startAt);
    // ...and it is the START loop, not something later: no other unfiltered
    // loop may sit between the heading and it.
    expect(SRC.slice(startAt, startLoop))
      .not.toMatch(/for entry in "\$\{ALL_TOOLS\[@\]\}"/);
  });

  test('ALL_TOOLS really is unfiltered', () => {
    const m = SRC.match(/mapfile -t ALL_TOOLS < <\(node -e "([\s\S]*?)"\)/);
    expect(m).toBeTruthy();
    expect(m[1]).not.toMatch(/enabled/);
  });

  test('the archive is removed from pm2 BEFORE the port sweep, or pm2 restarts '
    + 'it mid-deploy onto ports the tools are about to claim', () => {
    const del = SRC.indexOf('pm2 delete archive');
    const sweep = SRC.indexOf('lsof -t -i:');
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(sweep);
  });

  /*
   * The registry is read ONCE. Reading it twice — once for the banner, once for
   * the launch — would let the two disagree across a pull, which is the same
   * bug wearing a different shape.
   */
  test('the registry is read exactly once', () => {
    expect(SRC.match(/mapfile -t TOOLS/g)).toHaveLength(1);
  });
});

/*
 * And the registry itself is the thing every side reads, so a rename has to
 * reach all of them from this one file.
 */
describe('the registry is what the tools are named by', () => {
  const registry = require('../tools.config.json').tools;

  test('every tool has the four fields the deploy launches it with', () => {
    for (const t of registry) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.name).toBe('string');
      expect(Number.isFinite(t.port)).toBe(true);
      expect(Number.isFinite(t.scorerPort)).toBe(true);
    }
  });

  test('ids and ports are unique — two tools on one port share a database', () => {
    const ids = registry.map(t => t.id);
    const ports = registry.map(t => t.port).concat(registry.map(t => t.scorerPort));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test('the two renamed tools carry their new names here', () => {
    const by = Object.fromEntries(registry.map(t => [t.id, t.name]));
    expect(by.T5).toBe('20-Day Break');
    expect(by.T6).toBe('Unexplained Move');
  });
});
