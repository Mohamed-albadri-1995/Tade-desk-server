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
    expect(SRC).toMatch(/No tools found in tools\.config\.json/);
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
