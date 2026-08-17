/*
 * What stage a tool is at — and why time alone can never promote one.
 *
 * Nine tools on one landing page all read with the same authority, and they
 * have not earned it equally: two have been judged, several have a fortnight of
 * frozen days and no verdict, and two were rewritten this week. Without the
 * stage on the card, the newest screener's candidates look exactly as
 * trustworthy as the one measured for a year.
 *
 * The rule, and the one thing about it that matters:
 *
 *   under 15 frozen days   collecting — no question to ask yet
 *   15 or more             under study — enough to look at, not to believe
 *   validated              A DECISION, never a day count
 *
 * That last line is the whole design. A tool that promoted itself to
 * "validated" on its fifteenth morning would be asserting that time makes a
 * screener good, which is the belief this whole archive exists to test.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const FILE = path.join(os.tmpdir(), `tool-stages-${process.pid}.json`);
process.env.TOOL_STAGES_FILE = FILE;

const stages = require('../src/stages');

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });
afterAll(() => { try { fs.unlinkSync(FILE); } catch { /* absent */ } });

// ── the default, from the archive ──────────────────────────────────────────

describe('a tool nobody has judged', () => {
  test('under 15 days it is collecting', () => {
    for (const d of [0, 1, 9, 14]) {
      expect(stages.stageOf('T3', d).stage).toBe('collecting');
    }
  });

  test('at 15 days and beyond it is under study', () => {
    for (const d of [15, 34, 400]) {
      expect(stages.stageOf('T3', d).stage).toBe('study');
    }
  });

  /*
   * THE LINE THAT MATTERS. No number of days reaches `valid`, ever. If it did,
   * every tool would validate itself two weeks after being switched on.
   */
  test('NO day count reaches validated', () => {
    for (const d of [15, 100, 1000, 100000]) {
      expect(stages.stageOf('T3', d).stage).not.toBe('valid');
    }
  });

  test('an unknown day count is collecting, not study', () => {
    // Not knowing how much data there is is not evidence that there is enough.
    expect(stages.stageOf('T3', null).stage).toBe('collecting');
    expect(stages.stageOf('T3').stage).toBe('collecting');
  });

  test('and it says the count is what decided it', () => {
    expect(stages.stageOf('T3', 20).source).toBe('days');
  });
});

// ── the judged ones ────────────────────────────────────────────────────────

describe('the two tools that have been judged', () => {
  test('Momentum and CANSLIM are validated in the committed registry', () => {
    expect(stages.declared('T2')).toBe('valid');
    expect(stages.declared('T8')).toBe('valid');
  });

  /*
   * T2 has twelve frozen days — fewer than the fifteen that would make it
   * "under study" — and is still validated. That is the point: the verdict
   * outranks the count, in both directions.
   */
  test('a verdict outranks the day count, even a low one', () => {
    const s = stages.stageOf('T2', 12);
    expect(s.stage).toBe('valid');
    expect(s.source).toBe('declared');
  });

  test('no other tool claims a verdict it has not been given', () => {
    for (const id of ['T1', 'T3', 'T4', 'T5', 'T6', 'T7', 'T9']) {
      expect(stages.declared(id)).toBeNull();
    }
  });
});

// ── moving one by hand ─────────────────────────────────────────────────────

describe('moving a tool between stages', () => {
  test('an override beats both the registry and the count', () => {
    stages.setStage('T2', 'study');           // demote a validated one
    expect(stages.stageOf('T2', 12)).toMatchObject({ stage: 'study', source: 'override' });
    stages.setStage('T3', 'valid');           // promote a collecting one
    expect(stages.stageOf('T3', 2)).toMatchObject({ stage: 'valid', source: 'override' });
  });

  /*
   * `auto` REMOVES the override rather than writing today's answer down. A
   * reset that stored the current stage would freeze the tool at whatever it
   * happened to be on the day it was reset — so "put it back to the rule"
   * would quietly mean "never follow the rule again".
   */
  test('resetting to auto removes the override, it does not record one', () => {
    stages.setStage('T3', 'valid');
    stages.setStage('T3', 'auto');
    expect(stages.stageOf('T3', 2)).toMatchObject({ stage: 'collecting', source: 'days' });
    expect(stages.stageOf('T3', 40)).toMatchObject({ stage: 'study', source: 'days' });
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({});
  });

  test('null and an empty string reset it too', () => {
    for (const v of [null, '', undefined]) {
      stages.setStage('T3', 'valid');
      stages.setStage('T3', v);
      expect(stages.stageOf('T3', 2).source).toBe('days');
    }
  });

  test('an unknown stage is refused rather than stored', () => {
    expect(() => stages.setStage('T3', 'excellent')).toThrow(/unknown stage/);
    expect(stages.stageOf('T3', 2).source).toBe('days');
  });

  test('an unknown tool is refused', () => {
    expect(() => stages.setStage('T42', 'valid')).toThrow(/unknown tool/);
  });

  test('a lower-case tool id still finds the tool', () => {
    expect(stages.setStage('t3', 'valid').stage).toBe('valid');
  });

  /* The file is written by hand as often as by the API. */
  test('an unreadable overrides file means no overrides, not a crash', () => {
    fs.writeFileSync(FILE, 'not json at all');
    expect(stages.stageOf('T3', 2).stage).toBe('collecting');
  });
});

// ── the whole list, as the landing page reads it ───────────────────────────

describe('every tool at once', () => {
  test('each carries its stage, its reason and its day count', () => {
    const all = stages.all({ T1: 34, T2: 12, T3: 9, T5: 1 });
    const by = Object.fromEntries(all.map(t => [t.id, t]));
    expect(by.T1).toMatchObject({ stage: 'study', source: 'days', days: 34 });
    expect(by.T2).toMatchObject({ stage: 'valid', source: 'declared' });
    expect(by.T3).toMatchObject({ stage: 'collecting', source: 'days', days: 9 });
    expect(by.T5).toMatchObject({ stage: 'collecting', source: 'days', days: 1 });
    expect(by.T8).toMatchObject({ stage: 'valid' });
  });

  test('a tool with no day count still appears', () => {
    const all = stages.all({});
    expect(all).toHaveLength(9);
    for (const t of all) expect(stages.STAGES).toContain(t.stage);
  });

  test('every stage carries a label a person can read', () => {
    for (const s of stages.STAGES) expect(stages.LABEL[s]).toBeTruthy();
  });
});
