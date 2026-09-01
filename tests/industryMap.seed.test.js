/*
 * SEEDING THE INDUSTRY MAP FROM THE FROZEN REGISTERS.
 *
 * The map is fed from r0 during a scan, and r0 is an in-memory Map: every
 * deploy restarts nine processes and empties it. A scan run after a restart —
 * or outside the screeners' run window, which is most of the day — therefore
 * records nothing, and the map that group ranking depends on stays empty
 * while the answer is already on disk in R1.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../src/sideA/industryMap.js'), 'utf8');

describe('industryMap.seedFromRegisters', () => {
  test('it exists and is exported', () => {
    expect(src).toContain('function seedFromRegisters');
    expect(src).toMatch(/module\.exports = \{[^}]*seedFromRegisters/);
  });

  test('it reuses record(), so the merge rules cannot drift apart', () => {
    // Two places deciding what "already known" means is how the map starts
    // disagreeing with itself.
    const fn = src.match(/function seedFromRegisters[\s\S]*?\n\}/)[0];
    expect(fn).toContain('record(flat)');
  });

  test('a failure is an answer, never an exception', () => {
    // Same contract as the rest of this file: a group rank that does not
    // appear costs a line on a card; a throw costs the request.
    const fn = src.match(/function seedFromRegisters[\s\S]*?\n\}/)[0];
    expect(fn).toMatch(/catch \(err\)/);
    expect(fn).toMatch(/return \{ added: 0, error/);
  });

  test('the map only ever grows', () => {
    // A name that has not turned up in a scan for a month has not left its
    // industry. Dropping entries would make every group rank jump for reasons
    // that have nothing to do with the groups.
    expect(src).toContain('WHY IT ONLY GROWS');
    expect(src).not.toMatch(/delete symbols\[/);
  });

  test('it is exposed as a POST, because it writes', () => {
    const route = fs.readFileSync(
      path.join(__dirname, '../src/routes/market.js'), 'utf8');
    expect(route).toContain("router.post('/oneil/seed-industries'");
    expect(route).toContain('seedFromRegisters()');
  });
});
